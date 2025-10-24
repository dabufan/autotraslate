// AutoTranslate MVP - content script
type Decision = { ok:boolean, targetLang:string, sourceLang?:string, reason?:string, mode:'always'|'never'|'auto' };

const MULTI_PART_SUFFIXES = new Set([
  'co.uk','org.uk','gov.uk','ac.uk',
  'com.au','net.au','org.au',
  'co.jp','ne.jp','or.jp',
  'com.br','com.cn','com.hk','com.sg','com.tw','com.tr','com.mx','com.ar','com.co','com.pe','com.ph',
  'co.in','co.kr','co.za'
]);

function getSite(hostname: string): string {
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

function isVisible(node: Text): boolean {
  const el = node.parentElement;
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  // basic intersection check with viewport
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
}


const state = {
  enabled: false,
  translated: false,
  decision: null as Decision | null,
  originalMap: new WeakMap<Text, string>(),
  processed: new WeakSet<Text>(),
  observer: null as IntersectionObserver | null,

  translating: false,
  site: ''
};

const translateQueue: Text[] = [];
const queued = new WeakSet<Text>();

function post<T=any, R=any>(msg: T): Promise<R> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res:R) => resolve(res)));
}

function setPendingAttr(pending: boolean) {
  try {
    if (pending) document.documentElement.setAttribute('data-autotrans','pending');
    else document.documentElement.removeAttribute('data-autotrans');
  } catch {}
}

let pendingTimer: number | null = null;
let pendingApplied = false;
function startPendingIndicator() {
  if (pendingApplied || pendingTimer != null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    pendingApplied = true;
    setPendingAttr(true);
  }, 200);
}
function stopPendingIndicator() {
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (pendingApplied) {
    pendingApplied = false;
    setPendingAttr(false);
  }
}

function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName.toLowerCase();
      if (['script','style','noscript','code','pre','kbd','samp','textarea','input'].includes(tag)) return NodeFilter.FILTER_REJECT;
      const s = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (s.length < 2) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

async function translateBatch(texts: string[], targetLang: string, sourceLang?: string): Promise<string[]> {
  const res = await post({ type: 'TRANSLATE_BATCH', texts, targetLang, sourceLang }) as any;
  return res?.result || texts;
}

function applyTranslations(nodes: Text[], translated: string[]) {
  for (let i=0;i<nodes.length;i++) {
    const node = nodes[i];
    const orig = node.nodeValue || '';
    if (!state.originalMap.has(node)) state.originalMap.set(node, orig);
    node.nodeValue = translated[i];
  }
}

function restoreOriginal(nodes: Text[]) {
  for (const node of nodes) {
    const orig = state.originalMap.get(node);
    if (orig != null) node.nodeValue = orig;
  }
}

function mountToggle() {
  if (document.getElementById('autotranslate-toggle')) return;
  const btn = document.createElement('button');
  btn.id = 'autotranslate-toggle';
  btn.dataset.state = state.translated ? 'on' : 'off';
  btn.innerHTML = `<span class="dot"></span><span class="label"></span>`;
  const label = () => btn.querySelector('.label')!.textContent = state.translated ? '已译为目标语言（Ctrl+Shift+T 切换）' : '原文显示（Ctrl+Shift+T 切换）';
  label();
  btn.addEventListener('click', () => toggleNow());
  document.documentElement.appendChild(btn);
  const observer = new MutationObserver(() => {
    const parent = btn.parentElement;
    if (!parent) {
      document.documentElement.appendChild(btn);
      return;
    }
    const last = document.documentElement.lastElementChild;
    if (last !== btn) {
      document.documentElement.appendChild(btn);
    }
  });
  observer.observe(document.documentElement, { childList: true });
  return () => {
    observer.disconnect();
    btn.remove();
  };
}

async function toggleNow() {
  const nodes = collectTextNodes(document.body);
  if (state.translated) {
    restoreOriginal(nodes);
    state.translated = false;
  } else {
    await doTranslate(nodes);
    state.translated = true;
  }
  const btn = document.getElementById('autotranslate-toggle');
  if (btn) {
    btn.setAttribute('data-state', state.translated ? 'on' : 'off');
    const label = btn.querySelector('.label')!;
    label.textContent = state.translated ? '已译为目标语言（Ctrl+Shift+T 切换）' : '原文显示（Ctrl+Shift+T 切换）';
  }
}

async function doTranslate(nodes: Text[]) {
  // split: visible first
  const visible: Text[] = [];
  const hidden: Text[] = [];
  for (const n of nodes) {
    if (state.processed.has(n)) continue;
    (isVisible(n) ? visible : hidden).push(n);
  }
  if (visible.length) await doTranslateBatched(visible);
  // Observe the rest for when they enter viewport
  setupIntersectionObserver(hidden);
}

async function doTranslateBatched(nodes: Text[]) {
  for (const node of nodes) {
    if (!node || state.processed.has(node) || queued.has(node)) continue;
    translateQueue.push(node);
    queued.add(node);
  }
  if (state.translating) return;
  state.translating = true;
  try {
    const BATCH = 60; // number of text nodes per call
    while (translateQueue.length) {
      const chunkNodes: Text[] = [];
      while (chunkNodes.length < BATCH && translateQueue.length) {
        const candidate = translateQueue.shift()!;
        queued.delete(candidate);
        if (state.processed.has(candidate)) continue;
        if (!candidate.isConnected) continue;
        chunkNodes.push(candidate);
      }
      if (!chunkNodes.length) continue;
      const texts = chunkNodes.map(n => (n.nodeValue || '').trim());
      const out = await translateBatch(texts, state.decision!.targetLang, state.decision!.sourceLang);
      applyTranslations(chunkNodes, out);
      stopPendingIndicator();
      chunkNodes.forEach(n => state.processed.add(n));
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    state.translating = false;
  }
}

function observeMutations() {
  const obs = new MutationObserver(async (mutations) => {
    if (!state.translated) return;
    const added: Text[] = [];
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(n => {
          if (n.nodeType === Node.TEXT_NODE) added.push(n as Text);
          else if (n.nodeType === Node.ELEMENT_NODE) added.push(...collectTextNodes(n));
        });
      } else if (m.type === 'characterData') {
        added.push(m.target as Text);
      }
    }
    if (added.length) {
      setupIntersectionObserver(added);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      toggleNow();
    }
  }, { capture: true });
}

(async function main() {
  try {
    const url = location.href;
    const site = getSite(location.hostname);
    state.site = site;
    startPendingIndicator();
    const res = await post({ type: 'INIT', url, docLang: document.documentElement.lang || undefined, site }) as any;
    const decision: Decision = res?.decision || { ok:false, targetLang:'en', mode:'auto' };
    state.decision = decision;
    mountToggle();
    bindKeyboard();

    if (decision.ok) {
      const nodes = collectTextNodes(document.body);
      await doTranslate(nodes);
      state.translated = true;
      observeMutations();
    }
  } catch (e) {
    // fail open
    console.warn('AutoTranslate error', e);
  } finally {
    stopPendingIndicator();
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SITE_MODE_CHANGED') {
    const btn = document.getElementById('autotranslate-toggle');
    if (!btn) return;
    btn.setAttribute('title', `站点模式已切到：${msg.mode}`);
  }
  if (msg?.type === 'TOGGLE_TRANSLATION') {
    toggleNow().catch((err) => console.warn('Toggle translation error', err));
  }
});


function setupIntersectionObserver(candidates: Text[]) {
  try { state.observer?.disconnect(); } catch {}
  if (!candidates.length) return;
  const map = new Map<Element, Text[]>();
  for (const t of candidates) {
    const el = t.parentElement; if (!el) continue;
    const arr = map.get(el) || [];
    arr.push(t);
    map.set(el, arr);
  }
  const obs = new IntersectionObserver(async (entries) => {
    const toTranslate: Text[] = [];
    for (const e of entries) {
      if (e.isIntersecting) {
        const arr = map.get(e.target as Element) || [];
        for (const t of arr) if (!state.processed.has(t)) toTranslate.push(t);
        obs.unobserve(e.target);
      }
    }
    if (toTranslate.length) await doTranslateBatched(toTranslate);
  }, { root: null, rootMargin: '128px', threshold: 0 });
  map.forEach((_, el) => { obs.observe(el); });
  state.observer = obs;
}


function showToast(msg: string) {
  const id = 'autotranslate-toast';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('style','position:fixed;bottom:56px;right:16px;z-index:2147483647;background:#111;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;opacity:0.92;box-shadow:0 6px 24px rgba(0,0,0,.2)');
    document.documentElement.appendChild(el);
  }
  el.textContent = msg;
  el.animate([{opacity:0},{opacity:0.92}],{duration:120,fill:'forwards'});
  setTimeout(() => {
    el?.animate([{opacity:0.92},{opacity:0}],{duration:220,fill:'forwards'}).addEventListener('finish',()=> el?.remove());
  }, 1800);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOAST' && typeof msg.message === 'string') showToast(msg.message);
});
