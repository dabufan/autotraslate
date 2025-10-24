import { getRegistrableDomain } from '../shared/site';

// AutoTranslate MVP - content script
type Decision = { ok:boolean, targetLang:string, sourceLang?:string, reason?:string, mode:'always'|'never'|'auto' };

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

  translating: false,
  site: ''
};

const translateQueue: Text[] = [];
let queued = new WeakSet<Text>();
let flushScheduled = false;
const drainResolvers: Array<() => void> = [];

const intersection = {
  observer: null as IntersectionObserver | null,
  pending: new Map<Element, Set<Text>>()
};

const scheduleTask: (fn: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn) => Promise.resolve().then(fn);

function post<T=any, R=any>(msg: T): Promise<R> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (res:R) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(res);
      });
    } catch (err) {
      reject(err);
    }
  });
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

function resolveDrainResolvers() {
  while (drainResolvers.length) {
    const resolver = drainResolvers.shift();
    try { resolver?.(); } catch {}
  }
}

function waitForQueueDrain(): Promise<void> {
  if (!state.translating && translateQueue.length === 0) return Promise.resolve();
  return new Promise((resolve) => drainResolvers.push(resolve));
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

const BATCH_SIZE = 60;

function enqueueForTranslation(nodes: Text[]): boolean {
  let added = false;
  for (const node of nodes) {
    if (!node) continue;
    if (state.processed.has(node) || queued.has(node)) continue;
    const text = (node.nodeValue || '').trim();
    if (!text) continue;
    translateQueue.push(node);
    queued.add(node);
    added = true;
  }
  if (added) {
    startPendingIndicator();
    scheduleFlush();
  }
  return added;
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  scheduleTask(() => {
    flushQueue().catch((err) => console.warn('flushQueue error', err));
  });
}

async function flushQueue() {
  if (state.translating) {
    flushScheduled = false;
    return;
  }
  flushScheduled = false;
  state.translating = true;
  try {
    while (translateQueue.length) {
      const chunkNodes: Text[] = [];
      const texts: string[] = [];
      while (chunkNodes.length < BATCH_SIZE && translateQueue.length) {
        const candidate = translateQueue.shift()!;
        queued.delete(candidate);
        if (!candidate.isConnected) continue;
        if (state.processed.has(candidate)) continue;
        const text = (candidate.nodeValue || '').trim();
        if (!text) {
          state.processed.add(candidate);
          continue;
        }
        chunkNodes.push(candidate);
        texts.push(text);
      }
      if (!chunkNodes.length) continue;
      let out: string[] = texts;
      try {
        out = await translateBatch(texts, state.decision!.targetLang, state.decision!.sourceLang);
      } catch (err) {
        console.warn('Translation batch failed', err);
        translateQueue.length = 0;
        queued = new WeakSet<Text>();
      }
      applyTranslations(chunkNodes, out);
      chunkNodes.forEach((n) => state.processed.add(n));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    state.translating = false;
    if (translateQueue.length) {
      scheduleFlush();
      return;
    }
    stopPendingIndicator();
    resolveDrainResolvers();
  }
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
  if (visible.length) await doTranslateBatched(visible, true);
  // Observe the rest for when they enter viewport
  queueIntersectionObservation(hidden);
}

async function doTranslateBatched(nodes: Text[], awaitCompletion = false) {
  enqueueForTranslation(nodes);
  if (awaitCompletion) {
    await waitForQueueDrain();
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
      queueIntersectionObservation(added);
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
    const site = getRegistrableDomain(location.hostname);
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


function ensureIntersectionObserver(): IntersectionObserver {
  if (intersection.observer) return intersection.observer;
  intersection.observer = new IntersectionObserver((entries) => {
    const toTranslate: Text[] = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target as Element;
      const set = intersection.pending.get(target);
      if (!set) {
        intersection.observer?.unobserve(target);
        continue;
      }
      intersection.pending.delete(target);
      set.forEach((node) => {
        if (state.processed.has(node)) return;
        toTranslate.push(node);
      });
      intersection.observer?.unobserve(target);
    }
    if (toTranslate.length) enqueueForTranslation(toTranslate);
  }, { root: null, rootMargin: '128px', threshold: 0 });
  return intersection.observer;
}

function queueIntersectionObservation(candidates: Text[]) {
  if (!candidates.length) return;
  const obs = ensureIntersectionObserver();
  for (const node of candidates) {
    if (!node || !node.isConnected) continue;
    if (state.processed.has(node)) continue;
    const el = node.parentElement;
    if (!el) continue;
    let set = intersection.pending.get(el);
    if (!set) {
      set = new Set<Text>();
      intersection.pending.set(el, set);
    }
    set.add(node);
    obs.observe(el);
  }
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
