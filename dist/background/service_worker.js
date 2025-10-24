// src/shared/prefs.ts
var defaultLang = (() => {
  try {
    const lang = navigator.language || navigator.userLanguage;
    if (typeof lang === "string" && lang.length) {
      return lang.split("-")[0];
    }
  } catch {
  }
  return "en";
})();
var DEFAULT_PREFS = {
  targetLang: defaultLang,
  autoTranslate: true,
  siteModes: {},
  provider: {
    type: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com",
    apiKey: "",
    model: "qwen-turbo"
  },
  glossary: { pairs: [], protect: [] }
};
function withPrefDefaults(partial) {
  const provider = partial?.provider ? { ...partial.provider } : { ...DEFAULT_PREFS.provider };
  const glossaryPairs = partial?.glossary?.pairs ? partial.glossary.pairs.filter((pair) => !!pair && typeof pair.src === "string" && typeof pair.tgt === "string").map((pair) => ({ src: pair.src, tgt: pair.tgt })) : [];
  const glossaryProtect = partial?.glossary?.protect ? partial.glossary.protect.filter((item) => typeof item === "string") : [];
  return {
    targetLang: (partial?.targetLang || DEFAULT_PREFS.targetLang).trim() || DEFAULT_PREFS.targetLang,
    autoTranslate: partial?.autoTranslate ?? DEFAULT_PREFS.autoTranslate,
    siteModes: partial?.siteModes ? { ...partial.siteModes } : {},
    provider,
    glossary: {
      pairs: glossaryPairs,
      protect: glossaryProtect
    }
  };
}

// src/shared/site.ts
var MULTI_PART_SUFFIXES = /* @__PURE__ */ new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "com.tr",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.ph",
  "co.in",
  "co.kr",
  "co.za"
]);
function getRegistrableDomain(hostname) {
  if (!hostname) return "";
  const rawParts = hostname.split(".").filter(Boolean);
  if (rawParts.length <= 2) return hostname;
  const parts = rawParts.map((p) => p.toLowerCase());
  for (const suffix of MULTI_PART_SUFFIXES) {
    const suffixParts = suffix.split(".");
    if (parts.length > suffixParts.length) {
      const tail = parts.slice(-suffixParts.length).join(".");
      if (tail === suffix) {
        return rawParts.slice(-(suffixParts.length + 1)).join(".");
      }
    }
  }
  return rawParts.slice(-2).join(".");
}

// src/background/service_worker.ts
function stableHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = h * 31 + s.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16);
}
function keyFor(text, src, dst, providerKey = "p", glosSig = "") {
  const k = `${providerKey}:${src || "auto"}:${dst || "auto"}:${glosSig}:${text}`;
  return stableHash(k);
}
function normalizeLLMText(raw) {
  if (!raw) return "";
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  if (/^json\b/i.test(s)) {
    s = s.replace(/^json\b[:\s]*/i, "").trim();
  }
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.trim();
}
function extractStrings(val) {
  if (!val) return null;
  const out = [];
  const push = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v.text === "string") out.push(v.text);
    else if (v && typeof v.content === "string") out.push(v.content);
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
function parseLLMArray(raw) {
  if (!raw) return null;
  const attempts = [];
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
function detectByHeuristic(sample) {
  const cjk = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
  if (cjk.test(sample)) return "zh";
  return "en";
}
function tabsDetectLanguage(tabId) {
  if (!tabId || !chrome.tabs?.detectLanguage) return Promise.resolve(void 0);
  return new Promise((resolve) => {
    try {
      chrome.tabs.detectLanguage(tabId, (lang) => resolve(lang || void 0));
    } catch {
      resolve(void 0);
    }
  });
}
var memoryCache = /* @__PURE__ */ new Map();
var MEM_CAP = 5e3;
function trimMemCache() {
  while (memoryCache.size > MEM_CAP) {
    const firstKey = memoryCache.keys().next().value;
    if (!firstKey) break;
    memoryCache.delete(firstKey);
  }
}
var DB_NAME = "autotrans";
var DB_VERSION = 1;
var STORE = "kv";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetMany(keys) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const out = new Array(keys.length);
    let remaining = keys.length;
    keys.forEach((k, i) => {
      const r = store.get(k);
      r.onsuccess = () => {
        out[i] = r.result?.v;
        if (--remaining === 0) resolve(out);
      };
      r.onerror = () => {
        out[i] = void 0;
        if (--remaining === 0) resolve(out);
      };
    });
  });
}
async function idbPutMany(entries) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    entries.forEach((e) => store.put({ k: e.k, v: e.v, t: Date.now() }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getPrefs() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["prefs"], (res) => {
      resolve(withPrefDefaults(res?.prefs));
    });
  });
}
async function setSitePref(site, mode) {
  const prefs = await getPrefs();
  prefs.siteModes = prefs.siteModes || {};
  prefs.siteModes[site] = mode;
  const payload = withPrefDefaults(prefs);
  await new Promise((resolve) => chrome.storage.sync.set({ prefs: payload }, () => resolve()));
}
var DeepSeekTranslator = class {
  constructor(baseUrl, apiKey, model, glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = (apiKey || "").trim();
    this.model = model || "deepseek-chat";
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }
  buildSystemPrompt(target, source) {
    const parts = [];
    parts.push(`You are a professional translation engine.`);
    parts.push(`Translate the user's text into target language (${target}).`);
    parts.push(source ? `The source language is ${source}.` : `Detect the source language automatically.`);
    if (this.glossary?.protect?.length) {
      parts.push(`Do NOT translate these protected terms (preserve exact casing and spelling): ${this.glossary.protect.join(", ")}`);
    }
    if (this.glossary?.pairs?.length) {
      const pairsDesc = this.glossary.pairs.map((p) => `"${p.src}" -> "${p.tgt}"`).join("; ");
      parts.push(`Glossary mappings (enforce exact output for matched source terms): ${pairsDesc}`);
    }
    parts.push(`Preserve punctuation, numbers, inline code, and URLs. Do not add explanations or quotes.`);
    return parts.join(" ");
  }
  mask(texts) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return { masked: texts, maps: [] };
    const maps = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m = [];
      terms.forEach((term, j) => {
        if (!term) return;
        const token = `\xA7\xA7P${j}\xA7\xA7`;
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        out = out.replace(re, m.term);
      }
      return out;
    });
  }
  async translateBatch(texts, target, source) {
    if (!this.apiKey) {
      console.warn("DeepSeek API key missing, skip translation batch.");
      return texts;
    }
    const keys = texts.map((t) => keyFor((t || "").trim(), source, target, "ds:" + this.model, this.glosSig));
    const memHits = keys.map((k) => memoryCache.get(k));
    const needIdxs = [];
    for (let i = 0; i < keys.length; i++) if (!memHits[i]) needIdxs.push(i);
    let idbHits = [];
    if (needIdxs.length) {
      const idbKeys = needIdxs.map((i) => keys[i]);
      const vals = await idbGetMany(idbKeys);
      idbHits = new Array(keys.length);
      needIdxs.forEach((i, j) => {
        idbHits[i] = vals[j];
        if (vals[j]) memoryCache.set(keys[i], vals[j]);
      });
    }
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      out[i] = memHits[i] || idbHits[i] || "";
    }
    const toTranslate = [];
    for (let i = 0; i < texts.length; i++) {
      const t = (texts[i] ?? "").trim();
      if (!t) {
        out[i] = t;
        continue;
      }
      if (!out[i]) toTranslate.push({ index: i, text: t });
    }
    if (!toTranslate.length) return out;
    const { masked, maps } = this.mask(toTranslate.map((x) => x.text));
    const MAX_CHARS = 6e3;
    let start = 0;
    const toPersist = [];
    while (start < masked.length) {
      let end = start, sum = 0;
      while (end < masked.length && sum + masked[end].length <= MAX_CHARS) {
        sum += masked[end].length;
        end++;
      }
      const slice = masked.slice(start, end);
      const sys = this.buildSystemPrompt(target, source);
      const userPayload = { target, source: source || "auto", texts: slice };
      const body = {
        model: this.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(userPayload) }
        ],
        temperature: 0.2,
        stream: false,
        response_format: { type: "json_object" }
      };
      let translations = null;
      let authError = false;
      try {
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
          body: JSON.stringify(body)
        });
        if (resp.status === 401 || resp.status === 403) authError = true;
        if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}`);
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content ?? "";
        const arr = parseLLMArray(typeof content === "string" ? content : JSON.stringify(content));
        if (arr) translations = arr;
      } catch (e) {
        console.warn("DeepSeek batch translate error", e);
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
        translations = [];
        for (const s of slice) translations.push(await this.translateOne(s, target, source));
      }
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
    if (toPersist.length) await idbPutMany(toPersist);
    return out;
  }
  async translateOne(text, target, source) {
    if (!this.apiKey) return text;
    const sys = this.buildSystemPrompt(target, source);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ],
      temperature: 0.2,
      stream: false
    };
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}`);
      const data = await resp.json();
      const out = data?.choices?.[0]?.message?.content;
      if (out) {
        if (typeof out === "string") {
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
      console.warn("DeepSeek translate error", e);
      return text;
    }
  }
};
var QwenTranslator = class {
  constructor(baseUrl, apiKey, model, glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = (apiKey || "").trim();
    this.model = model || "qwen-turbo";
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }
  buildSystemPrompt(target, source) {
    const parts = [];
    parts.push(`You are a professional translation engine.`);
    parts.push(`Translate the user's text into target language (${target}).`);
    parts.push(source ? `The source language is ${source}.` : `Detect the source language automatically.`);
    if (this.glossary?.protect?.length) {
      parts.push(`Do NOT translate these protected terms (preserve exact casing and spelling): ${this.glossary.protect.join(", ")}`);
    }
    if (this.glossary?.pairs?.length) {
      const pairsDesc = this.glossary.pairs.map((p) => `"${p.src}" -> "${p.tgt}"`).join("; ");
      parts.push(`Glossary mappings (enforce exact output for matched source terms): ${pairsDesc}`);
    }
    parts.push(`Preserve punctuation, numbers, inline code, and URLs. Do not add explanations or quotes.`);
    parts.push(`Return a JSON object with key "t" containing an array of translated strings in the same order as input texts.`);
    return parts.join(" ");
  }
  mask(texts) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return { masked: texts, maps: [] };
    const maps = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m = [];
      terms.forEach((term, j) => {
        if (!term) return;
        const token = `\xA7\xA7P${j}\xA7\xA7`;
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        out = out.replace(re, m.term);
      }
      return out;
    });
  }
  endpoint() {
    return `${this.baseUrl}/api/v1/services/aigc/text-generation/generation`;
  }
  async translateBatch(texts, target, source) {
    if (!this.apiKey) {
      console.warn("Qwen API key missing, skip translation batch.");
      return texts;
    }
    const keys = texts.map((t) => keyFor((t || "").trim(), source, target, "qw:" + this.model, this.glosSig));
    const memHits = keys.map((k) => memoryCache.get(k));
    const needIdxs = [];
    for (let i = 0; i < keys.length; i++) if (!memHits[i]) needIdxs.push(i);
    let idbHits = [];
    if (needIdxs.length) {
      const idbKeys = needIdxs.map((i) => keys[i]);
      const vals = await idbGetMany(idbKeys);
      idbHits = new Array(keys.length);
      needIdxs.forEach((i, j) => {
        idbHits[i] = vals[j];
        if (vals[j]) memoryCache.set(keys[i], vals[j]);
      });
    }
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      out[i] = memHits[i] || idbHits[i] || "";
    }
    const toTranslate = [];
    for (let i = 0; i < texts.length; i++) {
      const t = (texts[i] ?? "").trim();
      if (!t) {
        out[i] = t;
        continue;
      }
      if (!out[i]) toTranslate.push({ index: i, text: t });
    }
    if (!toTranslate.length) return out;
    const { masked, maps } = this.mask(toTranslate.map((x) => x.text));
    const MAX_CHARS = 6e3;
    let start = 0;
    const toPersist = [];
    while (start < masked.length) {
      let end = start, sum = 0;
      while (end < masked.length && sum + masked[end].length <= MAX_CHARS) {
        sum += masked[end].length;
        end++;
      }
      const slice = masked.slice(start, end);
      const sys = this.buildSystemPrompt(target, source);
      const userPayload = { target, source: source || "auto", texts: slice };
      const body = {
        model: this.model,
        input: {
          messages: [
            { role: "system", content: [{ text: sys }] },
            { role: "user", content: [{ text: JSON.stringify(userPayload) }] }
          ]
        },
        parameters: {
          result_format: "json"
        }
      };
      let translations = null;
      let authError = false;
      try {
        const resp = await fetch(this.endpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
          body: JSON.stringify(body)
        });
        if (resp.status === 401 || resp.status === 403) authError = true;
        if (!resp.ok) throw new Error(`Qwen HTTP ${resp.status}`);
        const data = await resp.json();
        const messageContent = data?.output?.choices?.[0]?.message?.content;
        let textBlob = "";
        if (Array.isArray(messageContent)) {
          textBlob = messageContent.map((item) => {
            if (typeof item === "string") return item;
            if (item?.text) return item.text;
            return "";
          }).join("").trim();
        } else if (typeof messageContent === "string") {
          textBlob = messageContent;
        } else if (messageContent?.text) {
          textBlob = messageContent.text;
        } else if (typeof data?.output?.text === "string") {
          textBlob = data.output.text;
        }
        const arr = parseLLMArray(textBlob);
        if (arr) translations = arr;
      } catch (e) {
        console.warn("Qwen batch translate error", e);
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
        translations = [];
        for (const s of slice) translations.push(await this.translateOne(s, target, source));
      }
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
    if (toPersist.length) await idbPutMany(toPersist);
    return out;
  }
  async translateOne(text, target, source) {
    if (!this.apiKey) return text;
    const sys = this.buildSystemPrompt(target, source);
    const body = {
      model: this.model,
      input: {
        messages: [
          { role: "system", content: [{ text: sys }] },
          { role: "user", content: [{ text }] }
        ]
      }
    };
    try {
      const resp = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`Qwen HTTP ${resp.status}`);
      const data = await resp.json();
      const messageContent = data?.output?.choices?.[0]?.message?.content;
      if (Array.isArray(messageContent)) {
        const combined = messageContent.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
        const arr = parseLLMArray(combined);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(combined);
        if (cleaned) return cleaned;
        return combined || text;
      }
      if (typeof messageContent === "string") {
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
      if (typeof data?.output?.text === "string") {
        const arr = parseLLMArray(data.output.text);
        if (arr?.length) return arr[0];
        const cleaned = normalizeLLMText(data.output.text);
        if (cleaned) return cleaned;
        return data.output.text || text;
      }
      return text;
    } catch (e) {
      console.warn("Qwen translate error", e);
      return text;
    }
  }
};
var LibreTranslator = class {
  constructor(baseUrl, apiKey, glossary) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.glossary = glossary || { pairs: [], protect: [] };
    this.glosSig = stableHash(JSON.stringify(this.glossary));
  }
  mask(texts) {
    const terms = (this.glossary?.protect || []).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return { masked: texts, maps: [] };
    const maps = [];
    const masked = texts.map((t, idx) => {
      let out = t;
      const m = [];
      terms.forEach((term, j) => {
        const token = `\xA7\xA7P${j}\xA7\xA7`;
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
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
    if (!maps.length) return texts;
    return texts.map((t, i) => {
      let out = t;
      for (const m of maps[i] || []) {
        const re = new RegExp(m.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: t, source: source || "auto", target, format: "text", api_key: this.apiKey || void 0 })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        out[i] = data.translatedText || t;
      } catch (e) {
        console.warn("Libre translate error", e);
        out[i] = t;
      }
    }
    return this.unmask(out, maps);
  }
};
async function chooseProvider() {
  const prefs = await getPrefs();
  const glossary = prefs.glossary || { pairs: [], protect: [] };
  const glosSig = stableHash(JSON.stringify(glossary));
  if (prefs.provider?.type === "qwen") {
    const p = prefs.provider;
    const apiKey = (p.apiKey || "").trim();
    if (!apiKey) {
      console.warn("Qwen provider selected but API key is empty. Falling back to LibreTranslate.");
      const fallback = new LibreTranslator("https://libretranslate.com", void 0, glossary);
      return { translateBatch: fallback.translateBatch.bind(fallback), providerKey: "lb", glosSig };
    }
    const inst = new QwenTranslator(p.baseUrl || "https://dashscope.aliyuncs.com", apiKey, p.model || "qwen-turbo", glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: "qw:" + p.model, glosSig };
  } else if (prefs.provider?.type === "deepseek") {
    const p = prefs.provider;
    const apiKey = (p.apiKey || "").trim();
    if (!apiKey) {
      console.warn("DeepSeek provider selected but API key is empty. Falling back to LibreTranslate.");
      const fallback = new LibreTranslator("https://libretranslate.com", void 0, glossary);
      return { translateBatch: fallback.translateBatch.bind(fallback), providerKey: "lb", glosSig };
    }
    const inst = new DeepSeekTranslator(p.baseUrl, apiKey, p.model || "deepseek-chat", glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: "ds:" + p.model, glosSig };
  } else {
    const p = prefs.provider;
    const inst = new LibreTranslator(p.baseUrl || "https://libretranslate.com", p.apiKey, glossary);
    return { translateBatch: inst.translateBatch.bind(inst), providerKey: "lb", glosSig };
  }
}
async function shouldTranslate(url, fallbackDocLang, tabId) {
  const prefs = await getPrefs();
  const u = new URL(url);
  const site = getRegistrableDomain(u.hostname);
  const mode = prefs.siteModes?.[site] || "auto";
  if (mode === "never") return { ok: false, targetLang: prefs.targetLang, mode, reason: "site-never" };
  if (mode === "always") return { ok: true, targetLang: prefs.targetLang, mode, reason: "site-always" };
  if (!prefs.autoTranslate) return { ok: false, targetLang: prefs.targetLang, mode, reason: "auto-off" };
  let pageLang = void 0;
  try {
    pageLang = await tabsDetectLanguage(tabId);
  } catch {
  }
  if (!pageLang) pageLang = fallbackDocLang;
  if (!pageLang) pageLang = detectByHeuristic(u.pathname + " " + u.hostname);
  if (!pageLang) pageLang = "en";
  const target = (prefs.targetLang || "en").split("-")[0];
  const source = (pageLang || "en").split("-")[0];
  if (target === source) return { ok: false, targetLang: target, sourceLang: source, mode, reason: "same-lang" };
  return { ok: true, targetLang: target, sourceLang: source, mode, reason: "diff-lang" };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "GET_PREFS") {
      const prefs = await getPrefs();
      sendResponse({ ok: true, prefs });
      return;
    }
    if (msg.type === "SET_SITE_PREF") {
      await setSitePref(msg.site, msg.mode);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "INIT") {
      const decision = await shouldTranslate(msg.url, msg.docLang, sender.tab?.id);
      sendResponse({ ok: true, decision });
      return;
    }
    if (msg.type === "TRANSLATE_BATCH") {
      const { translateBatch } = await chooseProvider();
      const out = await translateBatch(msg.texts, msg.targetLang, msg.sourceLang);
      sendResponse({ ok: true, result: out });
      return;
    }
    if (msg.type === "METRIC") {
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});
chrome.commands?.onCommand?.addListener(async (cmd) => {
  if (cmd !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TRANSLATION" }, () => {
    if (chrome.runtime.lastError) {
      console.warn("toggle-translation command dispatch failed", chrome.runtime.lastError);
    }
  });
});
chrome.runtime.onInstalled?.addListener(() => {
  try {
    chrome.contextMenus.create({ id: "autotrans_add_protect", title: "\u52A0\u5165\u4E0D\u7FFB\u8BD1\u8BCD\uFF08\u9009\u4E2D\u6587\u672C\uFF09", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "autotrans_add_pair", title: "\u52A0\u5165\u672F\u8BED\u8868\uFF08\u6E90\u8BED=\u76EE\u6807\uFF09", contexts: ["selection"] });
  } catch {
  }
});
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const selection = (info.selectionText || "").trim();
  if (!selection) return;
  const prefs = await getPrefs();
  if (info.menuItemId === "autotrans_add_protect") {
    const set = /* @__PURE__ */ new Set([...prefs.glossary?.protect || []]);
    set.add(selection);
    prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
    prefs.glossary.protect = Array.from(set);
    await new Promise((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
    chrome.tabs.sendMessage(tab.id, { type: "TOAST", message: `\u5DF2\u52A0\u5165\u4E0D\u7FFB\u8BD1\u8BCD\uFF1A${selection}` });
    return;
  }
  if (info.menuItemId === "autotrans_add_pair") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => {
        try {
          return prompt("\u8BF7\u8F93\u5165\u201C\u672F\u8BED\u7FFB\u8BD1\u201D\u7684\u76EE\u6807\u6587\u672C\uFF1A", sel) || "";
        } catch {
          return "";
        }
      },
      args: [selection]
    });
    const tgt = (result || "").trim();
    if (!tgt) {
      chrome.tabs.sendMessage(tab.id, { type: "TOAST", message: "\u5DF2\u53D6\u6D88\u6DFB\u52A0\u672F\u8BED" });
      return;
    }
    const pairs = (prefs.glossary?.pairs || []).filter((p) => p.src !== selection);
    pairs.push({ src: selection, tgt });
    prefs.glossary = prefs.glossary || { pairs: [], protect: [] };
    prefs.glossary.pairs = pairs;
    await new Promise((resolve) => chrome.storage.sync.set({ prefs }, () => resolve()));
    chrome.tabs.sendMessage(tab.id, { type: "TOAST", message: `\u5DF2\u52A0\u5165\u672F\u8BED\uFF1A${selection} \u2192 ${tgt}` });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NoYXJlZC9wcmVmcy50cyIsICIuLi8uLi9zcmMvc2hhcmVkL3NpdGUudHMiLCAiLi4vLi4vc3JjL2JhY2tncm91bmQvc2VydmljZV93b3JrZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImV4cG9ydCB0eXBlIERlZXBTZWVrUHJvdmlkZXIgPSB7XG4gIHR5cGU6ICdkZWVwc2Vlayc7XG4gIGJhc2VVcmw6IHN0cmluZztcbiAgYXBpS2V5OiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBRd2VuUHJvdmlkZXIgPSB7XG4gIHR5cGU6ICdxd2VuJztcbiAgYmFzZVVybDogc3RyaW5nO1xuICBhcGlLZXk6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIExpYnJlUHJvdmlkZXIgPSB7XG4gIHR5cGU6ICdsaWJyZSc7XG4gIGJhc2VVcmw6IHN0cmluZztcbiAgYXBpS2V5Pzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgR2xvc3NhcnkgPSB7XG4gIHBhaXJzOiB7IHNyYzogc3RyaW5nOyB0Z3Q6IHN0cmluZyB9W107XG4gIHByb3RlY3Q6IHN0cmluZ1tdO1xufTtcblxuZXhwb3J0IHR5cGUgUHJlZnMgPSB7XG4gIHRhcmdldExhbmc6IHN0cmluZztcbiAgYXV0b1RyYW5zbGF0ZTogYm9vbGVhbjtcbiAgc2l0ZU1vZGVzOiBSZWNvcmQ8c3RyaW5nLCAnYWx3YXlzJyB8ICduZXZlcicgfCAnYXV0byc+O1xuICBwcm92aWRlcjogRGVlcFNlZWtQcm92aWRlciB8IExpYnJlUHJvdmlkZXIgfCBRd2VuUHJvdmlkZXI7XG4gIGdsb3NzYXJ5OiBHbG9zc2FyeTtcbn07XG5cbmNvbnN0IGRlZmF1bHRMYW5nID0gKCgpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBsYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IChuYXZpZ2F0b3IgYXMgYW55KS51c2VyTGFuZ3VhZ2U7XG4gICAgaWYgKHR5cGVvZiBsYW5nID09PSAnc3RyaW5nJyAmJiBsYW5nLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIGxhbmcuc3BsaXQoJy0nKVswXTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGlnbm9yZSBhY2Nlc3MgZXJyb3JzIHN1Y2ggYXMgbmF2aWdhdG9yIGJlaW5nIHVuYXZhaWxhYmxlXG4gIH1cbiAgcmV0dXJuICdlbic7XG59KSgpO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9QUkVGUzogUHJlZnMgPSB7XG4gIHRhcmdldExhbmc6IGRlZmF1bHRMYW5nLFxuICBhdXRvVHJhbnNsYXRlOiB0cnVlLFxuICBzaXRlTW9kZXM6IHt9LFxuICBwcm92aWRlcjoge1xuICAgIHR5cGU6ICdxd2VuJyxcbiAgICBiYXNlVXJsOiAnaHR0cHM6Ly9kYXNoc2NvcGUuYWxpeXVuY3MuY29tJyxcbiAgICBhcGlLZXk6ICcnLFxuICAgIG1vZGVsOiAncXdlbi10dXJibydcbiAgfSxcbiAgZ2xvc3Nhcnk6IHsgcGFpcnM6IFtdLCBwcm90ZWN0OiBbXSB9XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gd2l0aFByZWZEZWZhdWx0cyhwYXJ0aWFsPzogUGFydGlhbDxQcmVmcz4pOiBQcmVmcyB7XG4gIGNvbnN0IHByb3ZpZGVyID0gcGFydGlhbD8ucHJvdmlkZXJcbiAgICA/IHsgLi4ucGFydGlhbC5wcm92aWRlciB9XG4gICAgOiB7IC4uLkRFRkFVTFRfUFJFRlMucHJvdmlkZXIgfTtcbiAgY29uc3QgZ2xvc3NhcnlQYWlycyA9IHBhcnRpYWw/Lmdsb3NzYXJ5Py5wYWlyc1xuICAgID8gcGFydGlhbC5nbG9zc2FyeS5wYWlyc1xuICAgICAgICAuZmlsdGVyKChwYWlyKTogcGFpciBpcyB7IHNyYzogc3RyaW5nOyB0Z3Q6IHN0cmluZyB9ID0+ICEhcGFpciAmJiB0eXBlb2YgcGFpci5zcmMgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBwYWlyLnRndCA9PT0gJ3N0cmluZycpXG4gICAgICAgIC5tYXAoKHBhaXIpID0+ICh7IHNyYzogcGFpci5zcmMsIHRndDogcGFpci50Z3QgfSkpXG4gICAgOiBbXTtcbiAgY29uc3QgZ2xvc3NhcnlQcm90ZWN0ID0gcGFydGlhbD8uZ2xvc3Nhcnk/LnByb3RlY3RcbiAgICA/IHBhcnRpYWwuZ2xvc3NhcnkucHJvdGVjdC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXG4gICAgOiBbXTtcbiAgcmV0dXJuIHtcbiAgICB0YXJnZXRMYW5nOiAocGFydGlhbD8udGFyZ2V0TGFuZyB8fCBERUZBVUxUX1BSRUZTLnRhcmdldExhbmcpLnRyaW0oKSB8fCBERUZBVUxUX1BSRUZTLnRhcmdldExhbmcsXG4gICAgYXV0b1RyYW5zbGF0ZTogcGFydGlhbD8uYXV0b1RyYW5zbGF0ZSA/PyBERUZBVUxUX1BSRUZTLmF1dG9UcmFuc2xhdGUsXG4gICAgc2l0ZU1vZGVzOiBwYXJ0aWFsPy5zaXRlTW9kZXMgPyB7IC4uLnBhcnRpYWwuc2l0ZU1vZGVzIH0gOiB7fSxcbiAgICBwcm92aWRlcjogcHJvdmlkZXIgYXMgUHJlZnNbJ3Byb3ZpZGVyJ10sXG4gICAgZ2xvc3Nhcnk6IHtcbiAgICAgIHBhaXJzOiBnbG9zc2FyeVBhaXJzLFxuICAgICAgcHJvdGVjdDogZ2xvc3NhcnlQcm90ZWN0XG4gICAgfVxuICB9O1xufVxuIiwgImNvbnN0IE1VTFRJX1BBUlRfU1VGRklYRVMgPSBuZXcgU2V0KFtcbiAgJ2NvLnVrJywgJ29yZy51aycsICdnb3YudWsnLCAnYWMudWsnLFxuICAnY29tLmF1JywgJ25ldC5hdScsICdvcmcuYXUnLFxuICAnY28uanAnLCAnbmUuanAnLCAnb3IuanAnLFxuICAnY29tLmJyJywgJ2NvbS5jbicsICdjb20uaGsnLCAnY29tLnNnJywgJ2NvbS50dycsICdjb20udHInLCAnY29tLm14JywgJ2NvbS5hcicsICdjb20uY28nLCAnY29tLnBlJywgJ2NvbS5waCcsXG4gICdjby5pbicsICdjby5rcicsICdjby56YSdcbl0pO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVnaXN0cmFibGVEb21haW4oaG9zdG5hbWU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWhvc3RuYW1lKSByZXR1cm4gJyc7XG4gIGNvbnN0IHJhd1BhcnRzID0gaG9zdG5hbWUuc3BsaXQoJy4nKS5maWx0ZXIoQm9vbGVhbik7XG4gIGlmIChyYXdQYXJ0cy5sZW5ndGggPD0gMikgcmV0dXJuIGhvc3RuYW1lO1xuICBjb25zdCBwYXJ0cyA9IHJhd1BhcnRzLm1hcCgocCkgPT4gcC50b0xvd2VyQ2FzZSgpKTtcbiAgZm9yIChjb25zdCBzdWZmaXggb2YgTVVMVElfUEFSVF9TVUZGSVhFUykge1xuICAgIGNvbnN0IHN1ZmZpeFBhcnRzID0gc3VmZml4LnNwbGl0KCcuJyk7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IHN1ZmZpeFBhcnRzLmxlbmd0aCkge1xuICAgICAgY29uc3QgdGFpbCA9IHBhcnRzLnNsaWNlKC1zdWZmaXhQYXJ0cy5sZW5ndGgpLmpvaW4oJy4nKTtcbiAgICAgIGlmICh0YWlsID09PSBzdWZmaXgpIHtcbiAgICAgICAgcmV0dXJuIHJhd1BhcnRzLnNsaWNlKC0oc3VmZml4UGFydHMubGVuZ3RoICsgMSkpLmpvaW4oJy4nKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJhd1BhcnRzLnNsaWNlKC0yKS5qb2luKCcuJyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTaXRlRnJvbVVybChyYXdVcmw/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXJhd1VybCkgcmV0dXJuICcnO1xuICB0cnkge1xuICAgIGNvbnN0IHUgPSBuZXcgVVJMKHJhd1VybCk7XG4gICAgcmV0dXJuIGdldFJlZ2lzdHJhYmxlRG9tYWluKHUuaG9zdG5hbWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gJyc7XG4gIH1cbn1cblxuZXhwb3J0IHsgTVVMVElfUEFSVF9TVUZGSVhFUyB9O1xuIiwgImltcG9ydCB0eXBlIHsgRGVlcFNlZWtQcm92aWRlciwgR2xvc3NhcnksIExpYnJlUHJvdmlkZXIsIFByZWZzLCBRd2VuUHJvdmlkZXIgfSBmcm9tICcuLi9zaGFyZWQvcHJlZnMnO1xuaW1wb3J0IHsgd2l0aFByZWZEZWZhdWx0cyB9IGZyb20gJy4uL3NoYXJlZC9wcmVmcyc7XG5pbXBvcnQgeyBnZXRSZWdpc3RyYWJsZURvbWFpbiB9IGZyb20gJy4uL3NoYXJlZC9zaXRlJztcblxuLy8gQXV0b1RyYW5zbGF0ZSBNVlAgLSBNVjMgc2VydmljZSB3b3JrZXJcbi8vIEVuaGFuY2VtZW50czogSW5kZXhlZERCIHBlcnNpc3RlbnQgY2FjaGUgKyBHbG9zc2FyeSAocGFpcnMgJiBwcm90ZWN0IHRlcm1zKSArIERlZXBTZWVrIEpTT04gYmF0Y2ggKyB0YWJzLmRldGVjdExhbmd1YWdlXG5cbnR5cGUgTWVzc2FnZSA9XG4gIHwgeyB0eXBlOiAnSU5JVCc7IHVybDogc3RyaW5nOyBkb2NMYW5nPzogc3RyaW5nOyBzaXRlPzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6ICdUUkFOU0xBVEVfQkFUQ0gnOyB0ZXh0czogc3RyaW5nW107IHRhcmdldExhbmc6IHN0cmluZzsgc291cmNlTGFuZz86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiAnR0VUX1BSRUZTJzsgc2l0ZT86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiAnU0VUX1NJVEVfUFJFRic7IHNpdGU6IHN0cmluZzsgbW9kZTogJ2Fsd2F5cyd8J25ldmVyJ3wnYXV0bycgfVxuICB8IHsgdHlwZTogJ01FVFJJQyc7IG5hbWU6IHN0cmluZzsgdmFsdWU6IG51bWJlciB9O1xuXG4vLyAtLS0tIFNtYWxsIGhlbHBlcnMgLS0tLVxuZnVuY3Rpb24gc3RhYmxlSGFzaChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgaCA9IDA7XG4gIGZvciAobGV0IGk9MDtpPHMubGVuZ3RoO2krKykgeyBoID0gKGgqMzEgKyBzLmNoYXJDb2RlQXQoaSkpfDA7IH1cbiAgcmV0dXJuIChoPj4+MCkudG9TdHJpbmcoMTYpO1xufVxuZnVuY3Rpb24ga2V5Rm9yKHRleHQ6IHN0cmluZywgc3JjPzogc3RyaW5nLCBkc3Q/OiBzdHJpbmcsIHByb3ZpZGVyS2V5OiBzdHJpbmcgPSAncCcsIGdsb3NTaWc6IHN0cmluZyA9ICcnKTogc3RyaW5nIHtcbiAgY29uc3QgayA9IGAke3Byb3ZpZGVyS2V5fToke3NyY3x8J2F1dG8nfToke2RzdHx8J2F1dG8nfToke2dsb3NTaWd9OiR7dGV4dH1gO1xuICByZXR1cm4gc3RhYmxlSGFzaChrKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTExNVGV4dChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghcmF3KSByZXR1cm4gJyc7XG4gIGxldCBzID0gcmF3LnRyaW0oKTtcbiAgaWYgKHMuc3RhcnRzV2l0aCgnYGBgJykpIHtcbiAgICBzID0gcy5yZXBsYWNlKC9eYGBgKD86anNvbik/L2ksICcnKS5yZXBsYWNlKC9gYGAkL2ksICcnKS50cmltKCk7XG4gIH1cbiAgaWYgKC9eanNvblxcYi9pLnRlc3QocykpIHtcbiAgICBzID0gcy5yZXBsYWNlKC9eanNvblxcYls6XFxzXSovaSwgJycpLnRyaW0oKTtcbiAgfVxuICAvLyByZW1vdmUgbGVhZGluZyAmIHRyYWlsaW5nIHF1b3RlcyBpZiB3cmFwcGVkIGFjY2lkZW50YWxseVxuICBpZiAoKHMuc3RhcnRzV2l0aCgnXCInKSAmJiBzLmVuZHNXaXRoKCdcIicpKSB8fCAocy5zdGFydHNXaXRoKFwiJ1wiKSAmJiBzLmVuZHNXaXRoKFwiJ1wiKSkpIHtcbiAgICBzID0gcy5zbGljZSgxLCAtMSk7XG4gIH1cbiAgcmV0dXJuIHMudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0U3RyaW5ncyh2YWw6IGFueSk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGlmICghdmFsKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBwdXNoID0gKHY6IGFueSkgPT4ge1xuICAgIGlmICh0eXBlb2YgdiA9PT0gJ3N0cmluZycpIG91dC5wdXNoKHYpO1xuICAgIGVsc2UgaWYgKHYgJiYgdHlwZW9mIHYudGV4dCA9PT0gJ3N0cmluZycpIG91dC5wdXNoKHYudGV4dCk7XG4gICAgZWxzZSBpZiAodiAmJiB0eXBlb2Ygdi5jb250ZW50ID09PSAnc3RyaW5nJykgb3V0LnB1c2godi5jb250ZW50KTtcbiAgfTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsKSkge1xuICAgIHZhbC5mb3JFYWNoKHB1c2gpO1xuICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsLnQpKSB7XG4gICAgdmFsLnQuZm9yRWFjaChwdXNoKTtcbiAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbC50cmFuc2xhdGlvbnMpKSB7XG4gICAgdmFsLnRyYW5zbGF0aW9ucy5mb3JFYWNoKHB1c2gpO1xuICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsLmRhdGEpKSB7XG4gICAgdmFsLmRhdGEuZm9yRWFjaChwdXNoKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4gb3V0Lmxlbmd0aCA/IG91dC5tYXAobm9ybWFsaXplTExNVGV4dCkgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBwYXJzZUxMTUFycmF5KHJhdzogc3RyaW5nKTogc3RyaW5nW10gfCBudWxsIHtcbiAgaWYgKCFyYXcpIHJldHVybiBudWxsO1xuICBjb25zdCBhdHRlbXB0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUxMTVRleHQocmF3KTtcbiAgaWYgKG5vcm1hbGl6ZWQpIGF0dGVtcHRzLnB1c2gobm9ybWFsaXplZCk7XG4gIGNvbnN0IGJyYWNlTWF0Y2ggPSBub3JtYWxpemVkLm1hdGNoKC9cXHtbXFxzXFxTXSpcXH0vKTtcbiAgaWYgKGJyYWNlTWF0Y2gpIGF0dGVtcHRzLnB1c2goYnJhY2VNYXRjaFswXSk7XG4gIGNvbnN0IGFycmF5TWF0Y2ggPSBub3JtYWxpemVkLm1hdGNoKC9cXFtbXFxzXFxTXSpcXF0vKTtcbiAgaWYgKGFycmF5TWF0Y2gpIGF0dGVtcHRzLnB1c2goYXJyYXlNYXRjaFswXSk7XG4gIGZvciAoY29uc3QgY2FuZCBvZiBhdHRlbXB0cykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGNhbmQpO1xuICAgICAgY29uc3QgYXJyID0gZXh0cmFjdFN0cmluZ3MocGFyc2VkKTtcbiAgICAgIGlmIChhcnIpIHJldHVybiBhcnI7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5mdW5jdGlvbiBkZXRlY3RCeUhldXJpc3RpYyhzYW1wbGU6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGNqayA9IC9bXFx1NEUwMC1cXHU5RkZGXFx1MzA0MC1cXHUzMEZGXFx1QUMwMC1cXHVEN0FGXS87XG4gIGlmIChjamsudGVzdChzYW1wbGUpKSByZXR1cm4gJ3poJztcbiAgcmV0dXJuICdlbic7XG59XG5mdW5jdGlvbiB0YWJzRGV0ZWN0TGFuZ3VhZ2UodGFiSWQ/OiBudW1iZXIpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICBpZiAoIXRhYklkIHx8ICFjaHJvbWUudGFicz8uZGV0ZWN0TGFuZ3VhZ2UpIHJldHVybiBQcm9taXNlLnJlc29sdmUodW5kZWZpbmVkKTtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNocm9tZS50YWJzLmRldGVjdExhbmd1YWdlKHRhYklkLCAobGFuZykgPT4gcmVzb2x2ZShsYW5nIHx8IHVuZGVmaW5lZCkpO1xuICAgIH0gY2F0Y2ggeyByZXNvbHZlKHVuZGVmaW5lZCk7IH1cbiAgfSk7XG59XG5cbi8vIC0tLS0gSW4tbWVtb3J5IExSVS1pc2ggY2FjaGUgKHBlciBTVyBsaWZldGltZSkgLS0tLVxuY29uc3QgbWVtb3J5Q2FjaGUgPSBuZXcgTWFwPHN0cmluZyxzdHJpbmc+KCk7XG5jb25zdCBNRU1fQ0FQID0gNTAwMDtcbmZ1bmN0aW9uIHRyaW1NZW1DYWNoZSgpIHtcbiAgd2hpbGUgKG1lbW9yeUNhY2hlLnNpemUgPiBNRU1fQ0FQKSB7XG4gICAgY29uc3QgZmlyc3RLZXkgPSBtZW1vcnlDYWNoZS5rZXlzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWZpcnN0S2V5KSBicmVhaztcbiAgICBtZW1vcnlDYWNoZS5kZWxldGUoZmlyc3RLZXkpO1xuICB9XG59XG5cbi8vIC0tLS0gSW5kZXhlZERCIHBlcnNpc3RlbnQgS1YgY2FjaGUgLS0tLVxuY29uc3QgREJfTkFNRSA9ICdhdXRvdHJhbnMnO1xuY29uc3QgREJfVkVSU0lPTiA9IDE7XG5jb25zdCBTVE9SRSA9ICdrdic7IC8vIHsgazogc3RyaW5nLCB2OiBzdHJpbmcsIHQ/OiBudW1iZXIgfVxuXG5mdW5jdGlvbiBpZGJPcGVuKCk6IFByb21pc2U8SURCRGF0YWJhc2U+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCByZXEgPSBpbmRleGVkREIub3BlbihEQl9OQU1FLCBEQl9WRVJTSU9OKTtcbiAgICByZXEub251cGdyYWRlbmVlZGVkID0gKCkgPT4ge1xuICAgICAgY29uc3QgZGIgPSByZXEucmVzdWx0O1xuICAgICAgaWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNUT1JFKSkge1xuICAgICAgICBkYi5jcmVhdGVPYmplY3RTdG9yZShTVE9SRSwgeyBrZXlQYXRoOiAnaycgfSk7XG4gICAgICB9XG4gICAgfTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZShyZXEucmVzdWx0KTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHJlamVjdChyZXEuZXJyb3IpO1xuICB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGlkYkdldE1hbnkoa2V5czogc3RyaW5nW10pOiBQcm9taXNlPChzdHJpbmd8dW5kZWZpbmVkKVtdPiB7XG4gIGNvbnN0IGRiID0gYXdhaXQgaWRiT3BlbigpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oU1RPUkUsICdyZWFkb25seScpO1xuICAgIGNvbnN0IHN0b3JlID0gdHgub2JqZWN0U3RvcmUoU1RPUkUpO1xuICAgIGNvbnN0IG91dDogKHN0cmluZ3x1bmRlZmluZWQpW10gPSBuZXcgQXJyYXkoa2V5cy5sZW5ndGgpO1xuICAgIGxldCByZW1haW5pbmcgPSBrZXlzLmxlbmd0aDtcbiAgICBrZXlzLmZvckVhY2goKGssIGkpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBzdG9yZS5nZXQoayk7XG4gICAgICByLm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgb3V0W2ldID0gci5yZXN1bHQ/LnY7XG4gICAgICAgIGlmICgtLXJlbWFpbmluZyA9PT0gMCkgcmVzb2x2ZShvdXQpO1xuICAgICAgfTtcbiAgICAgIHIub25lcnJvciA9ICgpID0+IHtcbiAgICAgICAgb3V0W2ldID0gdW5kZWZpbmVkO1xuICAgICAgICBpZiAoLS1yZW1haW5pbmcgPT09IDApIHJlc29sdmUob3V0KTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gaWRiUHV0TWFueShlbnRyaWVzOiB7azpzdHJpbmcsIHY6c3RyaW5nfVtdKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGRiID0gYXdhaXQgaWRiT3BlbigpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oU1RPUkUsICdyZWFkd3JpdGUnKTtcbiAgICBjb25zdCBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKFNUT1JFKTtcbiAgICBlbnRyaWVzLmZvckVhY2goZSA9PiBzdG9yZS5wdXQoeyBrOiBlLmssIHY6IGUudiwgdDogRGF0ZS5ub3coKSB9KSk7XG4gICAgdHgub25jb21wbGV0ZSA9ICgpID0+IHJlc29sdmUoKTtcbiAgICB0eC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHR4LmVycm9yKTtcbiAgfSk7XG59XG5cbi8vIC0tLS0gUHJlZnMgLS0tLVxuYXN5bmMgZnVuY3Rpb24gZ2V0UHJlZnMoKTogUHJvbWlzZTxQcmVmcz4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldChbJ3ByZWZzJ10sIChyZXMpID0+IHtcbiAgICAgIHJlc29sdmUod2l0aFByZWZEZWZhdWx0cyhyZXM/LnByZWZzIGFzIFBhcnRpYWw8UHJlZnM+IHwgdW5kZWZpbmVkKSk7XG4gICAgfSk7XG4gIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gc2V0U2l0ZVByZWYoc2l0ZTogc3RyaW5nLCBtb2RlOiAnYWx3YXlzJ3wnbmV2ZXInfCdhdXRvJykge1xuICBjb25zdCBwcmVmcyA9IGF3YWl0IGdldFByZWZzKCk7XG4gIHByZWZzLnNpdGVNb2RlcyA9IHByZWZzLnNpdGVNb2RlcyB8fCB7fTtcbiAgcHJlZnMuc2l0ZU1vZGVzW3NpdGVdID0gbW9kZTtcbiAgY29uc3QgcGF5bG9hZCA9IHdpdGhQcmVmRGVmYXVsdHMocHJlZnMpO1xuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gY2hyb21lLnN0b3JhZ2Uuc3luYy5zZXQoeyBwcmVmczogcGF5bG9hZCB9LCAoKSA9PiByZXNvbHZlKCkpKTtcbn1cblxuLy8gLS0tLSBQcm92aWRlcnMgLS0tLVxuY2xhc3MgRGVlcFNlZWtUcmFuc2xhdG9yIHtcbiAgYmFzZVVybDogc3RyaW5nO1xuICBhcGlLZXk6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAgZ2xvc1NpZzogc3RyaW5nO1xuICBnbG9zc2FyeTogR2xvc3Nhcnk7XG4gIGNvbnN0cnVjdG9yKGJhc2VVcmw6IHN0cmluZywgYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIGdsb3NzYXJ5OiBHbG9zc2FyeSkge1xuICAgIHRoaXMuYmFzZVVybCA9IGJhc2VVcmwucmVwbGFjZSgvXFwvJC8sICcnKTtcbiAgICB0aGlzLmFwaUtleSA9IChhcGlLZXkgfHwgJycpLnRyaW0oKTtcbiAgICB0aGlzLm1vZGVsID0gbW9kZWwgfHwgJ2RlZXBzZWVrLWNoYXQnO1xuICAgIHRoaXMuZ2xvc3NhcnkgPSBnbG9zc2FyeSB8fCB7IHBhaXJzOiBbXSwgcHJvdGVjdDogW10gfTtcbiAgICB0aGlzLmdsb3NTaWcgPSBzdGFibGVIYXNoKEpTT04uc3RyaW5naWZ5KHRoaXMuZ2xvc3NhcnkpKTtcbiAgfVxuXG4gIHByaXZhdGUgYnVpbGRTeXN0ZW1Qcm9tcHQodGFyZ2V0OiBzdHJpbmcsIHNvdXJjZT86IHN0cmluZykge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIHBhcnRzLnB1c2goYFlvdSBhcmUgYSBwcm9mZXNzaW9uYWwgdHJhbnNsYXRpb24gZW5naW5lLmApO1xuICAgIHBhcnRzLnB1c2goYFRyYW5zbGF0ZSB0aGUgdXNlcidzIHRleHQgaW50byB0YXJnZXQgbGFuZ3VhZ2UgKCR7dGFyZ2V0fSkuYCk7XG4gICAgcGFydHMucHVzaChzb3VyY2UgPyBgVGhlIHNvdXJjZSBsYW5ndWFnZSBpcyAke3NvdXJjZX0uYCA6IGBEZXRlY3QgdGhlIHNvdXJjZSBsYW5ndWFnZSBhdXRvbWF0aWNhbGx5LmApO1xuICAgIGlmICh0aGlzLmdsb3NzYXJ5Py5wcm90ZWN0Py5sZW5ndGgpIHtcbiAgICAgIHBhcnRzLnB1c2goYERvIE5PVCB0cmFuc2xhdGUgdGhlc2UgcHJvdGVjdGVkIHRlcm1zIChwcmVzZXJ2ZSBleGFjdCBjYXNpbmcgYW5kIHNwZWxsaW5nKTogJHt0aGlzLmdsb3NzYXJ5LnByb3RlY3Quam9pbignLCAnKX1gKTtcbiAgICB9XG4gICAgaWYgKHRoaXMuZ2xvc3Nhcnk/LnBhaXJzPy5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IHBhaXJzRGVzYyA9IHRoaXMuZ2xvc3NhcnkucGFpcnMubWFwKHAgPT4gYFwiJHtwLnNyY31cIiAtPiBcIiR7cC50Z3R9XCJgKS5qb2luKCc7ICcpO1xuICAgICAgcGFydHMucHVzaChgR2xvc3NhcnkgbWFwcGluZ3MgKGVuZm9yY2UgZXhhY3Qgb3V0cHV0IGZvciBtYXRjaGVkIHNvdXJjZSB0ZXJtcyk6ICR7cGFpcnNEZXNjfWApO1xuICAgIH1cbiAgICBwYXJ0cy5wdXNoKGBQcmVzZXJ2ZSBwdW5jdHVhdGlvbiwgbnVtYmVycywgaW5saW5lIGNvZGUsIGFuZCBVUkxzLiBEbyBub3QgYWRkIGV4cGxhbmF0aW9ucyBvciBxdW90ZXMuYCk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHByaXZhdGUgbWFzayh0ZXh0czogc3RyaW5nW10pIHtcbiAgICBjb25zdCB0ZXJtcyA9ICh0aGlzLmdsb3NzYXJ5Py5wcm90ZWN0IHx8IFtdKS5maWx0ZXIoQm9vbGVhbikuc29ydCgoYSxiKT0+Yi5sZW5ndGgtYS5sZW5ndGgpO1xuICAgIGlmICghdGVybXMubGVuZ3RoKSByZXR1cm4geyBtYXNrZWQ6IHRleHRzLCBtYXBzOiBbXSBhcyB7dG9rZW46c3RyaW5nLCB0ZXJtOnN0cmluZ31bXVtdIH07XG4gICAgY29uc3QgbWFwczoge3Rva2VuOnN0cmluZywgdGVybTpzdHJpbmd9W11bXSA9IFtdO1xuICAgIGNvbnN0IG1hc2tlZCA9IHRleHRzLm1hcCgodCwgaWR4KSA9PiB7XG4gICAgICBsZXQgb3V0ID0gdDtcbiAgICAgIGNvbnN0IG06IHt0b2tlbjpzdHJpbmcsIHRlcm06c3RyaW5nfVtdID0gW107XG4gICAgICB0ZXJtcy5mb3JFYWNoKCh0ZXJtLCBqKSA9PiB7XG4gICAgICAgIGlmICghdGVybSkgcmV0dXJuO1xuICAgICAgICBjb25zdCB0b2tlbiA9IGBcdTAwQTdcdTAwQTdQJHtqfVx1MDBBN1x1MDBBN2A7IC8vIHVubGlrZWx5IHRvIGFwcGVhciBuYXR1cmFsbHlcbiAgICAgICAgY29uc3QgcmUgPSBuZXcgUmVnRXhwKHRlcm0ucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csICdcXFxcJCYnKSwgJ2dpJyk7XG4gICAgICAgIGlmIChyZS50ZXN0KG91dCkpIHtcbiAgICAgICAgICBvdXQgPSBvdXQucmVwbGFjZShyZSwgdG9rZW4pO1xuICAgICAgICAgIG0ucHVzaCh7IHRva2VuLCB0ZXJtIH0pO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIG1hcHNbaWR4XSA9IG07XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH0pO1xuICAgIHJldHVybiB7IG1hc2tlZCwgbWFwcyB9O1xuICB9XG4gIHByaXZhdGUgdW5tYXNrKHRleHRzOiBzdHJpbmdbXSwgbWFwczoge3Rva2VuOnN0cmluZywgdGVybTpzdHJpbmd9W11bXSkge1xuICAgIGlmICghbWFwcy5sZW5ndGgpIHJldHVybiB0ZXh0cztcbiAgICByZXR1cm4gdGV4dHMubWFwKCh0LCBpKSA9PiB7XG4gICAgICBsZXQgb3V0ID0gdDtcbiAgICAgIGZvciAoY29uc3QgbSBvZiBtYXBzW2ldIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IHJlID0gbmV3IFJlZ0V4cChtLnRva2VuLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCAnXFxcXCQmJyksICdnJyk7XG4gICAgICAgIG91dCA9IG91dC5yZXBsYWNlKHJlLCBtLnRlcm0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHRyYW5zbGF0ZUJhdGNoKHRleHRzOiBzdHJpbmdbXSwgdGFyZ2V0OiBzdHJpbmcsIHNvdXJjZT86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICBpZiAoIXRoaXMuYXBpS2V5KSB7XG4gICAgICBjb25zb2xlLndhcm4oJ0RlZXBTZWVrIEFQSSBrZXkgbWlzc2luZywgc2tpcCB0cmFuc2xhdGlvbiBiYXRjaC4nKTtcbiAgICAgIHJldHVybiB0ZXh0cztcbiAgICB9XG4gICAgLy8gbWVtb3J5ICsgaWRiIGNhY2hlIGxvb2t1cFxuICAgIGNvbnN0IGtleXMgPSB0ZXh0cy5tYXAodCA9PiBrZXlGb3IoKHR8fCcnKS50cmltKCksIHNvdXJjZSwgdGFyZ2V0LCAnZHM6Jyt0aGlzLm1vZGVsLCB0aGlzLmdsb3NTaWcpKTtcbiAgICBjb25zdCBtZW1IaXRzID0ga2V5cy5tYXAoayA9PiBtZW1vcnlDYWNoZS5nZXQoaykpO1xuICAgIGNvbnN0IG5lZWRJZHhzOiBudW1iZXJbXSA9IFtdO1xuICAgIGZvciAobGV0IGk9MDtpPGtleXMubGVuZ3RoO2krKykgaWYgKCFtZW1IaXRzW2ldKSBuZWVkSWR4cy5wdXNoKGkpO1xuXG4gICAgbGV0IGlkYkhpdHM6IChzdHJpbmd8dW5kZWZpbmVkKVtdID0gW107XG4gICAgaWYgKG5lZWRJZHhzLmxlbmd0aCkge1xuICAgICAgY29uc3QgaWRiS2V5cyA9IG5lZWRJZHhzLm1hcChpID0+IGtleXNbaV0pO1xuICAgICAgY29uc3QgdmFscyA9IGF3YWl0IGlkYkdldE1hbnkoaWRiS2V5cyk7XG4gICAgICBpZGJIaXRzID0gbmV3IEFycmF5KGtleXMubGVuZ3RoKTtcbiAgICAgIG5lZWRJZHhzLmZvckVhY2goKGksIGopID0+IHsgaWRiSGl0c1tpXSA9IHZhbHNbal07IGlmICh2YWxzW2pdKSBtZW1vcnlDYWNoZS5zZXQoa2V5c1tpXSwgdmFsc1tqXSEpOyB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBvdXQgPSBuZXcgQXJyYXk8c3RyaW5nPih0ZXh0cy5sZW5ndGgpO1xuICAgIGZvciAobGV0IGk9MDtpPHRleHRzLmxlbmd0aDtpKyspIHtcbiAgICAgIG91dFtpXSA9IG1lbUhpdHNbaV0gfHwgaWRiSGl0c1tpXSB8fCAnJztcbiAgICB9XG5cbiAgICAvLyBidWlsZCBsaXN0IHRvIHRyYW5zbGF0ZVxuICAgIGNvbnN0IHRvVHJhbnNsYXRlOiB7IGluZGV4Om51bWJlciwgdGV4dDpzdHJpbmcgfVtdID0gW107XG4gICAgZm9yIChsZXQgaT0wO2k8dGV4dHMubGVuZ3RoO2krKykge1xuICAgICAgY29uc3QgdCA9ICh0ZXh0c1tpXSA/PyAnJykudHJpbSgpO1xuICAgICAgaWYgKCF0KSB7IG91dFtpXSA9IHQ7IGNvbnRpbnVlOyB9XG4gICAgICBpZiAoIW91dFtpXSkgdG9UcmFuc2xhdGUucHVzaCh7IGluZGV4OmksIHRleHQ6dCB9KTtcbiAgICB9XG4gICAgaWYgKCF0b1RyYW5zbGF0ZS5sZW5ndGgpIHJldHVybiBvdXQ7XG5cbiAgICAvLyBtYXNrIHByb3RlY3QgdGVybXNcbiAgICBjb25zdCB7IG1hc2tlZCwgbWFwcyB9ID0gdGhpcy5tYXNrKHRvVHJhbnNsYXRlLm1hcCh4ID0+IHgudGV4dCkpO1xuXG4gICAgLy8gY2h1bmtpbmdcbiAgICBjb25zdCBNQVhfQ0hBUlMgPSA2MDAwO1xuICAgIGxldCBzdGFydCA9IDA7XG4gICAgY29uc3QgdG9QZXJzaXN0OiB7azpzdHJpbmcsIHY6c3RyaW5nfVtdID0gW107XG4gICAgd2hpbGUgKHN0YXJ0IDwgbWFza2VkLmxlbmd0aCkge1xuICAgICAgbGV0IGVuZCA9IHN0YXJ0LCBzdW0gPSAwO1xuICAgICAgd2hpbGUgKGVuZCA8IG1hc2tlZC5sZW5ndGggJiYgKHN1bSArIG1hc2tlZFtlbmRdLmxlbmd0aCkgPD0gTUFYX0NIQVJTKSB7IHN1bSArPSBtYXNrZWRbZW5kXS5sZW5ndGg7IGVuZCsrOyB9XG4gICAgICBjb25zdCBzbGljZSA9IG1hc2tlZC5zbGljZShzdGFydCwgZW5kKTtcbiAgICAgIGNvbnN0IHN5cyA9IHRoaXMuYnVpbGRTeXN0ZW1Qcm9tcHQodGFyZ2V0LCBzb3VyY2UpO1xuICAgICAgY29uc3QgdXNlclBheWxvYWQgPSB7IHRhcmdldCwgc291cmNlOiBzb3VyY2UgfHwgJ2F1dG8nLCB0ZXh0czogc2xpY2UgfTtcbiAgICAgIGNvbnN0IGJvZHk6IGFueSA9IHtcbiAgICAgICAgbW9kZWw6IHRoaXMubW9kZWwsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiAnc3lzdGVtJywgY29udGVudDogc3lzIH0sXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IEpTT04uc3RyaW5naWZ5KHVzZXJQYXlsb2FkKSB9XG4gICAgICAgIF0sXG4gICAgICAgIHRlbXBlcmF0dXJlOiAwLjIsXG4gICAgICAgIHN0cmVhbTogZmFsc2UsXG4gICAgICAgIHJlc3BvbnNlX2Zvcm1hdDogeyB0eXBlOiAnanNvbl9vYmplY3QnIH1cbiAgICAgIH07XG4gICAgICBsZXQgdHJhbnNsYXRpb25zOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuICAgICAgbGV0IGF1dGhFcnJvciA9IGZhbHNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vY2hhdC9jb21wbGV0aW9uc2AsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuYXBpS2V5fWAgfSxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KVxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHJlc3Auc3RhdHVzID09PSA0MDEgfHwgcmVzcC5zdGF0dXMgPT09IDQwMykgYXV0aEVycm9yID0gdHJ1ZTtcbiAgICAgICAgaWYgKCFyZXNwLm9rKSB0aHJvdyBuZXcgRXJyb3IoYERlZXBTZWVrIEhUVFAgJHtyZXNwLnN0YXR1c31gKTtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpO1xuICAgICAgICBjb25zdCBjb250ZW50ID0gZGF0YT8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50ID8/ICcnO1xuICAgICAgICBjb25zdCBhcnIgPSBwYXJzZUxMTUFycmF5KHR5cGVvZiBjb250ZW50ID09PSAnc3RyaW5nJyA/IGNvbnRlbnQgOiBKU09OLnN0cmluZ2lmeShjb250ZW50KSk7XG4gICAgICAgIGlmIChhcnIpIHRyYW5zbGF0aW9ucyA9IGFycjtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKCdEZWVwU2VlayBiYXRjaCB0cmFuc2xhdGUgZXJyb3InLCBlKTtcbiAgICAgIH1cbiAgICAgIGlmICghdHJhbnNsYXRpb25zKSB7XG4gICAgICAgIGlmIChhdXRoRXJyb3IpIHtcbiAgICAgICAgICBmb3IgKGxldCBqPTA7ajxzbGljZS5sZW5ndGg7aisrKSB7XG4gICAgICAgICAgICBjb25zdCB0YXJnZXRJbmRleCA9IHRvVHJhbnNsYXRlW3N0YXJ0ICsgal0uaW5kZXg7XG4gICAgICAgICAgICBjb25zdCBzcmNUZXh0ID0gdG9UcmFuc2xhdGVbc3RhcnQgKyBqXS50ZXh0O1xuICAgICAgICAgICAgb3V0W3RhcmdldEluZGV4XSA9IHNyY1RleHQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIHN0YXJ0ID0gZW5kO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIC8vIGZhbGxiYWNrIHBlciBpdGVtXG4gICAgICAgIHRyYW5zbGF0aW9ucyA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2UpIHRyYW5zbGF0aW9ucy5wdXNoKGF3YWl0IHRoaXMudHJhbnNsYXRlT25lKHMsIHRhcmdldCwgc291cmNlKSk7XG4gICAgICB9XG5cbiAgICAgIC8vIHVubWFzayArIGFzc2lnblxuICAgICAgY29uc3QgdW5tYXNrZWQgPSB0aGlzLnVubWFzayh0cmFuc2xhdGlvbnMsIG1hcHMuc2xpY2Uoc3RhcnQsIGVuZCkpO1xuICAgICAgZm9yIChsZXQgaj0wO2o8dW5tYXNrZWQubGVuZ3RoO2orKykge1xuICAgICAgICBjb25zdCB0YXJnZXRJbmRleCA9IHRvVHJhbnNsYXRlW3N0YXJ0ICsgal0uaW5kZXg7XG4gICAgICAgIGNvbnN0IHNyY1RleHQgPSB0b1RyYW5zbGF0ZVtzdGFydCArIGpdLnRleHQ7XG4gICAgICAgIGNvbnN0IHRyID0gdW5tYXNrZWRbal0gfHwgc3JjVGV4dDtcbiAgICAgICAgb3V0W3RhcmdldEluZGV4XSA9IHRyO1xuICAgICAgICBjb25zdCBrID0ga2V5c1t0YXJnZXRJbmRleF07XG4gICAgICAgIG1lbW9yeUNhY2hlLnNldChrLCB0cik7XG4gICAgICAgIHRvUGVyc2lzdC5wdXNoKHsgaywgdjogdHIgfSk7XG4gICAgICB9XG4gICAgICB0cmltTWVtQ2FjaGUoKTtcbiAgICAgIHN0YXJ0ID0gZW5kO1xuICAgIH1cblxuICAgIC8vIHBlcnNpc3QgdG8gaWRiXG4gICAgaWYgKHRvUGVyc2lzdC5sZW5ndGgpIGF3YWl0IGlkYlB1dE1hbnkodG9QZXJzaXN0KTtcbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB0cmFuc2xhdGVPbmUodGV4dDogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZywgc291cmNlPzogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIXRoaXMuYXBpS2V5KSByZXR1cm4gdGV4dDtcbiAgICBjb25zdCBzeXMgPSB0aGlzLmJ1aWxkU3lzdGVtUHJvbXB0KHRhcmdldCwgc291cmNlKTtcbiAgICBjb25zdCBib2R5OiBhbnkgPSB7XG4gICAgICBtb2RlbDogdGhpcy5tb2RlbCxcbiAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgIHsgcm9sZTogJ3N5c3RlbScsIGNvbnRlbnQ6IHN5cyB9LFxuICAgICAgICB7IHJvbGU6ICd1c2VyJywgY29udGVudDogdGV4dCB9XG4gICAgICBdLFxuICAgICAgdGVtcGVyYXR1cmU6IDAuMixcbiAgICAgIHN0cmVhbTogZmFsc2VcbiAgICB9O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9jaGF0L2NvbXBsZXRpb25zYCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0aGlzLmFwaUtleX1gIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpXG4gICAgICB9KTtcbiAgICAgIGlmICghcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKGBEZWVwU2VlayBIVFRQICR7cmVzcC5zdGF0dXN9YCk7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7XG4gICAgICBjb25zdCBvdXQgPSBkYXRhPy5jaG9pY2VzPy5bMF0/Lm1lc3NhZ2U/LmNvbnRlbnQ7XG4gICAgICBpZiAob3V0KSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3V0ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIGNvbnN0IGFyciA9IHBhcnNlTExNQXJyYXkob3V0KTtcbiAgICAgICAgICBpZiAoYXJyPy5sZW5ndGgpIHJldHVybiBhcnJbMF07XG4gICAgICAgICAgY29uc3QgY2xlYW5lZCA9IG5vcm1hbGl6ZUxMTVRleHQob3V0KTtcbiAgICAgICAgICBpZiAoY2xlYW5lZCkgcmV0dXJuIGNsZWFuZWQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3Qgc3RyID0gSlNPTi5zdHJpbmdpZnkob3V0KTtcbiAgICAgICAgICBjb25zdCBhcnIgPSBwYXJzZUxMTUFycmF5KHN0cik7XG4gICAgICAgICAgaWYgKGFycj8ubGVuZ3RoKSByZXR1cm4gYXJyWzBdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gdGV4dDtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ0RlZXBTZWVrIHRyYW5zbGF0ZSBlcnJvcicsIGUpO1xuICAgICAgcmV0dXJuIHRleHQ7XG4gICAgfVxuICB9XG59XG5cbmNsYXNzIFF3ZW5UcmFuc2xhdG9yIHtcbiAgYmFzZVVybDogc3RyaW5nO1xuICBhcGlLZXk6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAgZ2xvc1NpZzogc3RyaW5nO1xuICBnbG9zc2FyeTogR2xvc3Nhcnk7XG4gIGNvbnN0cnVjdG9yKGJhc2VVcmw6IHN0cmluZywgYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIGdsb3NzYXJ5OiBHbG9zc2FyeSkge1xuICAgIHRoaXMuYmFzZVVybCA9IGJhc2VVcmwucmVwbGFjZSgvXFwvJC8sICcnKTtcbiAgICB0aGlzLmFwaUtleSA9IChhcGlLZXkgfHwgJycpLnRyaW0oKTtcbiAgICB0aGlzLm1vZGVsID0gbW9kZWwgfHwgJ3F3ZW4tdHVyYm8nO1xuICAgIHRoaXMuZ2xvc3NhcnkgPSBnbG9zc2FyeSB8fCB7IHBhaXJzOiBbXSwgcHJvdGVjdDogW10gfTtcbiAgICB0aGlzLmdsb3NTaWcgPSBzdGFibGVIYXNoKEpTT04uc3RyaW5naWZ5KHRoaXMuZ2xvc3NhcnkpKTtcbiAgfVxuXG4gIHByaXZhdGUgYnVpbGRTeXN0ZW1Qcm9tcHQodGFyZ2V0OiBzdHJpbmcsIHNvdXJjZT86IHN0cmluZykge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIHBhcnRzLnB1c2goYFlvdSBhcmUgYSBwcm9mZXNzaW9uYWwgdHJhbnNsYXRpb24gZW5naW5lLmApO1xuICAgIHBhcnRzLnB1c2goYFRyYW5zbGF0ZSB0aGUgdXNlcidzIHRleHQgaW50byB0YXJnZXQgbGFuZ3VhZ2UgKCR7dGFyZ2V0fSkuYCk7XG4gICAgcGFydHMucHVzaChzb3VyY2UgPyBgVGhlIHNvdXJjZSBsYW5ndWFnZSBpcyAke3NvdXJjZX0uYCA6IGBEZXRlY3QgdGhlIHNvdXJjZSBsYW5ndWFnZSBhdXRvbWF0aWNhbGx5LmApO1xuICAgIGlmICh0aGlzLmdsb3NzYXJ5Py5wcm90ZWN0Py5sZW5ndGgpIHtcbiAgICAgIHBhcnRzLnB1c2goYERvIE5PVCB0cmFuc2xhdGUgdGhlc2UgcHJvdGVjdGVkIHRlcm1zIChwcmVzZXJ2ZSBleGFjdCBjYXNpbmcgYW5kIHNwZWxsaW5nKTogJHt0aGlzLmdsb3NzYXJ5LnByb3RlY3Quam9pbignLCAnKX1gKTtcbiAgICB9XG4gICAgaWYgKHRoaXMuZ2xvc3Nhcnk/LnBhaXJzPy5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IHBhaXJzRGVzYyA9IHRoaXMuZ2xvc3NhcnkucGFpcnMubWFwKHAgPT4gYFwiJHtwLnNyY31cIiAtPiBcIiR7cC50Z3R9XCJgKS5qb2luKCc7ICcpO1xuICAgICAgcGFydHMucHVzaChgR2xvc3NhcnkgbWFwcGluZ3MgKGVuZm9yY2UgZXhhY3Qgb3V0cHV0IGZvciBtYXRjaGVkIHNvdXJjZSB0ZXJtcyk6ICR7cGFpcnNEZXNjfWApO1xuICAgIH1cbiAgICBwYXJ0cy5wdXNoKGBQcmVzZXJ2ZSBwdW5jdHVhdGlvbiwgbnVtYmVycywgaW5saW5lIGNvZGUsIGFuZCBVUkxzLiBEbyBub3QgYWRkIGV4cGxhbmF0aW9ucyBvciBxdW90ZXMuYCk7XG4gICAgcGFydHMucHVzaChgUmV0dXJuIGEgSlNPTiBvYmplY3Qgd2l0aCBrZXkgXCJ0XCIgY29udGFpbmluZyBhbiBhcnJheSBvZiB0cmFuc2xhdGVkIHN0cmluZ3MgaW4gdGhlIHNhbWUgb3JkZXIgYXMgaW5wdXQgdGV4dHMuYCk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHByaXZhdGUgbWFzayh0ZXh0czogc3RyaW5nW10pIHtcbiAgICBjb25zdCB0ZXJtcyA9ICh0aGlzLmdsb3NzYXJ5Py5wcm90ZWN0IHx8IFtdKS5maWx0ZXIoQm9vbGVhbikuc29ydCgoYSxiKT0+Yi5sZW5ndGgtYS5sZW5ndGgpO1xuICAgIGlmICghdGVybXMubGVuZ3RoKSByZXR1cm4geyBtYXNrZWQ6IHRleHRzLCBtYXBzOiBbXSBhcyB7dG9rZW46c3RyaW5nLCB0ZXJtOnN0cmluZ31bXVtdIH07XG4gICAgY29uc3QgbWFwczoge3Rva2VuOnN0cmluZywgdGVybTpzdHJpbmd9W11bXSA9IFtdO1xuICAgIGNvbnN0IG1hc2tlZCA9IHRleHRzLm1hcCgodCwgaWR4KSA9PiB7XG4gICAgICBsZXQgb3V0ID0gdDtcbiAgICAgIGNvbnN0IG06IHt0b2tlbjpzdHJpbmcsIHRlcm06c3RyaW5nfVtdID0gW107XG4gICAgICB0ZXJtcy5mb3JFYWNoKCh0ZXJtLCBqKSA9PiB7XG4gICAgICAgIGlmICghdGVybSkgcmV0dXJuO1xuICAgICAgICBjb25zdCB0b2tlbiA9IGBcdTAwQTdcdTAwQTdQJHtqfVx1MDBBN1x1MDBBN2A7XG4gICAgICAgIGNvbnN0IHJlID0gbmV3IFJlZ0V4cCh0ZXJtLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCAnXFxcXCQmJyksICdnaScpO1xuICAgICAgICBpZiAocmUudGVzdChvdXQpKSB7XG4gICAgICAgICAgb3V0ID0gb3V0LnJlcGxhY2UocmUsIHRva2VuKTtcbiAgICAgICAgICBtLnB1c2goeyB0b2tlbiwgdGVybSB9KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBtYXBzW2lkeF0gPSBtO1xuICAgICAgcmV0dXJuIG91dDtcbiAgICB9KTtcbiAgICByZXR1cm4geyBtYXNrZWQsIG1hcHMgfTtcbiAgfVxuICBwcml2YXRlIHVubWFzayh0ZXh0czogc3RyaW5nW10sIG1hcHM6IHt0b2tlbjpzdHJpbmcsIHRlcm06c3RyaW5nfVtdW10pIHtcbiAgICBpZiAoIW1hcHMubGVuZ3RoKSByZXR1cm4gdGV4dHM7XG4gICAgcmV0dXJuIHRleHRzLm1hcCgodCwgaSkgPT4ge1xuICAgICAgbGV0IG91dCA9IHQ7XG4gICAgICBmb3IgKGNvbnN0IG0gb2YgbWFwc1tpXSB8fCBbXSkge1xuICAgICAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAobS50b2tlbi5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgJ1xcXFwkJicpLCAnZycpO1xuICAgICAgICBvdXQgPSBvdXQucmVwbGFjZShyZSwgbS50ZXJtKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBvdXQ7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGVuZHBvaW50KCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke3RoaXMuYmFzZVVybH0vYXBpL3YxL3NlcnZpY2VzL2FpZ2MvdGV4dC1nZW5lcmF0aW9uL2dlbmVyYXRpb25gO1xuICB9XG5cbiAgYXN5bmMgdHJhbnNsYXRlQmF0Y2godGV4dHM6IHN0cmluZ1tdLCB0YXJnZXQ6IHN0cmluZywgc291cmNlPzogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIGlmICghdGhpcy5hcGlLZXkpIHtcbiAgICAgIGNvbnNvbGUud2FybignUXdlbiBBUEkga2V5IG1pc3NpbmcsIHNraXAgdHJhbnNsYXRpb24gYmF0Y2guJyk7XG4gICAgICByZXR1cm4gdGV4dHM7XG4gICAgfVxuICAgIGNvbnN0IGtleXMgPSB0ZXh0cy5tYXAodCA9PiBrZXlGb3IoKHR8fCcnKS50cmltKCksIHNvdXJjZSwgdGFyZ2V0LCAncXc6Jyt0aGlzLm1vZGVsLCB0aGlzLmdsb3NTaWcpKTtcbiAgICBjb25zdCBtZW1IaXRzID0ga2V5cy5tYXAoayA9PiBtZW1vcnlDYWNoZS5nZXQoaykpO1xuICAgIGNvbnN0IG5lZWRJZHhzOiBudW1iZXJbXSA9IFtdO1xuICAgIGZvciAobGV0IGk9MDtpPGtleXMubGVuZ3RoO2krKykgaWYgKCFtZW1IaXRzW2ldKSBuZWVkSWR4cy5wdXNoKGkpO1xuXG4gICAgbGV0IGlkYkhpdHM6IChzdHJpbmd8dW5kZWZpbmVkKVtdID0gW107XG4gICAgaWYgKG5lZWRJZHhzLmxlbmd0aCkge1xuICAgICAgY29uc3QgaWRiS2V5cyA9IG5lZWRJZHhzLm1hcChpID0+IGtleXNbaV0pO1xuICAgICAgY29uc3QgdmFscyA9IGF3YWl0IGlkYkdldE1hbnkoaWRiS2V5cyk7XG4gICAgICBpZGJIaXRzID0gbmV3IEFycmF5KGtleXMubGVuZ3RoKTtcbiAgICAgIG5lZWRJZHhzLmZvckVhY2goKGksIGopID0+IHsgaWRiSGl0c1tpXSA9IHZhbHNbal07IGlmICh2YWxzW2pdKSBtZW1vcnlDYWNoZS5zZXQoa2V5c1tpXSwgdmFsc1tqXSEpOyB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBvdXQgPSBuZXcgQXJyYXk8c3RyaW5nPih0ZXh0cy5sZW5ndGgpO1xuICAgIGZvciAobGV0IGk9MDtpPHRleHRzLmxlbmd0aDtpKyspIHtcbiAgICAgIG91dFtpXSA9IG1lbUhpdHNbaV0gfHwgaWRiSGl0c1tpXSB8fCAnJztcbiAgICB9XG5cbiAgICBjb25zdCB0b1RyYW5zbGF0ZTogeyBpbmRleDpudW1iZXIsIHRleHQ6c3RyaW5nIH1bXSA9IFtdO1xuICAgIGZvciAobGV0IGk9MDtpPHRleHRzLmxlbmd0aDtpKyspIHtcbiAgICAgIGNvbnN0IHQgPSAodGV4dHNbaV0gPz8gJycpLnRyaW0oKTtcbiAgICAgIGlmICghdCkgeyBvdXRbaV0gPSB0OyBjb250aW51ZTsgfVxuICAgICAgaWYgKCFvdXRbaV0pIHRvVHJhbnNsYXRlLnB1c2goeyBpbmRleDppLCB0ZXh0OnQgfSk7XG4gICAgfVxuICAgIGlmICghdG9UcmFuc2xhdGUubGVuZ3RoKSByZXR1cm4gb3V0O1xuXG4gICAgY29uc3QgeyBtYXNrZWQsIG1hcHMgfSA9IHRoaXMubWFzayh0b1RyYW5zbGF0ZS5tYXAoeCA9PiB4LnRleHQpKTtcblxuICAgIGNvbnN0IE1BWF9DSEFSUyA9IDYwMDA7XG4gICAgbGV0IHN0YXJ0ID0gMDtcbiAgICBjb25zdCB0b1BlcnNpc3Q6IHtrOnN0cmluZywgdjpzdHJpbmd9W10gPSBbXTtcbiAgICB3aGlsZSAoc3RhcnQgPCBtYXNrZWQubGVuZ3RoKSB7XG4gICAgICBsZXQgZW5kID0gc3RhcnQsIHN1bSA9IDA7XG4gICAgICB3aGlsZSAoZW5kIDwgbWFza2VkLmxlbmd0aCAmJiAoc3VtICsgbWFza2VkW2VuZF0ubGVuZ3RoKSA8PSBNQVhfQ0hBUlMpIHsgc3VtICs9IG1hc2tlZFtlbmRdLmxlbmd0aDsgZW5kKys7IH1cbiAgICAgIGNvbnN0IHNsaWNlID0gbWFza2VkLnNsaWNlKHN0YXJ0LCBlbmQpO1xuICAgICAgY29uc3Qgc3lzID0gdGhpcy5idWlsZFN5c3RlbVByb21wdCh0YXJnZXQsIHNvdXJjZSk7XG4gICAgICBjb25zdCB1c2VyUGF5bG9hZCA9IHsgdGFyZ2V0LCBzb3VyY2U6IHNvdXJjZSB8fCAnYXV0bycsIHRleHRzOiBzbGljZSB9O1xuICAgICAgY29uc3QgYm9keTogYW55ID0ge1xuICAgICAgICBtb2RlbDogdGhpcy5tb2RlbCxcbiAgICAgICAgaW5wdXQ6IHtcbiAgICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgICAgeyByb2xlOiAnc3lzdGVtJywgY29udGVudDogW3sgdGV4dDogc3lzIH1dIH0sXG4gICAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgY29udGVudDogW3sgdGV4dDogSlNPTi5zdHJpbmdpZnkodXNlclBheWxvYWQpIH1dIH1cbiAgICAgICAgICBdXG4gICAgICAgIH0sXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICByZXN1bHRfZm9ybWF0OiAnanNvbidcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGxldCB0cmFuc2xhdGlvbnM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG4gICAgICBsZXQgYXV0aEVycm9yID0gZmFsc2U7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2godGhpcy5lbmRwb2ludCgpLCB7XG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0aGlzLmFwaUtleX1gIH0sXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSlcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChyZXNwLnN0YXR1cyA9PT0gNDAxIHx8IHJlc3Auc3RhdHVzID09PSA0MDMpIGF1dGhFcnJvciA9IHRydWU7XG4gICAgICAgIGlmICghcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKGBRd2VuIEhUVFAgJHtyZXNwLnN0YXR1c31gKTtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpO1xuICAgICAgICBjb25zdCBtZXNzYWdlQ29udGVudCA9IGRhdGE/Lm91dHB1dD8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50O1xuICAgICAgICBsZXQgdGV4dEJsb2IgPSAnJztcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobWVzc2FnZUNvbnRlbnQpKSB7XG4gICAgICAgICAgdGV4dEJsb2IgPSBtZXNzYWdlQ29udGVudC5tYXAoKGl0ZW06IGFueSkgPT4ge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJykgcmV0dXJuIGl0ZW07XG4gICAgICAgICAgICBpZiAoaXRlbT8udGV4dCkgcmV0dXJuIGl0ZW0udGV4dDtcbiAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICB9KS5qb2luKCcnKS50cmltKCk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG1lc3NhZ2VDb250ZW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHRleHRCbG9iID0gbWVzc2FnZUNvbnRlbnQ7XG4gICAgICAgIH0gZWxzZSBpZiAobWVzc2FnZUNvbnRlbnQ/LnRleHQpIHtcbiAgICAgICAgICB0ZXh0QmxvYiA9IG1lc3NhZ2VDb250ZW50LnRleHQ7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGRhdGE/Lm91dHB1dD8udGV4dCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICB0ZXh0QmxvYiA9IGRhdGEub3V0cHV0LnRleHQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYXJyID0gcGFyc2VMTE1BcnJheSh0ZXh0QmxvYik7XG4gICAgICAgIGlmIChhcnIpIHRyYW5zbGF0aW9ucyA9IGFycjtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKCdRd2VuIGJhdGNoIHRyYW5zbGF0ZSBlcnJvcicsIGUpO1xuICAgICAgfVxuICAgICAgaWYgKCF0cmFuc2xhdGlvbnMpIHtcbiAgICAgICAgaWYgKGF1dGhFcnJvcikge1xuICAgICAgICAgIGZvciAobGV0IGo9MDtqPHNsaWNlLmxlbmd0aDtqKyspIHtcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldEluZGV4ID0gdG9UcmFuc2xhdGVbc3RhcnQgKyBqXS5pbmRleDtcbiAgICAgICAgICAgIGNvbnN0IHNyY1RleHQgPSB0b1RyYW5zbGF0ZVtzdGFydCArIGpdLnRleHQ7XG4gICAgICAgICAgICBvdXRbdGFyZ2V0SW5kZXhdID0gc3JjVGV4dDtcbiAgICAgICAgICB9XG4gICAgICAgICAgc3RhcnQgPSBlbmQ7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgdHJhbnNsYXRpb25zID0gW107XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBzbGljZSkgdHJhbnNsYXRpb25zLnB1c2goYXdhaXQgdGhpcy50cmFuc2xhdGVPbmUocywgdGFyZ2V0LCBzb3VyY2UpKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgdW5tYXNrZWQgPSB0aGlzLnVubWFzayh0cmFuc2xhdGlvbnMsIG1hcHMuc2xpY2Uoc3RhcnQsIGVuZCkpO1xuICAgICAgZm9yIChsZXQgaj0wO2o8dW5tYXNrZWQubGVuZ3RoO2orKykge1xuICAgICAgICBjb25zdCB0YXJnZXRJbmRleCA9IHRvVHJhbnNsYXRlW3N0YXJ0ICsgal0uaW5kZXg7XG4gICAgICAgIGNvbnN0IHNyY1RleHQgPSB0b1RyYW5zbGF0ZVtzdGFydCArIGpdLnRleHQ7XG4gICAgICAgIGNvbnN0IHRyID0gdW5tYXNrZWRbal0gfHwgc3JjVGV4dDtcbiAgICAgICAgb3V0W3RhcmdldEluZGV4XSA9IHRyO1xuICAgICAgICBjb25zdCBrID0ga2V5c1t0YXJnZXRJbmRleF07XG4gICAgICAgIG1lbW9yeUNhY2hlLnNldChrLCB0cik7XG4gICAgICAgIHRvUGVyc2lzdC5wdXNoKHsgaywgdjogdHIgfSk7XG4gICAgICB9XG4gICAgICB0cmltTWVtQ2FjaGUoKTtcbiAgICAgIHN0YXJ0ID0gZW5kO1xuICAgIH1cblxuICAgIGlmICh0b1BlcnNpc3QubGVuZ3RoKSBhd2FpdCBpZGJQdXRNYW55KHRvUGVyc2lzdCk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdHJhbnNsYXRlT25lKHRleHQ6IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcsIHNvdXJjZT86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgaWYgKCF0aGlzLmFwaUtleSkgcmV0dXJuIHRleHQ7XG4gICAgY29uc3Qgc3lzID0gdGhpcy5idWlsZFN5c3RlbVByb21wdCh0YXJnZXQsIHNvdXJjZSk7XG4gICAgY29uc3QgYm9keTogYW55ID0ge1xuICAgICAgbW9kZWw6IHRoaXMubW9kZWwsXG4gICAgICBpbnB1dDoge1xuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3N5c3RlbScsIGNvbnRlbnQ6IFt7IHRleHQ6IHN5cyB9XSB9LFxuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCBjb250ZW50OiBbeyB0ZXh0IH1dIH1cbiAgICAgICAgXVxuICAgICAgfVxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCh0aGlzLmVuZHBvaW50KCksIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dGhpcy5hcGlLZXl9YCB9LFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KVxuICAgICAgfSk7XG4gICAgICBpZiAoIXJlc3Aub2spIHRocm93IG5ldyBFcnJvcihgUXdlbiBIVFRQICR7cmVzcC5zdGF0dXN9YCk7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7XG4gICAgICBjb25zdCBtZXNzYWdlQ29udGVudCA9IGRhdGE/Lm91dHB1dD8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50O1xuICAgICAgaWYgKEFycmF5LmlzQXJyYXkobWVzc2FnZUNvbnRlbnQpKSB7XG4gICAgICAgIGNvbnN0IGNvbWJpbmVkID0gbWVzc2FnZUNvbnRlbnQubWFwKChwYXJ0OmFueSk9PiB0eXBlb2YgcGFydCA9PT0gJ3N0cmluZycgPyBwYXJ0IDogcGFydD8udGV4dCB8fCAnJykuam9pbignJykudHJpbSgpO1xuICAgICAgICBjb25zdCBhcnIgPSBwYXJzZUxMTUFycmF5KGNvbWJpbmVkKTtcbiAgICAgICAgaWYgKGFycj8ubGVuZ3RoKSByZXR1cm4gYXJyWzBdO1xuICAgICAgICBjb25zdCBjbGVhbmVkID0gbm9ybWFsaXplTExNVGV4dChjb21iaW5lZCk7XG4gICAgICAgIGlmIChjbGVhbmVkKSByZXR1cm4gY2xlYW5lZDtcbiAgICAgICAgcmV0dXJuIGNvbWJpbmVkIHx8IHRleHQ7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG1lc3NhZ2VDb250ZW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCBhcnIgPSBwYXJzZUxMTUFycmF5KG1lc3NhZ2VDb250ZW50KTtcbiAgICAgICAgaWYgKGFycj8ubGVuZ3RoKSByZXR1cm4gYXJyWzBdO1xuICAgICAgICBjb25zdCBjbGVhbmVkID0gbm9ybWFsaXplTExNVGV4dChtZXNzYWdlQ29udGVudCk7XG4gICAgICAgIGlmIChjbGVhbmVkKSByZXR1cm4gY2xlYW5lZDtcbiAgICAgICAgcmV0dXJuIG1lc3NhZ2VDb250ZW50IHx8IHRleHQ7XG4gICAgICB9XG4gICAgICBpZiAobWVzc2FnZUNvbnRlbnQ/LnRleHQpIHtcbiAgICAgICAgY29uc3QgYXJyID0gcGFyc2VMTE1BcnJheShtZXNzYWdlQ29udGVudC50ZXh0KTtcbiAgICAgICAgaWYgKGFycj8ubGVuZ3RoKSByZXR1cm4gYXJyWzBdO1xuICAgICAgICBjb25zdCBjbGVhbmVkID0gbm9ybWFsaXplTExNVGV4dChtZXNzYWdlQ29udGVudC50ZXh0KTtcbiAgICAgICAgaWYgKGNsZWFuZWQpIHJldHVybiBjbGVhbmVkO1xuICAgICAgICByZXR1cm4gbWVzc2FnZUNvbnRlbnQudGV4dCB8fCB0ZXh0O1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBkYXRhPy5vdXRwdXQ/LnRleHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGNvbnN0IGFyciA9IHBhcnNlTExNQXJyYXkoZGF0YS5vdXRwdXQudGV4dCk7XG4gICAgICAgIGlmIChhcnI/Lmxlbmd0aCkgcmV0dXJuIGFyclswXTtcbiAgICAgICAgY29uc3QgY2xlYW5lZCA9IG5vcm1hbGl6ZUxMTVRleHQoZGF0YS5vdXRwdXQudGV4dCk7XG4gICAgICAgIGlmIChjbGVhbmVkKSByZXR1cm4gY2xlYW5lZDtcbiAgICAgICAgcmV0dXJuIGRhdGEub3V0cHV0LnRleHQgfHwgdGV4dDtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0ZXh0O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybignUXdlbiB0cmFuc2xhdGUgZXJyb3InLCBlKTtcbiAgICAgIHJldHVybiB0ZXh0O1xuICAgIH1cbiAgfVxufVxuXG5jbGFzcyBMaWJyZVRyYW5zbGF0b3Ige1xuICBiYXNlVXJsOiBzdHJpbmc7XG4gIGFwaUtleT86IHN0cmluZztcbiAgZ2xvc1NpZzogc3RyaW5nO1xuICBnbG9zc2FyeTogR2xvc3Nhcnk7XG4gIGNvbnN0cnVjdG9yKGJhc2VVcmw6IHN0cmluZywgYXBpS2V5Pzogc3RyaW5nLCBnbG9zc2FyeT86IEdsb3NzYXJ5KSB7XG4gICAgdGhpcy5iYXNlVXJsID0gYmFzZVVybC5yZXBsYWNlKC9cXC8kLywgJycpO1xuICAgIHRoaXMuYXBpS2V5ID0gYXBpS2V5O1xuICAgIHRoaXMuZ2xvc3NhcnkgPSBnbG9zc2FyeSB8fCB7IHBhaXJzOiBbXSwgcHJvdGVjdDogW10gfTtcbiAgICB0aGlzLmdsb3NTaWcgPSBzdGFibGVIYXNoKEpTT04uc3RyaW5naWZ5KHRoaXMuZ2xvc3NhcnkpKTtcbiAgfVxuICBwcml2YXRlIG1hc2sodGV4dHM6IHN0cmluZ1tdKSB7XG4gICAgY29uc3QgdGVybXMgPSAodGhpcy5nbG9zc2FyeT8ucHJvdGVjdCB8fCBbXSkuZmlsdGVyKEJvb2xlYW4pLnNvcnQoKGEsYik9PmIubGVuZ3RoLWEubGVuZ3RoKTtcbiAgICBpZiAoIXRlcm1zLmxlbmd0aCkgcmV0dXJuIHsgbWFza2VkOiB0ZXh0cywgbWFwczogW10gYXMge3Rva2VuOnN0cmluZywgdGVybTpzdHJpbmd9W11bXSB9O1xuICAgIGNvbnN0IG1hcHM6IHt0b2tlbjpzdHJpbmcsIHRlcm06c3RyaW5nfVtdW10gPSBbXTtcbiAgICBjb25zdCBtYXNrZWQgPSB0ZXh0cy5tYXAoKHQsIGlkeCkgPT4ge1xuICAgICAgbGV0IG91dCA9IHQ7XG4gICAgICBjb25zdCBtOiB7dG9rZW46c3RyaW5nLCB0ZXJtOnN0cmluZ31bXSA9IFtdO1xuICAgICAgdGVybXMuZm9yRWFjaCgodGVybSwgaikgPT4ge1xuICAgICAgICBjb25zdCB0b2tlbiA9IGBcdTAwQTdcdTAwQTdQJHtqfVx1MDBBN1x1MDBBN2A7XG4gICAgICAgIGNvbnN0IHJlID0gbmV3IFJlZ0V4cCh0ZXJtLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCAnXFxcXCQmJyksICdnaScpO1xuICAgICAgICBpZiAocmUudGVzdChvdXQpKSB7IG91dCA9IG91dC5yZXBsYWNlKHJlLCB0b2tlbik7IG0ucHVzaCh7IHRva2VuLCB0ZXJtIH0pOyB9XG4gICAgICB9KTtcbiAgICAgIG1hcHNbaWR4XSA9IG07XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH0pO1xuICAgIHJldHVybiB7IG1hc2tlZCwgbWFwcyB9O1xuICB9XG4gIHByaXZhdGUgdW5tYXNrKHRleHRzOiBzdHJpbmdbXSwgbWFwczoge3Rva2VuOnN0cmluZywgdGVybTpzdHJpbmd9W11bXSkge1xuICAgIGlmICghbWFwcy5sZW5ndGgpIHJldHVybiB0ZXh0cztcbiAgICByZXR1cm4gdGV4dHMubWFwKCh0LCBpKSA9PiB7XG4gICAgICBsZXQgb3V0ID0gdDtcbiAgICAgIGZvciAoY29uc3QgbSBvZiBtYXBzW2ldIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IHJlID0gbmV3IFJlZ0V4cChtLnRva2VuLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCAnXFxcXCQmJyksICdnJyk7XG4gICAgICAgIG91dCA9IG91dC5yZXBsYWNlKHJlLCBtLnRlcm0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9KTtcbiAgfVxuICBhc3luYyB0cmFuc2xhdGVCYXRjaCh0ZXh0czogc3RyaW5nW10sIHRhcmdldDogc3RyaW5nLCBzb3VyY2U/OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IG5ldyBBcnJheSh0ZXh0cy5sZW5ndGgpO1xuICAgIGNvbnN0IHsgbWFza2VkLCBtYXBzIH0gPSB0aGlzLm1hc2sodGV4dHMpO1xuICAgIGZvciAobGV0IGk9MDtpPG1hc2tlZC5sZW5ndGg7aSsrKSB7XG4gICAgICBjb25zdCB0ID0gbWFza2VkW2ldO1xuICAgICAgaWYgKCF0Py50cmltKCkpIHsgb3V0W2ldID0gdDsgY29udGludWU7IH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L3RyYW5zbGF0ZWAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHE6IHQsIHNvdXJjZTogc291cmNlIHx8ICdhdXRvJywgdGFyZ2V0LCBmb3JtYXQ6ICd0ZXh0JywgYXBpX2tleTogdGhpcy5hcGlLZXkgfHwgdW5kZWZpbmVkIH0pXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXJlc3Aub2spIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3Auc3RhdHVzfWApO1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7XG4gICAgICAgIG91dFtpXSA9IGRhdGEudHJhbnNsYXRlZFRleHQgfHwgdDtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKCdMaWJyZSB0cmFuc2xhdGUgZXJyb3InLCBlKTtcbiAgICAgICAgb3V0W2ldID0gdDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudW5tYXNrKG91dCwgbWFwcyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY2hvb3NlUHJvdmlkZXIoKTogUHJvbWlzZTx7dHJhbnNsYXRlQmF0Y2g6ICh0ZXh0czpzdHJpbmdbXSwgdGFyZ2V0OnN0cmluZywgc291cmNlPzpzdHJpbmcpPT5Qcm9taXNlPHN0cmluZ1tdPiwgcHJvdmlkZXJLZXk6c3RyaW5nLCBnbG9zU2lnOnN0cmluZ30+IHtcbiAgY29uc3QgcHJlZnMgPSBhd2FpdCBnZXRQcmVmcygpO1xuICBjb25zdCBnbG9zc2FyeSA9IHByZWZzLmdsb3NzYXJ5IHx8IHsgcGFpcnM6IFtdLCBwcm90ZWN0OiBbXSB9O1xuICBjb25zdCBnbG9zU2lnID0gc3RhYmxlSGFzaChKU09OLnN0cmluZ2lmeShnbG9zc2FyeSkpO1xuICBpZiAocHJlZnMucHJvdmlkZXI/LnR5cGUgPT09ICdxd2VuJykge1xuICAgIGNvbnN0IHAgPSBwcmVmcy5wcm92aWRlciBhcyBRd2VuUHJvdmlkZXI7XG4gICAgY29uc3QgYXBpS2V5ID0gKHAuYXBpS2V5IHx8ICcnKS50cmltKCk7XG4gICAgaWYgKCFhcGlLZXkpIHtcbiAgICAgIGNvbnNvbGUud2FybignUXdlbiBwcm92aWRlciBzZWxlY3RlZCBidXQgQVBJIGtleSBpcyBlbXB0eS4gRmFsbGluZyBiYWNrIHRvIExpYnJlVHJhbnNsYXRlLicpO1xuICAgICAgY29uc3QgZmFsbGJhY2sgPSBuZXcgTGlicmVUcmFuc2xhdG9yKCdodHRwczovL2xpYnJldHJhbnNsYXRlLmNvbScsIHVuZGVmaW5lZCwgZ2xvc3NhcnkpO1xuICAgICAgcmV0dXJuIHsgdHJhbnNsYXRlQmF0Y2g6IGZhbGxiYWNrLnRyYW5zbGF0ZUJhdGNoLmJpbmQoZmFsbGJhY2spLCBwcm92aWRlcktleTogJ2xiJywgZ2xvc1NpZyB9O1xuICAgIH1cbiAgICBjb25zdCBpbnN0ID0gbmV3IFF3ZW5UcmFuc2xhdG9yKHAuYmFzZVVybCB8fCAnaHR0cHM6Ly9kYXNoc2NvcGUuYWxpeXVuY3MuY29tJywgYXBpS2V5LCBwLm1vZGVsIHx8ICdxd2VuLXR1cmJvJywgZ2xvc3NhcnkpO1xuICAgIHJldHVybiB7IHRyYW5zbGF0ZUJhdGNoOiBpbnN0LnRyYW5zbGF0ZUJhdGNoLmJpbmQoaW5zdCksIHByb3ZpZGVyS2V5OiAncXc6JytwLm1vZGVsLCBnbG9zU2lnIH07XG4gIH0gZWxzZSBpZiAocHJlZnMucHJvdmlkZXI/LnR5cGUgPT09ICdkZWVwc2VlaycpIHtcbiAgICBjb25zdCBwID0gcHJlZnMucHJvdmlkZXIgYXMgRGVlcFNlZWtQcm92aWRlcjtcbiAgICBjb25zdCBhcGlLZXkgPSAocC5hcGlLZXkgfHwgJycpLnRyaW0oKTtcbiAgICBpZiAoIWFwaUtleSkge1xuICAgICAgY29uc29sZS53YXJuKCdEZWVwU2VlayBwcm92aWRlciBzZWxlY3RlZCBidXQgQVBJIGtleSBpcyBlbXB0eS4gRmFsbGluZyBiYWNrIHRvIExpYnJlVHJhbnNsYXRlLicpO1xuICAgICAgY29uc3QgZmFsbGJhY2sgPSBuZXcgTGlicmVUcmFuc2xhdG9yKCdodHRwczovL2xpYnJldHJhbnNsYXRlLmNvbScsIHVuZGVmaW5lZCwgZ2xvc3NhcnkpO1xuICAgICAgcmV0dXJuIHsgdHJhbnNsYXRlQmF0Y2g6IGZhbGxiYWNrLnRyYW5zbGF0ZUJhdGNoLmJpbmQoZmFsbGJhY2spLCBwcm92aWRlcktleTogJ2xiJywgZ2xvc1NpZyB9O1xuICAgIH1cbiAgICBjb25zdCBpbnN0ID0gbmV3IERlZXBTZWVrVHJhbnNsYXRvcihwLmJhc2VVcmwsIGFwaUtleSwgcC5tb2RlbCB8fCAnZGVlcHNlZWstY2hhdCcsIGdsb3NzYXJ5KTtcbiAgICByZXR1cm4geyB0cmFuc2xhdGVCYXRjaDogaW5zdC50cmFuc2xhdGVCYXRjaC5iaW5kKGluc3QpLCBwcm92aWRlcktleTogJ2RzOicrcC5tb2RlbCwgZ2xvc1NpZyB9O1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHAgPSBwcmVmcy5wcm92aWRlciBhcyBMaWJyZVByb3ZpZGVyO1xuICAgIGNvbnN0IGluc3QgPSBuZXcgTGlicmVUcmFuc2xhdG9yKHAuYmFzZVVybCB8fCAnaHR0cHM6Ly9saWJyZXRyYW5zbGF0ZS5jb20nLCBwLmFwaUtleSwgZ2xvc3NhcnkpO1xuICAgIHJldHVybiB7IHRyYW5zbGF0ZUJhdGNoOiBpbnN0LnRyYW5zbGF0ZUJhdGNoLmJpbmQoaW5zdCksIHByb3ZpZGVyS2V5OiAnbGInLCBnbG9zU2lnIH07XG4gIH1cbn1cblxuLy8gLS0tLSBEZWNpc2lvbiBsb2dpYyAtLS0tXG5hc3luYyBmdW5jdGlvbiBzaG91bGRUcmFuc2xhdGUodXJsOiBzdHJpbmcsIGZhbGxiYWNrRG9jTGFuZz86IHN0cmluZywgdGFiSWQ/OiBudW1iZXIpOiBQcm9taXNlPHtvazpib29sZWFuLCB0YXJnZXRMYW5nOnN0cmluZywgc291cmNlTGFuZz86c3RyaW5nLCByZWFzb24/OnN0cmluZywgbW9kZTonYWx3YXlzJ3wnbmV2ZXInfCdhdXRvJ30+IHtcbiAgY29uc3QgcHJlZnMgPSBhd2FpdCBnZXRQcmVmcygpO1xuICBjb25zdCB1ID0gbmV3IFVSTCh1cmwpO1xuICBjb25zdCBzaXRlID0gZ2V0UmVnaXN0cmFibGVEb21haW4odS5ob3N0bmFtZSk7XG4gIGNvbnN0IG1vZGUgPSBwcmVmcy5zaXRlTW9kZXM/LltzaXRlXSB8fCAnYXV0byc7XG4gIGlmIChtb2RlID09PSAnbmV2ZXInKSByZXR1cm4geyBvazpmYWxzZSwgdGFyZ2V0TGFuZzogcHJlZnMudGFyZ2V0TGFuZywgbW9kZSwgcmVhc29uOiAnc2l0ZS1uZXZlcicgfTtcbiAgaWYgKG1vZGUgPT09ICdhbHdheXMnKSByZXR1cm4geyBvazp0cnVlLCB0YXJnZXRMYW5nOiBwcmVmcy50YXJnZXRMYW5nLCBtb2RlLCByZWFzb246ICdzaXRlLWFsd2F5cycgfTtcbiAgaWYgKCFwcmVmcy5hdXRvVHJhbnNsYXRlKSByZXR1cm4geyBvazpmYWxzZSwgdGFyZ2V0TGFuZzogcHJlZnMudGFyZ2V0TGFuZywgbW9kZSwgcmVhc29uOiAnYXV0by1vZmYnIH07XG5cbiAgbGV0IHBhZ2VMYW5nOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG4gIHRyeSB7IHBhZ2VMYW5nID0gYXdhaXQgdGFic0RldGVjdExhbmd1YWdlKHRhYklkKTsgfSBjYXRjaCB7fVxuICBpZiAoIXBhZ2VMYW5nKSBwYWdlTGFuZyA9IGZhbGxiYWNrRG9jTGFuZztcbiAgaWYgKCFwYWdlTGFuZykgcGFnZUxhbmcgPSBkZXRlY3RCeUhldXJpc3RpYyh1LnBhdGhuYW1lICsgJyAnICsgdS5ob3N0bmFtZSk7XG4gIGlmICghcGFnZUxhbmcpIHBhZ2VMYW5nID0gJ2VuJztcblxuICBjb25zdCB0YXJnZXQgPSAocHJlZnMudGFyZ2V0TGFuZyB8fCAnZW4nKS5zcGxpdCgnLScpWzBdO1xuICBjb25zdCBzb3VyY2UgPSAocGFnZUxhbmcgfHwgJ2VuJykuc3BsaXQoJy0nKVswXTtcbiAgaWYgKHRhcmdldCA9PT0gc291cmNlKSByZXR1cm4geyBvazpmYWxzZSwgdGFyZ2V0TGFuZzogdGFyZ2V0LCBzb3VyY2VMYW5nOiBzb3VyY2UsIG1vZGUsIHJlYXNvbjogJ3NhbWUtbGFuZycgfTtcbiAgcmV0dXJuIHsgb2s6dHJ1ZSwgdGFyZ2V0TGFuZzogdGFyZ2V0LCBzb3VyY2VMYW5nOiBzb3VyY2UsIG1vZGUsIHJlYXNvbjogJ2RpZmYtbGFuZycgfTtcbn1cblxuLy8gLS0tLSBNZXNzYWdpbmcgLS0tLVxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtc2c6IE1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIChhc3luYyAoKSA9PiB7XG4gICAgaWYgKG1zZy50eXBlID09PSAnR0VUX1BSRUZTJykge1xuICAgICAgY29uc3QgcHJlZnMgPSBhd2FpdCBnZXRQcmVmcygpO1xuICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUsIHByZWZzIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09ICdTRVRfU0lURV9QUkVGJykge1xuICAgICAgYXdhaXQgc2V0U2l0ZVByZWYobXNnLnNpdGUsIG1zZy5tb2RlKTtcbiAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobXNnLnR5cGUgPT09ICdJTklUJykge1xuICAgICAgY29uc3QgZGVjaXNpb24gPSBhd2FpdCBzaG91bGRUcmFuc2xhdGUobXNnLnVybCwgbXNnLmRvY0xhbmcsIHNlbmRlci50YWI/LmlkKTtcbiAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlLCBkZWNpc2lvbiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSAnVFJBTlNMQVRFX0JBVENIJykge1xuICAgICAgY29uc3QgeyB0cmFuc2xhdGVCYXRjaCB9ID0gYXdhaXQgY2hvb3NlUHJvdmlkZXIoKTtcbiAgICAgIGNvbnN0IG91dCA9IGF3YWl0IHRyYW5zbGF0ZUJhdGNoKG1zZy50ZXh0cywgbXNnLnRhcmdldExhbmcsIG1zZy5zb3VyY2VMYW5nKTtcbiAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlLCByZXN1bHQ6IG91dCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG1zZy50eXBlID09PSAnTUVUUklDJykge1xuICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9KSgpO1xuICByZXR1cm4gdHJ1ZTtcbn0pO1xuXG5jaHJvbWUuY29tbWFuZHM/Lm9uQ29tbWFuZD8uYWRkTGlzdGVuZXIoYXN5bmMgKGNtZCkgPT4ge1xuICBpZiAoY21kICE9PSAndG9nZ2xlLXRyYW5zbGF0aW9uJykgcmV0dXJuO1xuICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCBjdXJyZW50V2luZG93OiB0cnVlIH0pO1xuICBpZiAoIXRhYj8uaWQpIHJldHVybjtcbiAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICdUT0dHTEVfVFJBTlNMQVRJT04nIH0sICgpID0+IHtcbiAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ3RvZ2dsZS10cmFuc2xhdGlvbiBjb21tYW5kIGRpc3BhdGNoIGZhaWxlZCcsIGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcik7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5cbi8vIC0tLS0gQ29udGV4dCBNZW51cyAoaG90IGdsb3NzYXJ5IGFkZCkgLS0tLVxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQ/LmFkZExpc3RlbmVyKCgpID0+IHtcbiAgdHJ5IHtcbiAgICBjaHJvbWUuY29udGV4dE1lbnVzLmNyZWF0ZSh7IGlkOiAnYXV0b3RyYW5zX2FkZF9wcm90ZWN0JywgdGl0bGU6ICdcdTUyQTBcdTUxNjVcdTRFMERcdTdGRkJcdThCRDFcdThCQ0RcdUZGMDhcdTkwMDlcdTRFMkRcdTY1ODdcdTY3MkNcdUZGMDknLCBjb250ZXh0czogWydzZWxlY3Rpb24nXSB9KTtcbiAgICBjaHJvbWUuY29udGV4dE1lbnVzLmNyZWF0ZSh7IGlkOiAnYXV0b3RyYW5zX2FkZF9wYWlyJywgdGl0bGU6ICdcdTUyQTBcdTUxNjVcdTY3MkZcdThCRURcdTg4NjhcdUZGMDhcdTZFOTBcdThCRUQ9XHU3NkVFXHU2ODA3XHVGRjA5JywgY29udGV4dHM6IFsnc2VsZWN0aW9uJ10gfSk7XG4gIH0gY2F0Y2gge31cbn0pO1xuXG5jaHJvbWUuY29udGV4dE1lbnVzPy5vbkNsaWNrZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGluZm8sIHRhYikgPT4ge1xuICBpZiAoIXRhYj8uaWQpIHJldHVybjtcbiAgY29uc3Qgc2VsZWN0aW9uID0gKGluZm8uc2VsZWN0aW9uVGV4dCB8fCAnJykudHJpbSgpO1xuICBpZiAoIXNlbGVjdGlvbikgcmV0dXJuO1xuICBjb25zdCBwcmVmcyA9IGF3YWl0IGdldFByZWZzKCk7XG4gIGlmIChpbmZvLm1lbnVJdGVtSWQgPT09ICdhdXRvdHJhbnNfYWRkX3Byb3RlY3QnKSB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChbLi4uKHByZWZzLmdsb3NzYXJ5Py5wcm90ZWN0IHx8IFtdKV0pO1xuICAgIHNldC5hZGQoc2VsZWN0aW9uKTtcbiAgICBwcmVmcy5nbG9zc2FyeSA9IHByZWZzLmdsb3NzYXJ5IHx8IHsgcGFpcnM6IFtdLCBwcm90ZWN0OiBbXSB9O1xuICAgIHByZWZzLmdsb3NzYXJ5LnByb3RlY3QgPSBBcnJheS5mcm9tKHNldCk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgcHJlZnMgfSwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICdUT0FTVCcsIG1lc3NhZ2U6IGBcdTVERjJcdTUyQTBcdTUxNjVcdTRFMERcdTdGRkJcdThCRDFcdThCQ0RcdUZGMUEke3NlbGVjdGlvbn1gIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoaW5mby5tZW51SXRlbUlkID09PSAnYXV0b3RyYW5zX2FkZF9wYWlyJykge1xuICAgIC8vIEFzayBmb3IgdGFyZ2V0IHRyYW5zbGF0aW9uIHZpYSBwYWdlIHByb21wdCB0byBhdm9pZCBleHRlbnNpb24gVUlcbiAgICBjb25zdCBbeyByZXN1bHQgfV0gPSBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgdGFyZ2V0OiB7IHRhYklkOiB0YWIuaWQgfSxcbiAgICAgIGZ1bmM6IChzZWwpID0+IHtcbiAgICAgICAgLy8gcnVuIGluIHBhZ2Ugd29ybGRcbiAgICAgICAgdHJ5IHsgcmV0dXJuIHByb21wdCgnXHU4QkY3XHU4RjkzXHU1MTY1XHUyMDFDXHU2NzJGXHU4QkVEXHU3RkZCXHU4QkQxXHUyMDFEXHU3Njg0XHU3NkVFXHU2ODA3XHU2NTg3XHU2NzJDXHVGRjFBJywgc2VsKSB8fCAnJzsgfVxuICAgICAgICBjYXRjaCB7IHJldHVybiAnJzsgfVxuICAgICAgfSxcbiAgICAgIGFyZ3M6IFtzZWxlY3Rpb25dXG4gICAgfSk7XG4gICAgY29uc3QgdGd0ID0gKHJlc3VsdCB8fCAnJykudHJpbSgpO1xuICAgIGlmICghdGd0KSB7IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgeyB0eXBlOiAnVE9BU1QnLCBtZXNzYWdlOiAnXHU1REYyXHU1M0Q2XHU2RDg4XHU2REZCXHU1MkEwXHU2NzJGXHU4QkVEJyB9KTsgcmV0dXJuOyB9XG4gICAgY29uc3QgcGFpcnMgPSAocHJlZnMuZ2xvc3Nhcnk/LnBhaXJzIHx8IFtdKS5maWx0ZXIocCA9PiBwLnNyYyAhPT0gc2VsZWN0aW9uKTtcbiAgICBwYWlycy5wdXNoKHsgc3JjOiBzZWxlY3Rpb24sIHRndCB9KTtcbiAgICBwcmVmcy5nbG9zc2FyeSA9IHByZWZzLmdsb3NzYXJ5IHx8IHsgcGFpcnM6IFtdLCBwcm90ZWN0OiBbXSB9O1xuICAgIHByZWZzLmdsb3NzYXJ5LnBhaXJzID0gcGFpcnM7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgcHJlZnMgfSwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICdUT0FTVCcsIG1lc3NhZ2U6IGBcdTVERjJcdTUyQTBcdTUxNjVcdTY3MkZcdThCRURcdUZGMUEke3NlbGVjdGlvbn0gXHUyMTkyICR7dGd0fWAgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQWlDQSxJQUFNLGVBQWUsTUFBTTtBQUN6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
