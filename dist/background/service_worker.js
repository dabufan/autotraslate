const DEFAULT_PREFS = {
    targetLang: (navigator.language || 'en').split('-')[0],
    autoTranslate: true,
    siteModes: {},
    provider: {
        type: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
        model: 'deepseek-chat'
    },
    glossary: { pairs: [], protect: [] }
};
// ---- Small helpers ----
function stableHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
}
function keyFor(text, src, dst, providerKey = 'p', glosSig = '') {
    const k = `${providerKey}:${src || 'auto'}:${dst || 'auto'}:${glosSig}:${text}`;
    return stableHash(k);
}
const MULTI_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
    'com.au', 'net.au', 'org.au',
    'co.jp', 'ne.jp', 'or.jp',
    'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ph',
    'co.in', 'co.kr', 'co.za'
]);
function getSite(hostname) {
    if (!hostname)
        return '';
    const rawParts = hostname.split('.').filter(Boolean);
    if (rawParts.length <= 2)
        return hostname;
    const parts = rawParts.map(p => p.toLowerCase());
    for (const suffix of MULTI_PART_SUFFIXES) {
        const suffixParts = suffix.split('.');
        if (parts.length > suffixParts.length) {
            const tail = parts.slice(-suffixParts.length).join('.');
            if (tail === suffix) {
                return rawParts.slice(-(suffixParts.length + 1)).join('.');
            }
        }
    }
    return rawParts.slice(-2).join('.');
}
function detectByHeuristic(sample) {
    const cjk = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
    if (cjk.test(sample))
        return 'zh';
    return 'en';
}
function tabsDetectLanguage(tabId) {
    if (!tabId || !chrome.tabs?.detectLanguage)
        return Promise.resolve(undefined);
    return new Promise((resolve) => {
        try {
            chrome.tabs.detectLanguage(tabId, (lang) => resolve(lang || undefined));
        }
        catch {
            resolve(undefined);
        }
    });
}
// ---- In-memory LRU-ish cache (per SW lifetime) ----
const memoryCache = new Map();
const MEM_CAP = 5000;
function trimMemCache() {
    while (memoryCache.size > MEM_CAP) {
        const firstKey = memoryCache.keys().next().value;
        if (!firstKey)
            break;
        memoryCache.delete(firstKey);
    }
}
// ---- IndexedDB persistent KV cache ----
const DB_NAME = 'autotrans';
const DB_VERSION = 1;
const STORE = 'kv'; // { k: string, v: string, t?: number }
function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'k' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbGetMany(keys) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const out = new Array(keys.length);
        let remaining = keys.length;
        keys.forEach((k, i) => {
            const r = store.get(k);
            r.onsuccess = () => {
                out[i] = r.result?.v;
                if (--remaining === 0)
                    resolve(out);
            };
            r.onerror = () => {
                out[i] = undefined;
                if (--remaining === 0)
                    resolve(out);
            };
        });
    });
}
async function idbPutMany(entries) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        entries.forEach(e => store.put({ k: e.k, v: e.v, t: Date.now() }));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
// ---- Prefs ----
async function getPrefs() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['prefs'], (res) => resolve(res?.prefs || DEFAULT_PREFS));
    });
}
async function setSitePref(site, mode) {
    const prefs = await getPrefs();
    prefs.siteModes = prefs.siteModes || {};
    prefs.siteModes[site] = mode;
    await new Promise((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
}
// ---- Providers ----
class DeepSeekTranslator {
    constructor(baseUrl, apiKey, model, glossary) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiKey = (apiKey || '').trim();
        this.model = model || 'deepseek-chat';
        this.glossary = glossary || { pairs: [], protect: [] };
        this.glosSig = stableHash(JSON.stringify(this.glossary));
    }
    buildSystemPrompt(target, source) {
        const parts = [];
        parts.push(`You are a professional translation engine.`);
        parts.push(`Translate the user's text into target language (${target}).`);
        parts.push(source ? `The source language is ${source}.` : `Detect the source language automatically.`);
        if (this.glossary?.protect?.length) {
            parts.push(`Do NOT translate these protected terms (preserve exact casing and spelling): ${this.glossary.protect.join(', ')}`);
        }
        if (this.glossary?.pairs?.length) {
            const pairsDesc = this.glossary.pairs.map(p => `"${p.src}" -> "${p.tgt}"`).join('; ');
            parts.push(`Glossary mappings (enforce exact output for matched source terms): ${pairsDesc}`);
        }
        parts.push(`Preserve punctuation, numbers, inline code, and URLs. Do not add explanations or quotes.`);
        return parts.join(' ');
    }
    mask(texts) {
        const terms = (this.glossary?.protect || []).filter(Boolean).sort((a, b) => b.length - a.length);
        if (!terms.length)
            return { masked: texts, maps: [] };
        const maps = [];
        const masked = texts.map((t, idx) => {
            let out = t;
            const m = [];
            terms.forEach((term, j) => {
                if (!term)
                    return;
                const token = `§§P${j}§§`; // unlikely to appear naturally
                const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                if (re.test(out)) {
                    out = out.replace(re, token);
                    m.push({ token, term });
                }
            });
            maps[idx] = m;
            return out;
        });
        return { masked, maps };
    }
    unmask(texts, maps) {
        if (!maps.length)
            return texts;
        return texts.map((t, i) => {
            let out = t;
            for (const m of maps[i] || []) {
                const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                out = out.replace(re, m.term);
            }
            return out;
        });
    }
    async translateBatch(texts, target, source) {
        if (!this.apiKey) {
            console.warn('DeepSeek API key missing, skip translation batch.');
            return texts;
        }
        // memory + idb cache lookup
        const keys = texts.map(t => keyFor((t || '').trim(), source, target, 'ds:' + this.model, this.glosSig));
        const memHits = keys.map(k => memoryCache.get(k));
        const needIdxs = [];
        for (let i = 0; i < keys.length; i++)
            if (!memHits[i])
                needIdxs.push(i);
        let idbHits = [];
        if (needIdxs.length) {
            const idbKeys = needIdxs.map(i => keys[i]);
            const vals = await idbGetMany(idbKeys);
            idbHits = new Array(keys.length);
            needIdxs.forEach((i, j) => { idbHits[i] = vals[j]; if (vals[j])
                memoryCache.set(keys[i], vals[j]); });
        }
        const out = new Array(texts.length);
        for (let i = 0; i < texts.length; i++) {
            out[i] = memHits[i] || idbHits[i] || '';
        }
        // build list to translate
        const toTranslate = [];
        for (let i = 0; i < texts.length; i++) {
            const t = (texts[i] ?? '').trim();
            if (!t) {
                out[i] = t;
                continue;
            }
            if (!out[i])
                toTranslate.push({ index: i, text: t });
        }
        if (!toTranslate.length)
            return out;
        // mask protect terms
        const { masked, maps } = this.mask(toTranslate.map(x => x.text));
        // chunking
        const MAX_CHARS = 6000;
        let start = 0;
        const toPersist = [];
        while (start < masked.length) {
            let end = start, sum = 0;
            while (end < masked.length && (sum + masked[end].length) <= MAX_CHARS) {
                sum += masked[end].length;
                end++;
            }
            const slice = masked.slice(start, end);
            const sys = this.buildSystemPrompt(target, source);
            const userPayload = { target, source: source || 'auto', texts: slice };
            const body = {
                model: this.model,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: JSON.stringify(userPayload) }
                ],
                temperature: 0.2,
                stream: false,
                response_format: { type: 'json_object' }
            };
            let translations = null;
            let authError = false;
            try {
                const resp = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                    body: JSON.stringify(body)
                });
                if (resp.status === 401 || resp.status === 403)
                    authError = true;
                if (!resp.ok)
                    throw new Error(`DeepSeek HTTP ${resp.status}`);
                const data = await resp.json();
                const content = data?.choices?.[0]?.message?.content;
                let arr = null;
                try {
                    const obj = JSON.parse(content);
                    if (obj && Array.isArray(obj.t))
                        arr = obj.t;
                    else if (Array.isArray(obj))
                        arr = obj;
                    else if (obj && Array.isArray(obj.translations))
                        arr = obj.translations;
                }
                catch {
                    const match = content && content.match(/\[\s*"(?:[^"\\]|\\.)*"\s*(?:,\s*"(?:[^"\\]|\\.)*"\s*)*\]/s);
                    if (match) {
                        try {
                            arr = JSON.parse(match[0]);
                        }
                        catch { }
                    }
                }
                if (arr && Array.isArray(arr))
                    translations = arr.map((x) => typeof x === 'string' ? x : '');
            }
            catch (e) {
                console.warn('DeepSeek batch translate error', e);
            }
            if (!translations) {
                if (authError) {
                    for (let j = 0; j < slice.length; j++) {
                        const targetIndex = toTranslate[start + j].index;
                        const srcText = toTranslate[start + j].text;
                        out[targetIndex] = srcText;
                    }
                    start = end;
                    continue;
                }
                // fallback per item
                translations = [];
                for (const s of slice)
                    translations.push(await this.translateOne(s, target, source));
            }
            // unmask + assign
            const unmasked = this.unmask(translations, maps.slice(start, end));
            for (let j = 0; j < unmasked.length; j++) {
                const targetIndex = toTranslate[start + j].index;
                const srcText = toTranslate[start + j].text;
                const tr = unmasked[j] || srcText;
                out[targetIndex] = tr;
                const k = keys[targetIndex];
                memoryCache.set(k, tr);
                toPersist.push({ k, v: tr });
            }
            trimMemCache();
            start = end;
        }
        // persist to idb
        if (toPersist.length)
            await idbPutMany(toPersist);
        return out;
    }
    async translateOne(text, target, source) {
        if (!this.apiKey)
            return text;
        const sys = this.buildSystemPrompt(target, source);
        const body = {
            model: this.model,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: text }
            ],
            temperature: 0.2,
            stream: false
        };
        try {
            const resp = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                body: JSON.stringify(body)
            });
            if (!resp.ok)
                throw new Error(`DeepSeek HTTP ${resp.status}`);
            const data = await resp.json();
            const out = data?.choices?.[0]?.message?.content ?? text;
            return out;
        }
        catch (e) {
            console.warn('DeepSeek translate error', e);
            return text;
        }
    }
}
class LibreTranslator {
    constructor(baseUrl, apiKey, glossary) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiKey = apiKey;
        this.glossary = glossary || { pairs: [], protect: [] };
        this.glosSig = stableHash(JSON.stringify(this.glossary));
    }
    mask(texts) {
        const terms = (this.glossary?.protect || []).filter(Boolean).sort((a, b) => b.length - a.length);
        if (!terms.length)
            return { masked: texts, maps: [] };
        const maps = [];
        const masked = texts.map((t, idx) => {
            let out = t;
            const m = [];
            terms.forEach((term, j) => {
                const token = `§§P${j}§§`;
                const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                if (re.test(out)) {
                    out = out.replace(re, token);
                    m.push({ token, term });
                }
            });
            maps[idx] = m;
            return out;
        });
        return { masked, maps };
    }
    unmask(texts, maps) {
        if (!maps.length)
            return texts;
        return texts.map((t, i) => {
            let out = t;
            for (const m of maps[i] || []) {
                const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                out = out.replace(re, m.term);
            }
            return out;
        });
    }
    async translateBatch(texts, target, source) {
        const out = new Array(texts.length);
        const { masked, maps } = this.mask(texts);
        for (let i = 0; i < masked.length; i++) {
            const t = masked[i];
            if (!t?.trim()) {
                out[i] = t;
                continue;
            }
            try {
                const resp = await fetch(`${this.baseUrl}/translate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ q: t, source: source || 'auto', target, format: 'text', api_key: this.apiKey || undefined })
                });
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                out[i] = data.translatedText || t;
            }
            catch (e) {
                console.warn('Libre translate error', e);
                out[i] = t;
            }
        }
        return this.unmask(out, maps);
    }
}
async function chooseProvider() {
    const prefs = await getPrefs();
    const glossary = prefs.glossary || { pairs: [], protect: [] };
    const glosSig = stableHash(JSON.stringify(glossary));
    if (prefs.provider?.type === 'deepseek') {
        const p = prefs.provider;
        const apiKey = (p.apiKey || '').trim();
        if (!apiKey) {
            console.warn('DeepSeek provider selected but API key is empty. Falling back to LibreTranslate.');
            const fallback = new LibreTranslator('https://libretranslate.com', undefined, glossary);
            return { translateBatch: fallback.translateBatch.bind(fallback), providerKey: 'lb', glosSig };
        }
        const inst = new DeepSeekTranslator(p.baseUrl, apiKey, p.model || 'deepseek-chat', glossary);
        return { translateBatch: inst.translateBatch.bind(inst), providerKey: 'ds:' + p.model, glosSig };
    }
    else {
        const p = prefs.provider;
        const inst = new LibreTranslator(p.baseUrl || 'https://libretranslate.com', p.apiKey, glossary);
        return { translateBatch: inst.translateBatch.bind(inst), providerKey: 'lb', glosSig };
    }
}
// ---- Decision logic ----
async function shouldTranslate(url, fallbackDocLang, tabId) {
    const prefs = await getPrefs();
    const u = new URL(url);
    const site = getSite(u.hostname);
    const mode = prefs.siteModes?.[site] || 'auto';
    if (mode === 'never')
        return { ok: false, targetLang: prefs.targetLang, mode, reason: 'site-never' };
    if (mode === 'always')
        return { ok: true, targetLang: prefs.targetLang, mode, reason: 'site-always' };
    if (!prefs.autoTranslate)
        return { ok: false, targetLang: prefs.targetLang, mode, reason: 'auto-off' };
    let pageLang = undefined;
    try {
        pageLang = await tabsDetectLanguage(tabId);
    }
    catch { }
    if (!pageLang)
        pageLang = fallbackDocLang;
    if (!pageLang)
        pageLang = detectByHeuristic(u.pathname + ' ' + u.hostname);
    if (!pageLang)
        pageLang = 'en';
    const target = (prefs.targetLang || 'en').split('-')[0];
    const source = (pageLang || 'en').split('-')[0];
    if (target === source)
        return { ok: false, targetLang: target, sourceLang: source, mode, reason: 'same-lang' };
    return { ok: true, targetLang: target, sourceLang: source, mode, reason: 'diff-lang' };
}
// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg.type === 'GET_PREFS') {
            const prefs = await getPrefs();
            sendResponse({ ok: true, prefs });
            return;
        }
        if (msg.type === 'SET_SITE_PREF') {
            await setSitePref(msg.site, msg.mode);
            sendResponse({ ok: true });
            return;
        }
        if (msg.type === 'INIT') {
            const decision = await shouldTranslate(msg.url, msg.docLang, sender.tab?.id);
            sendResponse({ ok: true, decision });
            return;
        }
        if (msg.type === 'TRANSLATE_BATCH') {
            const { translateBatch } = await chooseProvider();
            const out = await translateBatch(msg.texts, msg.targetLang, msg.sourceLang);
            sendResponse({ ok: true, result: out });
            return;
        }
        if (msg.type === 'METRIC') {
            sendResponse({ ok: true });
            return;
        }
    })();
    return true;
});
chrome.commands?.onCommand?.addListener(async (cmd) => {
    if (cmd !== 'toggle-translation')
        return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id)
        return;
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATION' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('toggle-translation command dispatch failed', chrome.runtime.lastError);
        }
    });
});
// ---- Context Menus (hot glossary add) ----
chrome.runtime.onInstalled?.addListener(() => {
    try {
        chrome.contextMenus.create({ id: 'autotrans_add_protect', title: '加入不翻译词（选中文本）', contexts: ['selection'] });
        chrome.contextMenus.create({ id: 'autotrans_add_pair', title: '加入术语表（源语=目标）', contexts: ['selection'] });
    }
    catch { }
});
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
    if (!tab?.id)
        return;
    const selection = (info.selectionText || '').trim();
    if (!selection)
        return;
    const prefs = await getPrefs();
    if (info.menuItemId === 'autotrans_add_protect') {
        const set = new Set([...(prefs.glossary?.protect || [])]);
        set.add(selection);
        prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
        prefs.glossary.protect = Array.from(set);
        await new Promise((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
        chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: `已加入不翻译词：${selection}` });
        return;
    }
    if (info.menuItemId === 'autotrans_add_pair') {
        // Ask for target translation via page prompt to avoid extension UI
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel) => {
                // run in page world
                try {
                    return prompt('请输入“术语翻译”的目标文本：', sel) || '';
                }
                catch {
                    return '';
                }
            },
            args: [selection]
        });
        const tgt = (result || '').trim();
        if (!tgt) {
            chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: '已取消添加术语' });
            return;
        }
        const pairs = (prefs.glossary?.pairs || []).filter(p => p.src !== selection);
        pairs.push({ src: selection, tgt });
        prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
        prefs.glossary.pairs = pairs;
        await new Promise((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
        chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: `已加入术语：${selection} → ${tgt}` });
    }
});
export {};
