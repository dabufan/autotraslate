export {};

// AutoTranslate MVP - MV3 service worker
// Enhancements: IndexedDB persistent cache + Glossary (pairs & protect terms) + DeepSeek JSON batch + tabs.detectLanguage

type Message =
  | { type: 'INIT'; url: string; docLang?: string; site?: string }
  | { type: 'TRANSLATE_BATCH'; texts: string[]; targetLang: string; sourceLang?: string }
  | { type: 'GET_PREFS'; site?: string }
  | { type: 'SET_SITE_PREF'; site: string; mode: 'always'|'never'|'auto' }
  | { type: 'METRIC'; name: string; value: number };

type DeepSeekProvider = {
  type: 'deepseek';
  baseUrl: string;
  apiKey: string;
  model: string;
};
type QwenProvider = {
  type: 'qwen';
  baseUrl: string;
  apiKey: string;
  model: string;
};

type LibreProvider = {
  type: 'libre';
  baseUrl: string;
  apiKey?: string;
};

type Glossary = {
  pairs: { src: string; tgt: string }[];
  protect: string[]; // do-not-translate terms
};

type Prefs = {
  targetLang: string;
  autoTranslate: boolean;
  siteModes: Record<string, 'always'|'never'|'auto'>;
  provider: DeepSeekProvider | LibreProvider | QwenProvider;
  glossary: Glossary;
};

const DEFAULT_PREFS: Prefs = {
  targetLang: (navigator.language || 'en').split('-')[0],
  autoTranslate: true,
  siteModes: {},
  provider: {
    type: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: '',
    model: 'qwen-turbo'
  },
  glossary: { pairs: [], protect: [] }
};

// ---- Small helpers ----
function stableHash(s: string): string {
  let h = 0;
  for (let i=0;i<s.length;i++) { h = (h*31 + s.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}
function keyFor(text: string, src?: string, dst?: string, providerKey: string = 'p', glosSig: string = ''): string {
  const k = `${providerKey}:${src||'auto'}:${dst||'auto'}:${glosSig}:${text}`;
  return stableHash(k);
}

function normalizeLLMText(raw: string): string {
  if (!raw) return '';
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  if (/^json\b/i.test(s)) {
    s = s.replace(/^json\b[:\s]*/i, '').trim();
  }
  // remove leading & trailing quotes if wrapped accidentally
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function extractStrings(val: any): string[] | null {
  if (!val) return null;
  const out: string[] = [];
  const push = (v: any) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v.text === 'string') out.push(v.text);
    else if (v && typeof v.content === 'string') out.push(v.content);
  };
  if (Array.isArray(val)) {
    val.forEach(push);
  } else if (Array.isArray(val.t)) {
    val.t.forEach(push);
  } else if (Array.isArray(val.translations)) {
    val.translations.forEach(push);
  } else if (Array.isArray(val.data)) {
    val.data.forEach(push);
  } else {
    return null;
  }
  return out.length ? out.map(normalizeLLMText) : null;
}

function parseLLMArray(raw: string): string[] | null {
  if (!raw) return null;
  const attempts: string[] = [];
  const normalized = normalizeLLMText(raw);
  if (normalized) attempts.push(normalized);
  const braceMatch = normalized.match(/\{[\s\S]*\}/);
  if (braceMatch) attempts.push(braceMatch[0]);
  const arrayMatch = normalized.match(/\[[\s\S]*\]/);
  if (arrayMatch) attempts.push(arrayMatch[0]);
  for (const cand of attempts) {
    try {
      const parsed = JSON.parse(cand);
      const arr = extractStrings(parsed);
      if (arr) return arr;
    } catch {
      continue;
    }
  }
  return null;
}
const MULTI_PART_SUFFIXES = new Set([
  'co.uk','org.uk','gov.uk','ac.uk',
  'com.au','net.au','org.au',
  'co.jp','ne.jp','or.jp',
  'com.br','com.cn','com.hk','com.sg','com.tw','com.tr','com.mx','com.ar','com.co','com.pe','com.ph',
  'co.in','co.kr','co.za'
]);

function getSite(hostname?: string) {
  if (!hostname) return '';
  const rawParts = hostname.split('.').filter(Boolean);
  if (rawParts.length <= 2) return hostname;
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
function detectByHeuristic(sample: string): string | undefined {
  const cjk = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
  if (cjk.test(sample)) return 'zh';
  return 'en';
}
function tabsDetectLanguage(tabId?: number): Promise<string | undefined> {
  if (!tabId || !chrome.tabs?.detectLanguage) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      chrome.tabs.detectLanguage(tabId, (lang) => resolve(lang || undefined));
    } catch { resolve(undefined); }
  });
}

// ---- In-memory LRU-ish cache (per SW lifetime) ----
const memoryCache = new Map<string,string>();
const MEM_CAP = 5000;
function trimMemCache() {
  while (memoryCache.size > MEM_CAP) {
    const firstKey = memoryCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    memoryCache.delete(firstKey);
  }
}

// ---- IndexedDB persistent KV cache ----
const DB_NAME = 'autotrans';
const DB_VERSION = 1;
const STORE = 'kv'; // { k: string, v: string, t?: number }

function idbOpen(): Promise<IDBDatabase> {
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
async function idbGetMany(keys: string[]): Promise<(string|undefined)[]> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const out: (string|undefined)[] = new Array(keys.length);
    let remaining = keys.length;
    keys.forEach((k, i) => {
      const r = store.get(k);
      r.onsuccess = () => {
        out[i] = r.result?.v;
        if (--remaining === 0) resolve(out);
      };
      r.onerror = () => {
        out[i] = undefined;
        if (--remaining === 0) resolve(out);
      };
    });
  });
}
async function idbPutMany(entries: {k:string, v:string}[]): Promise<void> {
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
async function getPrefs(): Promise<Prefs> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['prefs'], (res) => resolve((res?.prefs as Prefs) || DEFAULT_PREFS));
  });
}
async function setSitePref(site: string, mode: 'always'|'never'|'auto') {
  const prefs = await getPrefs();
  prefs.siteModes = prefs.siteModes || {};
  prefs.siteModes[site] = mode;
  await new Promise<void>((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
}

// ---- Providers ----
class DeepSeekTranslator {
  baseUrl: string;
  apiKey: string;
  model: string;
  glosSig: string;
  glossary: Glossary;
  constructor(baseUrl: string, apiKey: string, model: string, glossary: Glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = (apiKey || '').trim();
    this.model = model || 'deepseek-chat';
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }

  private buildSystemPrompt(target: string, source?: string) {
    const parts: string[] = [];
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

  private mask(texts: string[]) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a,b)=>b.length-a.length);
    if (!terms.length) return { masked: texts, maps: [] as {token:string, term:string}[][] };
    const maps: {token:string, term:string}[][] = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m: {token:string, term:string}[] = [];
      terms.forEach((term, j) => {
        if (!term) return;
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
  private unmask(texts: string[], maps: {token:string, term:string}[][]) {
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        out = out.replace(re, m.term);
      }
      return out;
    });
  }

  async translateBatch(texts: string[], target: string, source?: string): Promise<string[]> {
    if (!this.apiKey) {
      console.warn('DeepSeek API key missing, skip translation batch.');
      return texts;
    }
    // memory + idb cache lookup
    const keys = texts.map(t => keyFor((t||'').trim(), source, target, 'ds:'+this.model, this.glosSig));
    const memHits = keys.map(k => memoryCache.get(k));
    const needIdxs: number[] = [];
    for (let i=0;i<keys.length;i++) if (!memHits[i]) needIdxs.push(i);

    let idbHits: (string|undefined)[] = [];
    if (needIdxs.length) {
      const idbKeys = needIdxs.map(i => keys[i]);
      const vals = await idbGetMany(idbKeys);
      idbHits = new Array(keys.length);
      needIdxs.forEach((i, j) => { idbHits[i] = vals[j]; if (vals[j]) memoryCache.set(keys[i], vals[j]!); });
    }

    const out = new Array<string>(texts.length);
    for (let i=0;i<texts.length;i++) {
      out[i] = memHits[i] || idbHits[i] || '';
    }

    // build list to translate
    const toTranslate: { index:number, text:string }[] = [];
    for (let i=0;i<texts.length;i++) {
      const t = (texts[i] ?? '').trim();
      if (!t) { out[i] = t; continue; }
      if (!out[i]) toTranslate.push({ index:i, text:t });
    }
    if (!toTranslate.length) return out;

    // mask protect terms
    const { masked, maps } = this.mask(toTranslate.map(x => x.text));

    // chunking
    const MAX_CHARS = 6000;
    let start = 0;
    const toPersist: {k:string, v:string}[] = [];
    while (start < masked.length) {
      let end = start, sum = 0;
      while (end < masked.length && (sum + masked[end].length) <= MAX_CHARS) { sum += masked[end].length; end++; }
      const slice = masked.slice(start, end);
      const sys = this.buildSystemPrompt(target, source);
      const userPayload = { target, source: source || 'auto', texts: slice };
      const body: any = {
        model: this.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(userPayload) }
        ],
        temperature: 0.2,
        stream: false,
        response_format: { type: 'json_object' }
      };
      let translations: string[] | null = null;
      let authError = false;
      try {
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
          body: JSON.stringify(body)
        });
        if (resp.status === 401 || resp.status === 403) authError = true;
        if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}`);
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        const arr = parseLLMArray(typeof content === 'string' ? content : JSON.stringify(content));
        if (arr) translations = arr;
      } catch (e) {
        console.warn('DeepSeek batch translate error', e);
      }
      if (!translations) {
        if (authError) {
          for (let j=0;j<slice.length;j++) {
            const targetIndex = toTranslate[start + j].index;
            const srcText = toTranslate[start + j].text;
            out[targetIndex] = srcText;
          }
          start = end;
          continue;
        }
        // fallback per item
        translations = [];
        for (const s of slice) translations.push(await this.translateOne(s, target, source));
      }

      // unmask + assign
      const unmasked = this.unmask(translations, maps.slice(start, end));
      for (let j=0;j<unmasked.length;j++) {
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
    if (toPersist.length) await idbPutMany(toPersist);
    return out;
  }

  private async translateOne(text: string, target: string, source?: string): Promise<string> {
    if (!this.apiKey) return text;
    const sys = this.buildSystemPrompt(target, source);
    const body: any = {
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
      if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}`);
      const data = await resp.json();
      const out = data?.choices?.[0]?.message?.content;
      if (out) {
        if (typeof out === 'string') {
          const arr = parseLLMArray(out);
          if (arr?.length) return arr[0];
          const cleaned = normalizeLLMText(out);
          if (cleaned) return cleaned;
        } else {
          const str = JSON.stringify(out);
          const arr = parseLLMArray(str);
          if (arr?.length) return arr[0];
        }
      }
      return text;
    } catch (e) {
      console.warn('DeepSeek translate error', e);
      return text;
    }
  }
}

class QwenTranslator {
  baseUrl: string;
  apiKey: string;
  model: string;
  glosSig: string;
  glossary: Glossary;
  constructor(baseUrl: string, apiKey: string, model: string, glossary: Glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = (apiKey || '').trim();
    this.model = model || 'qwen-turbo';
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }

  private buildSystemPrompt(target: string, source?: string) {
    const parts: string[] = [];
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
    parts.push(`Return a JSON object with key "t" containing an array of translated strings in the same order as input texts.`);
    return parts.join(' ');
  }

  private mask(texts: string[]) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a,b)=>b.length-a.length);
    if (!terms.length) return { masked: texts, maps: [] as {token:string, term:string}[][] };
    const maps: {token:string, term:string}[][] = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m: {token:string, term:string}[] = [];
      terms.forEach((term, j) => {
        if (!term) return;
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
  private unmask(texts: string[], maps: {token:string, term:string}[][]) {
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        out = out.replace(re, m.term);
      }
      return out;
    });
  }

  private endpoint(): string {
    return `${this.baseUrl}/api/v1/services/aigc/text-generation/generation`;
  }

  async translateBatch(texts: string[], target: string, source?: string): Promise<string[]> {
    if (!this.apiKey) {
      console.warn('Qwen API key missing, skip translation batch.');
      return texts;
    }
    const keys = texts.map(t => keyFor((t||'').trim(), source, target, 'qw:'+this.model, this.glosSig));
    const memHits = keys.map(k => memoryCache.get(k));
    const needIdxs: number[] = [];
    for (let i=0;i<keys.length;i++) if (!memHits[i]) needIdxs.push(i);

    let idbHits: (string|undefined)[] = [];
    if (needIdxs.length) {
      const idbKeys = needIdxs.map(i => keys[i]);
      const vals = await idbGetMany(idbKeys);
      idbHits = new Array(keys.length);
      needIdxs.forEach((i, j) => { idbHits[i] = vals[j]; if (vals[j]) memoryCache.set(keys[i], vals[j]!); });
    }

    const out = new Array<string>(texts.length);
    for (let i=0;i<texts.length;i++) {
      out[i] = memHits[i] || idbHits[i] || '';
    }

    const toTranslate: { index:number, text:string }[] = [];
    for (let i=0;i<texts.length;i++) {
      const t = (texts[i] ?? '').trim();
      if (!t) { out[i] = t; continue; }
      if (!out[i]) toTranslate.push({ index:i, text:t });
    }
    if (!toTranslate.length) return out;

    const { masked, maps } = this.mask(toTranslate.map(x => x.text));

    const MAX_CHARS = 6000;
    let start = 0;
    const toPersist: {k:string, v:string}[] = [];
    while (start < masked.length) {
      let end = start, sum = 0;
      while (end < masked.length && (sum + masked[end].length) <= MAX_CHARS) { sum += masked[end].length; end++; }
      const slice = masked.slice(start, end);
      const sys = this.buildSystemPrompt(target, source);
      const userPayload = { target, source: source || 'auto', texts: slice };
      const body: any = {
        model: this.model,
        input: {
          messages: [
            { role: 'system', content: [{ text: sys }] },
            { role: 'user', content: [{ text: JSON.stringify(userPayload) }] }
          ]
        },
        parameters: {
          result_format: 'json'
        }
      };
      let translations: string[] | null = null;
      let authError = false;
      try {
        const resp = await fetch(this.endpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
          body: JSON.stringify(body)
        });
        if (resp.status === 401 || resp.status === 403) authError = true;
        if (!resp.ok) throw new Error(`Qwen HTTP ${resp.status}`);
        const data = await resp.json();
        const messageContent = data?.output?.choices?.[0]?.message?.content;
        let textBlob = '';
        if (Array.isArray(messageContent)) {
          textBlob = messageContent.map((item: any) => {
            if (typeof item === 'string') return item;
            if (item?.text) return item.text;
            return '';
          }).join('').trim();
        } else if (typeof messageContent === 'string') {
          textBlob = messageContent;
        } else if (messageContent?.text) {
          textBlob = messageContent.text;
        } else if (typeof data?.output?.text === 'string') {
          textBlob = data.output.text;
        }
        const arr = parseLLMArray(textBlob);
        if (arr) translations = arr;
      } catch (e) {
        console.warn('Qwen batch translate error', e);
      }
      if (!translations) {
        if (authError) {
          for (let j=0;j<slice.length;j++) {
            const targetIndex = toTranslate[start + j].index;
            const srcText = toTranslate[start + j].text;
            out[targetIndex] = srcText;
          }
          start = end;
          continue;
        }
        translations = [];
        for (const s of slice) translations.push(await this.translateOne(s, target, source));
      }

      const unmasked = this.unmask(translations, maps.slice(start, end));
      for (let j=0;j<unmasked.length;j++) {
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

    if (toPersist.length) await idbPutMany(toPersist);
    return out;
  }

  private async translateOne(text: string, target: string, source?: string): Promise<string> {
    if (!this.apiKey) return text;
    const sys = this.buildSystemPrompt(target, source);
    const body: any = {
      model: this.model,
      input: {
        messages: [
          { role: 'system', content: [{ text: sys }] },
          { role: 'user', content: [{ text }] }
        ]
      }
    };
    try {
      const resp = await fetch(this.endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`Qwen HTTP ${resp.status}`);
      const data = await resp.json();
      const messageContent = data?.output?.choices?.[0]?.message?.content;
      if (Array.isArray(messageContent)) {
        const combined = messageContent.map((part:any)=> typeof part === 'string' ? part : part?.text || '').join('').trim();
        const arr = parseLLMArray(combined);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(combined);
        if (cleaned) return cleaned;
        return combined || text;
      }
      if (typeof messageContent === 'string') {
        const arr = parseLLMArray(messageContent);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(messageContent);
        if (cleaned) return cleaned;
        return messageContent || text;
      }
      if (messageContent?.text) {
        const arr = parseLLMArray(messageContent.text);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(messageContent.text);
        if (cleaned) return cleaned;
        return messageContent.text || text;
      }
      if (typeof data?.output?.text === 'string') {
        const arr = parseLLMArray(data.output.text);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(data.output.text);
        if (cleaned) return cleaned;
        return data.output.text || text;
      }
      return text;
    } catch (e) {
      console.warn('Qwen translate error', e);
      return text;
    }
  }
}

class LibreTranslator {
  baseUrl: string;
  apiKey?: string;
  glosSig: string;
  glossary: Glossary;
  constructor(baseUrl: string, apiKey?: string, glossary?: Glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }
  private mask(texts: string[]) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a,b)=>b.length-a.length);
    if (!terms.length) return { masked: texts, maps: [] as {token:string, term:string}[][] };
    const maps: {token:string, term:string}[][] = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m: {token:string, term:string}[] = [];
      terms.forEach((term, j) => {
        const token = `§§P${j}§§`;
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (re.test(out)) { out = out.replace(re, token); m.push({ token, term }); }
      });
      maps[idx] = m;
      return out;
    });
    return { masked, maps };
  }
  private unmask(texts: string[], maps: {token:string, term:string}[][]) {
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        out = out.replace(re, m.term);
      }
      return out;
    });
  }
  async translateBatch(texts: string[], target: string, source?: string): Promise<string[]> {
    const out: string[] = new Array(texts.length);
    const { masked, maps } = this.mask(texts);
    for (let i=0;i<masked.length;i++) {
      const t = masked[i];
      if (!t?.trim()) { out[i] = t; continue; }
      try {
        const resp = await fetch(`${this.baseUrl}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: t, source: source || 'auto', target, format: 'text', api_key: this.apiKey || undefined })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        out[i] = data.translatedText || t;
      } catch (e) {
        console.warn('Libre translate error', e);
        out[i] = t;
      }
    }
    return this.unmask(out, maps);
  }
}

async function chooseProvider(): Promise<{translateBatch: (texts:string[], target:string, source?:string)=>Promise<string[]>, providerKey:string, glosSig:string}> {
  const prefs = await getPrefs();
  const glossary = prefs.glossary || { pairs: [], protect: [] };
  const glosSig = stableHash(JSON.stringify(glossary));
  if (prefs.provider?.type === 'qwen') {
    const p = prefs.provider as QwenProvider;
    const apiKey = (p.apiKey || '').trim();
    if (!apiKey) {
      console.warn('Qwen provider selected but API key is empty. Falling back to LibreTranslate.');
      const fallback = new LibreTranslator('https://libretranslate.com', undefined, glossary);
      return { translateBatch: fallback.translateBatch.bind(fallback), providerKey: 'lb', glosSig };
    }
    const inst = new QwenTranslator(p.baseUrl || 'https://dashscope.aliyuncs.com', apiKey, p.model || 'qwen-turbo', glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: 'qw:'+p.model, glosSig };
  } else if (prefs.provider?.type === 'deepseek') {
    const p = prefs.provider as DeepSeekProvider;
    const apiKey = (p.apiKey || '').trim();
    if (!apiKey) {
      console.warn('DeepSeek provider selected but API key is empty. Falling back to LibreTranslate.');
      const fallback = new LibreTranslator('https://libretranslate.com', undefined, glossary);
      return { translateBatch: fallback.translateBatch.bind(fallback), providerKey: 'lb', glosSig };
    }
    const inst = new DeepSeekTranslator(p.baseUrl, apiKey, p.model || 'deepseek-chat', glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: 'ds:'+p.model, glosSig };
  } else {
    const p = prefs.provider as LibreProvider;
    const inst = new LibreTranslator(p.baseUrl || 'https://libretranslate.com', p.apiKey, glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: 'lb', glosSig };
  }
}

// ---- Decision logic ----
async function shouldTranslate(url: string, fallbackDocLang?: string, tabId?: number): Promise<{ok:boolean, targetLang:string, sourceLang?:string, reason?:string, mode:'always'|'never'|'auto'}> {
  const prefs = await getPrefs();
  const u = new URL(url);
  const site = getSite(u.hostname);
  const mode = prefs.siteModes?.[site] || 'auto';
  if (mode === 'never') return { ok:false, targetLang: prefs.targetLang, mode, reason: 'site-never' };
  if (mode === 'always') return { ok:true, targetLang: prefs.targetLang, mode, reason: 'site-always' };
  if (!prefs.autoTranslate) return { ok:false, targetLang: prefs.targetLang, mode, reason: 'auto-off' };

  let pageLang: string | undefined = undefined;
  try { pageLang = await tabsDetectLanguage(tabId); } catch {}
  if (!pageLang) pageLang = fallbackDocLang;
  if (!pageLang) pageLang = detectByHeuristic(u.pathname + ' ' + u.hostname);
  if (!pageLang) pageLang = 'en';

  const target = (prefs.targetLang || 'en').split('-')[0];
  const source = (pageLang || 'en').split('-')[0];
  if (target === source) return { ok:false, targetLang: target, sourceLang: source, mode, reason: 'same-lang' };
  return { ok:true, targetLang: target, sourceLang: source, mode, reason: 'diff-lang' };
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
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
  if (cmd !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
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
  } catch {}
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const selection = (info.selectionText || '').trim();
  if (!selection) return;
  const prefs = await getPrefs();
  if (info.menuItemId === 'autotrans_add_protect') {
    const set = new Set([...(prefs.glossary?.protect || [])]);
    set.add(selection);
    prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
    prefs.glossary.protect = Array.from(set);
    await new Promise<void>((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
    chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: `已加入不翻译词：${selection}` });
    return;
  }
  if (info.menuItemId === 'autotrans_add_pair') {
    // Ask for target translation via page prompt to avoid extension UI
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => {
        // run in page world
        try { return prompt('请输入“术语翻译”的目标文本：', sel) || ''; }
        catch { return ''; }
      },
      args: [selection]
    });
    const tgt = (result || '').trim();
    if (!tgt) { chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: '已取消添加术语' }); return; }
    const pairs = (prefs.glossary?.pairs || []).filter(p => p.src !== selection);
    pairs.push({ src: selection, tgt });
    prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
    prefs.glossary.pairs = pairs;
    await new Promise<void>((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
    chrome.tabs.sendMessage(tab.id, { type: 'TOAST', message: `已加入术语：${selection} → ${tgt}` });
  }
});
