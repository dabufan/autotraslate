"use strict";
var AutoTranslateContent = (() => {
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

  // src/content/contentScript.ts
  function isVisible(node) {
    const el = node.parentElement;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
  }
  var state = {
    enabled: false,
    translated: false,
    decision: null,
    originalMap: /* @__PURE__ */ new WeakMap(),
    processed: /* @__PURE__ */ new WeakSet(),
    translating: false,
    site: ""
  };
  var translateQueue = [];
  var queued = /* @__PURE__ */ new WeakSet();
  var flushScheduled = false;
  var drainResolvers = [];
  var intersection = {
    observer: null,
    pending: /* @__PURE__ */ new Map()
  };
  var scheduleTask = typeof queueMicrotask === "function" ? queueMicrotask : (fn) => Promise.resolve().then(fn);
  function post(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
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
  function setPendingAttr(pending) {
    try {
      if (pending) document.documentElement.setAttribute("data-autotrans", "pending");
      else document.documentElement.removeAttribute("data-autotrans");
    } catch {
    }
  }
  var pendingTimer = null;
  var pendingApplied = false;
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
      try {
        resolver?.();
      } catch {
      }
    }
  }
  function waitForQueueDrain() {
    if (!state.translating && translateQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainResolvers.push(resolve));
  }
  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName.toLowerCase();
        if (["script", "style", "noscript", "code", "pre", "kbd", "samp", "textarea", "input"].includes(tag)) return NodeFilter.FILTER_REJECT;
        const s = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (s.length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while (n = walker.nextNode()) out.push(n);
    return out;
  }
  var BATCH_SIZE = 60;
  function enqueueForTranslation(nodes) {
    let added = false;
    for (const node of nodes) {
      if (!node) continue;
      if (state.processed.has(node) || queued.has(node)) continue;
      const text = (node.nodeValue || "").trim();
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
      flushQueue().catch((err) => console.warn("flushQueue error", err));
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
        const chunkNodes = [];
        const texts = [];
        while (chunkNodes.length < BATCH_SIZE && translateQueue.length) {
          const candidate = translateQueue.shift();
          queued.delete(candidate);
          if (!candidate.isConnected) continue;
          if (state.processed.has(candidate)) continue;
          const text = (candidate.nodeValue || "").trim();
          if (!text) {
            state.processed.add(candidate);
            continue;
          }
          chunkNodes.push(candidate);
          texts.push(text);
        }
        if (!chunkNodes.length) continue;
        let out = texts;
        try {
          out = await translateBatch(texts, state.decision.targetLang, state.decision.sourceLang);
        } catch (err) {
          console.warn("Translation batch failed", err);
          translateQueue.length = 0;
          queued = /* @__PURE__ */ new WeakSet();
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
  async function translateBatch(texts, targetLang, sourceLang) {
    const res = await post({ type: "TRANSLATE_BATCH", texts, targetLang, sourceLang });
    return res?.result || texts;
  }
  function applyTranslations(nodes, translated) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const orig = node.nodeValue || "";
      if (!state.originalMap.has(node)) state.originalMap.set(node, orig);
      node.nodeValue = translated[i];
    }
  }
  function restoreOriginal(nodes) {
    for (const node of nodes) {
      const orig = state.originalMap.get(node);
      if (orig != null) node.nodeValue = orig;
    }
  }
  function mountToggle() {
    if (document.getElementById("autotranslate-toggle")) return;
    const btn = document.createElement("button");
    btn.id = "autotranslate-toggle";
    btn.dataset.state = state.translated ? "on" : "off";
    btn.innerHTML = `<span class="dot"></span><span class="label"></span>`;
    const label = () => btn.querySelector(".label").textContent = state.translated ? "\u5DF2\u8BD1\u4E3A\u76EE\u6807\u8BED\u8A00\uFF08Ctrl+Shift+T \u5207\u6362\uFF09" : "\u539F\u6587\u663E\u793A\uFF08Ctrl+Shift+T \u5207\u6362\uFF09";
    label();
    btn.addEventListener("click", () => toggleNow());
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
    const btn = document.getElementById("autotranslate-toggle");
    if (btn) {
      btn.setAttribute("data-state", state.translated ? "on" : "off");
      const label = btn.querySelector(".label");
      label.textContent = state.translated ? "\u5DF2\u8BD1\u4E3A\u76EE\u6807\u8BED\u8A00\uFF08Ctrl+Shift+T \u5207\u6362\uFF09" : "\u539F\u6587\u663E\u793A\uFF08Ctrl+Shift+T \u5207\u6362\uFF09";
    }
  }
  async function doTranslate(nodes) {
    const visible = [];
    const hidden = [];
    for (const n of nodes) {
      if (state.processed.has(n)) continue;
      (isVisible(n) ? visible : hidden).push(n);
    }
    if (visible.length) await doTranslateBatched(visible, true);
    queueIntersectionObservation(hidden);
  }
  async function doTranslateBatched(nodes, awaitCompletion = false) {
    enqueueForTranslation(nodes);
    if (awaitCompletion) {
      await waitForQueueDrain();
    }
  }
  function observeMutations() {
    const obs = new MutationObserver(async (mutations) => {
      if (!state.translated) return;
      const added = [];
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) added.push(n);
            else if (n.nodeType === Node.ELEMENT_NODE) added.push(...collectTextNodes(n));
          });
        } else if (m.type === "characterData") {
          added.push(m.target);
        }
      }
      if (added.length) {
        queueIntersectionObservation(added);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  function bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === "t" || e.key === "T")) {
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
      const res = await post({ type: "INIT", url, docLang: document.documentElement.lang || void 0, site });
      const decision = res?.decision || { ok: false, targetLang: "en", mode: "auto" };
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
      console.warn("AutoTranslate error", e);
    } finally {
      stopPendingIndicator();
    }
  })();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SITE_MODE_CHANGED") {
      const btn = document.getElementById("autotranslate-toggle");
      if (!btn) return;
      btn.setAttribute("title", `\u7AD9\u70B9\u6A21\u5F0F\u5DF2\u5207\u5230\uFF1A${msg.mode}`);
    }
    if (msg?.type === "TOGGLE_TRANSLATION") {
      toggleNow().catch((err) => console.warn("Toggle translation error", err));
    }
  });
  function ensureIntersectionObserver() {
    if (intersection.observer) return intersection.observer;
    intersection.observer = new IntersectionObserver((entries) => {
      const toTranslate = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
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
    }, { root: null, rootMargin: "128px", threshold: 0 });
    return intersection.observer;
  }
  function queueIntersectionObservation(candidates) {
    if (!candidates.length) return;
    const obs = ensureIntersectionObserver();
    for (const node of candidates) {
      if (!node || !node.isConnected) continue;
      if (state.processed.has(node)) continue;
      const el = node.parentElement;
      if (!el) continue;
      let set = intersection.pending.get(el);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        intersection.pending.set(el, set);
      }
      set.add(node);
      obs.observe(el);
    }
  }
  function showToast(msg) {
    const id = "autotranslate-toast";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("style", "position:fixed;bottom:56px;right:16px;z-index:2147483647;background:#111;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;opacity:0.92;box-shadow:0 6px 24px rgba(0,0,0,.2)");
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.animate([{ opacity: 0 }, { opacity: 0.92 }], { duration: 120, fill: "forwards" });
    setTimeout(() => {
      el?.animate([{ opacity: 0.92 }, { opacity: 0 }], { duration: 220, fill: "forwards" }).addEventListener("finish", () => el?.remove());
    }, 1800);
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOAST" && typeof msg.message === "string") showToast(msg.message);
  });
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NoYXJlZC9zaXRlLnRzIiwgIi4uLy4uL3NyYy9jb250ZW50L2NvbnRlbnRTY3JpcHQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IE1VTFRJX1BBUlRfU1VGRklYRVMgPSBuZXcgU2V0KFtcbiAgJ2NvLnVrJywgJ29yZy51aycsICdnb3YudWsnLCAnYWMudWsnLFxuICAnY29tLmF1JywgJ25ldC5hdScsICdvcmcuYXUnLFxuICAnY28uanAnLCAnbmUuanAnLCAnb3IuanAnLFxuICAnY29tLmJyJywgJ2NvbS5jbicsICdjb20uaGsnLCAnY29tLnNnJywgJ2NvbS50dycsICdjb20udHInLCAnY29tLm14JywgJ2NvbS5hcicsICdjb20uY28nLCAnY29tLnBlJywgJ2NvbS5waCcsXG4gICdjby5pbicsICdjby5rcicsICdjby56YSdcbl0pO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVnaXN0cmFibGVEb21haW4oaG9zdG5hbWU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWhvc3RuYW1lKSByZXR1cm4gJyc7XG4gIGNvbnN0IHJhd1BhcnRzID0gaG9zdG5hbWUuc3BsaXQoJy4nKS5maWx0ZXIoQm9vbGVhbik7XG4gIGlmIChyYXdQYXJ0cy5sZW5ndGggPD0gMikgcmV0dXJuIGhvc3RuYW1lO1xuICBjb25zdCBwYXJ0cyA9IHJhd1BhcnRzLm1hcCgocCkgPT4gcC50b0xvd2VyQ2FzZSgpKTtcbiAgZm9yIChjb25zdCBzdWZmaXggb2YgTVVMVElfUEFSVF9TVUZGSVhFUykge1xuICAgIGNvbnN0IHN1ZmZpeFBhcnRzID0gc3VmZml4LnNwbGl0KCcuJyk7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IHN1ZmZpeFBhcnRzLmxlbmd0aCkge1xuICAgICAgY29uc3QgdGFpbCA9IHBhcnRzLnNsaWNlKC1zdWZmaXhQYXJ0cy5sZW5ndGgpLmpvaW4oJy4nKTtcbiAgICAgIGlmICh0YWlsID09PSBzdWZmaXgpIHtcbiAgICAgICAgcmV0dXJuIHJhd1BhcnRzLnNsaWNlKC0oc3VmZml4UGFydHMubGVuZ3RoICsgMSkpLmpvaW4oJy4nKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJhd1BhcnRzLnNsaWNlKC0yKS5qb2luKCcuJyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTaXRlRnJvbVVybChyYXdVcmw/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXJhd1VybCkgcmV0dXJuICcnO1xuICB0cnkge1xuICAgIGNvbnN0IHUgPSBuZXcgVVJMKHJhd1VybCk7XG4gICAgcmV0dXJuIGdldFJlZ2lzdHJhYmxlRG9tYWluKHUuaG9zdG5hbWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gJyc7XG4gIH1cbn1cblxuZXhwb3J0IHsgTVVMVElfUEFSVF9TVUZGSVhFUyB9O1xuIiwgImltcG9ydCB7IGdldFJlZ2lzdHJhYmxlRG9tYWluIH0gZnJvbSAnLi4vc2hhcmVkL3NpdGUnO1xuXG4vLyBBdXRvVHJhbnNsYXRlIE1WUCAtIGNvbnRlbnQgc2NyaXB0XG50eXBlIERlY2lzaW9uID0geyBvazpib29sZWFuLCB0YXJnZXRMYW5nOnN0cmluZywgc291cmNlTGFuZz86c3RyaW5nLCByZWFzb24/OnN0cmluZywgbW9kZTonYWx3YXlzJ3wnbmV2ZXInfCdhdXRvJyB9O1xuXG5mdW5jdGlvbiBpc1Zpc2libGUobm9kZTogVGV4dCk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGlmIChyZWN0LndpZHRoID09PSAwIHx8IHJlY3QuaGVpZ2h0ID09PSAwKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHZ3ID0gd2luZG93LmlubmVyV2lkdGggfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICBjb25zdCB2aCA9IHdpbmRvdy5pbm5lckhlaWdodCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50SGVpZ2h0O1xuICAvLyBiYXNpYyBpbnRlcnNlY3Rpb24gY2hlY2sgd2l0aCB2aWV3cG9ydFxuICByZXR1cm4gcmVjdC5ib3R0b20gPj0gMCAmJiByZWN0LnJpZ2h0ID49IDAgJiYgcmVjdC50b3AgPD0gdmggJiYgcmVjdC5sZWZ0IDw9IHZ3O1xufVxuXG5cbmNvbnN0IHN0YXRlID0ge1xuICBlbmFibGVkOiBmYWxzZSxcbiAgdHJhbnNsYXRlZDogZmFsc2UsXG4gIGRlY2lzaW9uOiBudWxsIGFzIERlY2lzaW9uIHwgbnVsbCxcbiAgb3JpZ2luYWxNYXA6IG5ldyBXZWFrTWFwPFRleHQsIHN0cmluZz4oKSxcbiAgcHJvY2Vzc2VkOiBuZXcgV2Vha1NldDxUZXh0PigpLFxuXG4gIHRyYW5zbGF0aW5nOiBmYWxzZSxcbiAgc2l0ZTogJydcbn07XG5cbmNvbnN0IHRyYW5zbGF0ZVF1ZXVlOiBUZXh0W10gPSBbXTtcbmxldCBxdWV1ZWQgPSBuZXcgV2Vha1NldDxUZXh0PigpO1xubGV0IGZsdXNoU2NoZWR1bGVkID0gZmFsc2U7XG5jb25zdCBkcmFpblJlc29sdmVyczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcblxuY29uc3QgaW50ZXJzZWN0aW9uID0ge1xuICBvYnNlcnZlcjogbnVsbCBhcyBJbnRlcnNlY3Rpb25PYnNlcnZlciB8IG51bGwsXG4gIHBlbmRpbmc6IG5ldyBNYXA8RWxlbWVudCwgU2V0PFRleHQ+PigpXG59O1xuXG5jb25zdCBzY2hlZHVsZVRhc2s6IChmbjogKCkgPT4gdm9pZCkgPT4gdm9pZCA9XG4gIHR5cGVvZiBxdWV1ZU1pY3JvdGFzayA9PT0gJ2Z1bmN0aW9uJ1xuICAgID8gcXVldWVNaWNyb3Rhc2tcbiAgICA6IChmbikgPT4gUHJvbWlzZS5yZXNvbHZlKCkudGhlbihmbik7XG5cbmZ1bmN0aW9uIHBvc3Q8VD1hbnksIFI9YW55Pihtc2c6IFQpOiBQcm9taXNlPFI+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICB0cnkge1xuICAgICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobXNnLCAocmVzOlIpID0+IHtcbiAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgIHJlamVjdChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHJlcyk7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJlamVjdChlcnIpO1xuICAgIH1cbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNldFBlbmRpbmdBdHRyKHBlbmRpbmc6IGJvb2xlYW4pIHtcbiAgdHJ5IHtcbiAgICBpZiAocGVuZGluZykgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnNldEF0dHJpYnV0ZSgnZGF0YS1hdXRvdHJhbnMnLCdwZW5kaW5nJyk7XG4gICAgZWxzZSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQucmVtb3ZlQXR0cmlidXRlKCdkYXRhLWF1dG90cmFucycpO1xuICB9IGNhdGNoIHt9XG59XG5cbmxldCBwZW5kaW5nVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xubGV0IHBlbmRpbmdBcHBsaWVkID0gZmFsc2U7XG5mdW5jdGlvbiBzdGFydFBlbmRpbmdJbmRpY2F0b3IoKSB7XG4gIGlmIChwZW5kaW5nQXBwbGllZCB8fCBwZW5kaW5nVGltZXIgIT0gbnVsbCkgcmV0dXJuO1xuICBwZW5kaW5nVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgcGVuZGluZ1RpbWVyID0gbnVsbDtcbiAgICBwZW5kaW5nQXBwbGllZCA9IHRydWU7XG4gICAgc2V0UGVuZGluZ0F0dHIodHJ1ZSk7XG4gIH0sIDIwMCk7XG59XG5mdW5jdGlvbiBzdG9wUGVuZGluZ0luZGljYXRvcigpIHtcbiAgaWYgKHBlbmRpbmdUaW1lciAhPSBudWxsKSB7XG4gICAgd2luZG93LmNsZWFyVGltZW91dChwZW5kaW5nVGltZXIpO1xuICAgIHBlbmRpbmdUaW1lciA9IG51bGw7XG4gIH1cbiAgaWYgKHBlbmRpbmdBcHBsaWVkKSB7XG4gICAgcGVuZGluZ0FwcGxpZWQgPSBmYWxzZTtcbiAgICBzZXRQZW5kaW5nQXR0cihmYWxzZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZURyYWluUmVzb2x2ZXJzKCkge1xuICB3aGlsZSAoZHJhaW5SZXNvbHZlcnMubGVuZ3RoKSB7XG4gICAgY29uc3QgcmVzb2x2ZXIgPSBkcmFpblJlc29sdmVycy5zaGlmdCgpO1xuICAgIHRyeSB7IHJlc29sdmVyPy4oKTsgfSBjYXRjaCB7fVxuICB9XG59XG5cbmZ1bmN0aW9uIHdhaXRGb3JRdWV1ZURyYWluKCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIXN0YXRlLnRyYW5zbGF0aW5nICYmIHRyYW5zbGF0ZVF1ZXVlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IGRyYWluUmVzb2x2ZXJzLnB1c2gocmVzb2x2ZSkpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0VGV4dE5vZGVzKHJvb3Q6IE5vZGUpOiBUZXh0W10ge1xuICBjb25zdCBvdXQ6IFRleHRbXSA9IFtdO1xuICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKHJvb3QsIE5vZGVGaWx0ZXIuU0hPV19URVhULCB7XG4gICAgYWNjZXB0Tm9kZShub2RlKSB7XG4gICAgICBjb25zdCBwID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgICAgaWYgKCFwKSByZXR1cm4gTm9kZUZpbHRlci5GSUxURVJfUkVKRUNUO1xuICAgICAgY29uc3QgdGFnID0gcC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAoWydzY3JpcHQnLCdzdHlsZScsJ25vc2NyaXB0JywnY29kZScsJ3ByZScsJ2tiZCcsJ3NhbXAnLCd0ZXh0YXJlYScsJ2lucHV0J10uaW5jbHVkZXModGFnKSkgcmV0dXJuIE5vZGVGaWx0ZXIuRklMVEVSX1JFSkVDVDtcbiAgICAgIGNvbnN0IHMgPSAobm9kZS50ZXh0Q29udGVudCB8fCAnJykucmVwbGFjZSgvXFxzKy9nLCAnICcpLnRyaW0oKTtcbiAgICAgIGlmIChzLmxlbmd0aCA8IDIpIHJldHVybiBOb2RlRmlsdGVyLkZJTFRFUl9SRUpFQ1Q7XG4gICAgICByZXR1cm4gTm9kZUZpbHRlci5GSUxURVJfQUNDRVBUO1xuICAgIH1cbiAgfSk7XG4gIGxldCBuOiBOb2RlIHwgbnVsbDtcbiAgd2hpbGUgKChuID0gd2Fsa2VyLm5leHROb2RlKCkpKSBvdXQucHVzaChuIGFzIFRleHQpO1xuICByZXR1cm4gb3V0O1xufVxuXG5jb25zdCBCQVRDSF9TSVpFID0gNjA7XG5cbmZ1bmN0aW9uIGVucXVldWVGb3JUcmFuc2xhdGlvbihub2RlczogVGV4dFtdKTogYm9vbGVhbiB7XG4gIGxldCBhZGRlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICBpZiAoIW5vZGUpIGNvbnRpbnVlO1xuICAgIGlmIChzdGF0ZS5wcm9jZXNzZWQuaGFzKG5vZGUpIHx8IHF1ZXVlZC5oYXMobm9kZSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHRleHQgPSAobm9kZS5ub2RlVmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICBpZiAoIXRleHQpIGNvbnRpbnVlO1xuICAgIHRyYW5zbGF0ZVF1ZXVlLnB1c2gobm9kZSk7XG4gICAgcXVldWVkLmFkZChub2RlKTtcbiAgICBhZGRlZCA9IHRydWU7XG4gIH1cbiAgaWYgKGFkZGVkKSB7XG4gICAgc3RhcnRQZW5kaW5nSW5kaWNhdG9yKCk7XG4gICAgc2NoZWR1bGVGbHVzaCgpO1xuICB9XG4gIHJldHVybiBhZGRlZDtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVGbHVzaCgpIHtcbiAgaWYgKGZsdXNoU2NoZWR1bGVkKSByZXR1cm47XG4gIGZsdXNoU2NoZWR1bGVkID0gdHJ1ZTtcbiAgc2NoZWR1bGVUYXNrKCgpID0+IHtcbiAgICBmbHVzaFF1ZXVlKCkuY2F0Y2goKGVycikgPT4gY29uc29sZS53YXJuKCdmbHVzaFF1ZXVlIGVycm9yJywgZXJyKSk7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmbHVzaFF1ZXVlKCkge1xuICBpZiAoc3RhdGUudHJhbnNsYXRpbmcpIHtcbiAgICBmbHVzaFNjaGVkdWxlZCA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuICBmbHVzaFNjaGVkdWxlZCA9IGZhbHNlO1xuICBzdGF0ZS50cmFuc2xhdGluZyA9IHRydWU7XG4gIHRyeSB7XG4gICAgd2hpbGUgKHRyYW5zbGF0ZVF1ZXVlLmxlbmd0aCkge1xuICAgICAgY29uc3QgY2h1bmtOb2RlczogVGV4dFtdID0gW107XG4gICAgICBjb25zdCB0ZXh0czogc3RyaW5nW10gPSBbXTtcbiAgICAgIHdoaWxlIChjaHVua05vZGVzLmxlbmd0aCA8IEJBVENIX1NJWkUgJiYgdHJhbnNsYXRlUXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHRyYW5zbGF0ZVF1ZXVlLnNoaWZ0KCkhO1xuICAgICAgICBxdWV1ZWQuZGVsZXRlKGNhbmRpZGF0ZSk7XG4gICAgICAgIGlmICghY2FuZGlkYXRlLmlzQ29ubmVjdGVkKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHN0YXRlLnByb2Nlc3NlZC5oYXMoY2FuZGlkYXRlKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHRleHQgPSAoY2FuZGlkYXRlLm5vZGVWYWx1ZSB8fCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICBzdGF0ZS5wcm9jZXNzZWQuYWRkKGNhbmRpZGF0ZSk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY2h1bmtOb2Rlcy5wdXNoKGNhbmRpZGF0ZSk7XG4gICAgICAgIHRleHRzLnB1c2godGV4dCk7XG4gICAgICB9XG4gICAgICBpZiAoIWNodW5rTm9kZXMubGVuZ3RoKSBjb250aW51ZTtcbiAgICAgIGxldCBvdXQ6IHN0cmluZ1tdID0gdGV4dHM7XG4gICAgICB0cnkge1xuICAgICAgICBvdXQgPSBhd2FpdCB0cmFuc2xhdGVCYXRjaCh0ZXh0cywgc3RhdGUuZGVjaXNpb24hLnRhcmdldExhbmcsIHN0YXRlLmRlY2lzaW9uIS5zb3VyY2VMYW5nKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1RyYW5zbGF0aW9uIGJhdGNoIGZhaWxlZCcsIGVycik7XG4gICAgICAgIHRyYW5zbGF0ZVF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgICAgIHF1ZXVlZCA9IG5ldyBXZWFrU2V0PFRleHQ+KCk7XG4gICAgICB9XG4gICAgICBhcHBseVRyYW5zbGF0aW9ucyhjaHVua05vZGVzLCBvdXQpO1xuICAgICAgY2h1bmtOb2Rlcy5mb3JFYWNoKChuKSA9PiBzdGF0ZS5wcm9jZXNzZWQuYWRkKG4pKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDApKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgc3RhdGUudHJhbnNsYXRpbmcgPSBmYWxzZTtcbiAgICBpZiAodHJhbnNsYXRlUXVldWUubGVuZ3RoKSB7XG4gICAgICBzY2hlZHVsZUZsdXNoKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN0b3BQZW5kaW5nSW5kaWNhdG9yKCk7XG4gICAgcmVzb2x2ZURyYWluUmVzb2x2ZXJzKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdHJhbnNsYXRlQmF0Y2godGV4dHM6IHN0cmluZ1tdLCB0YXJnZXRMYW5nOiBzdHJpbmcsIHNvdXJjZUxhbmc/OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IHBvc3QoeyB0eXBlOiAnVFJBTlNMQVRFX0JBVENIJywgdGV4dHMsIHRhcmdldExhbmcsIHNvdXJjZUxhbmcgfSkgYXMgYW55O1xuICByZXR1cm4gcmVzPy5yZXN1bHQgfHwgdGV4dHM7XG59XG5cbmZ1bmN0aW9uIGFwcGx5VHJhbnNsYXRpb25zKG5vZGVzOiBUZXh0W10sIHRyYW5zbGF0ZWQ6IHN0cmluZ1tdKSB7XG4gIGZvciAobGV0IGk9MDtpPG5vZGVzLmxlbmd0aDtpKyspIHtcbiAgICBjb25zdCBub2RlID0gbm9kZXNbaV07XG4gICAgY29uc3Qgb3JpZyA9IG5vZGUubm9kZVZhbHVlIHx8ICcnO1xuICAgIGlmICghc3RhdGUub3JpZ2luYWxNYXAuaGFzKG5vZGUpKSBzdGF0ZS5vcmlnaW5hbE1hcC5zZXQobm9kZSwgb3JpZyk7XG4gICAgbm9kZS5ub2RlVmFsdWUgPSB0cmFuc2xhdGVkW2ldO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVPcmlnaW5hbChub2RlczogVGV4dFtdKSB7XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgIGNvbnN0IG9yaWcgPSBzdGF0ZS5vcmlnaW5hbE1hcC5nZXQobm9kZSk7XG4gICAgaWYgKG9yaWcgIT0gbnVsbCkgbm9kZS5ub2RlVmFsdWUgPSBvcmlnO1xuICB9XG59XG5cbmZ1bmN0aW9uIG1vdW50VG9nZ2xlKCkge1xuICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dG90cmFuc2xhdGUtdG9nZ2xlJykpIHJldHVybjtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gIGJ0bi5pZCA9ICdhdXRvdHJhbnNsYXRlLXRvZ2dsZSc7XG4gIGJ0bi5kYXRhc2V0LnN0YXRlID0gc3RhdGUudHJhbnNsYXRlZCA/ICdvbicgOiAnb2ZmJztcbiAgYnRuLmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cImRvdFwiPjwvc3Bhbj48c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmA7XG4gIGNvbnN0IGxhYmVsID0gKCkgPT4gYnRuLnF1ZXJ5U2VsZWN0b3IoJy5sYWJlbCcpIS50ZXh0Q29udGVudCA9IHN0YXRlLnRyYW5zbGF0ZWQgPyAnXHU1REYyXHU4QkQxXHU0RTNBXHU3NkVFXHU2ODA3XHU4QkVEXHU4QTAwXHVGRjA4Q3RybCtTaGlmdCtUIFx1NTIwN1x1NjM2Mlx1RkYwOScgOiAnXHU1MzlGXHU2NTg3XHU2NjNFXHU3OTNBXHVGRjA4Q3RybCtTaGlmdCtUIFx1NTIwN1x1NjM2Mlx1RkYwOSc7XG4gIGxhYmVsKCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZU5vdygpKTtcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKGJ0bik7XG4gIGNvbnN0IG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGNvbnN0IHBhcmVudCA9IGJ0bi5wYXJlbnRFbGVtZW50O1xuICAgIGlmICghcGFyZW50KSB7XG4gICAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbGFzdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5sYXN0RWxlbWVudENoaWxkO1xuICAgIGlmIChsYXN0ICE9PSBidG4pIHtcbiAgICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChidG4pO1xuICAgIH1cbiAgfSk7XG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSB9KTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBvYnNlcnZlci5kaXNjb25uZWN0KCk7XG4gICAgYnRuLnJlbW92ZSgpO1xuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB0b2dnbGVOb3coKSB7XG4gIGNvbnN0IG5vZGVzID0gY29sbGVjdFRleHROb2Rlcyhkb2N1bWVudC5ib2R5KTtcbiAgaWYgKHN0YXRlLnRyYW5zbGF0ZWQpIHtcbiAgICByZXN0b3JlT3JpZ2luYWwobm9kZXMpO1xuICAgIHN0YXRlLnRyYW5zbGF0ZWQgPSBmYWxzZTtcbiAgfSBlbHNlIHtcbiAgICBhd2FpdCBkb1RyYW5zbGF0ZShub2Rlcyk7XG4gICAgc3RhdGUudHJhbnNsYXRlZCA9IHRydWU7XG4gIH1cbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2F1dG90cmFuc2xhdGUtdG9nZ2xlJyk7XG4gIGlmIChidG4pIHtcbiAgICBidG4uc2V0QXR0cmlidXRlKCdkYXRhLXN0YXRlJywgc3RhdGUudHJhbnNsYXRlZCA/ICdvbicgOiAnb2ZmJyk7XG4gICAgY29uc3QgbGFiZWwgPSBidG4ucXVlcnlTZWxlY3RvcignLmxhYmVsJykhO1xuICAgIGxhYmVsLnRleHRDb250ZW50ID0gc3RhdGUudHJhbnNsYXRlZCA/ICdcdTVERjJcdThCRDFcdTRFM0FcdTc2RUVcdTY4MDdcdThCRURcdThBMDBcdUZGMDhDdHJsK1NoaWZ0K1QgXHU1MjA3XHU2MzYyXHVGRjA5JyA6ICdcdTUzOUZcdTY1ODdcdTY2M0VcdTc5M0FcdUZGMDhDdHJsK1NoaWZ0K1QgXHU1MjA3XHU2MzYyXHVGRjA5JztcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkb1RyYW5zbGF0ZShub2RlczogVGV4dFtdKSB7XG4gIC8vIHNwbGl0OiB2aXNpYmxlIGZpcnN0XG4gIGNvbnN0IHZpc2libGU6IFRleHRbXSA9IFtdO1xuICBjb25zdCBoaWRkZW46IFRleHRbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAoc3RhdGUucHJvY2Vzc2VkLmhhcyhuKSkgY29udGludWU7XG4gICAgKGlzVmlzaWJsZShuKSA/IHZpc2libGUgOiBoaWRkZW4pLnB1c2gobik7XG4gIH1cbiAgaWYgKHZpc2libGUubGVuZ3RoKSBhd2FpdCBkb1RyYW5zbGF0ZUJhdGNoZWQodmlzaWJsZSwgdHJ1ZSk7XG4gIC8vIE9ic2VydmUgdGhlIHJlc3QgZm9yIHdoZW4gdGhleSBlbnRlciB2aWV3cG9ydFxuICBxdWV1ZUludGVyc2VjdGlvbk9ic2VydmF0aW9uKGhpZGRlbik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRvVHJhbnNsYXRlQmF0Y2hlZChub2RlczogVGV4dFtdLCBhd2FpdENvbXBsZXRpb24gPSBmYWxzZSkge1xuICBlbnF1ZXVlRm9yVHJhbnNsYXRpb24obm9kZXMpO1xuICBpZiAoYXdhaXRDb21wbGV0aW9uKSB7XG4gICAgYXdhaXQgd2FpdEZvclF1ZXVlRHJhaW4oKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBvYnNlcnZlTXV0YXRpb25zKCkge1xuICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihhc3luYyAobXV0YXRpb25zKSA9PiB7XG4gICAgaWYgKCFzdGF0ZS50cmFuc2xhdGVkKSByZXR1cm47XG4gICAgY29uc3QgYWRkZWQ6IFRleHRbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbSBvZiBtdXRhdGlvbnMpIHtcbiAgICAgIGlmIChtLnR5cGUgPT09ICdjaGlsZExpc3QnKSB7XG4gICAgICAgIG0uYWRkZWROb2Rlcy5mb3JFYWNoKG4gPT4ge1xuICAgICAgICAgIGlmIChuLm5vZGVUeXBlID09PSBOb2RlLlRFWFRfTk9ERSkgYWRkZWQucHVzaChuIGFzIFRleHQpO1xuICAgICAgICAgIGVsc2UgaWYgKG4ubm9kZVR5cGUgPT09IE5vZGUuRUxFTUVOVF9OT0RFKSBhZGRlZC5wdXNoKC4uLmNvbGxlY3RUZXh0Tm9kZXMobikpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSAnY2hhcmFjdGVyRGF0YScpIHtcbiAgICAgICAgYWRkZWQucHVzaChtLnRhcmdldCBhcyBUZXh0KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGFkZGVkLmxlbmd0aCkge1xuICAgICAgcXVldWVJbnRlcnNlY3Rpb25PYnNlcnZhdGlvbihhZGRlZCk7XG4gICAgfVxuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSwgY2hhcmFjdGVyRGF0YTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gYmluZEtleWJvYXJkKCkge1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChlKSA9PiB7XG4gICAgaWYgKGUuY3RybEtleSAmJiBlLnNoaWZ0S2V5ICYmICFlLm1ldGFLZXkgJiYgIWUuYWx0S2V5ICYmIChlLmtleSA9PT0gJ3QnIHx8IGUua2V5ID09PSAnVCcpKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB0b2dnbGVOb3coKTtcbiAgICB9XG4gIH0sIHsgY2FwdHVyZTogdHJ1ZSB9KTtcbn1cblxuKGFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbG9jYXRpb24uaHJlZjtcbiAgICBjb25zdCBzaXRlID0gZ2V0UmVnaXN0cmFibGVEb21haW4obG9jYXRpb24uaG9zdG5hbWUpO1xuICAgIHN0YXRlLnNpdGUgPSBzaXRlO1xuICAgIHN0YXJ0UGVuZGluZ0luZGljYXRvcigpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHBvc3QoeyB0eXBlOiAnSU5JVCcsIHVybCwgZG9jTGFuZzogZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmxhbmcgfHwgdW5kZWZpbmVkLCBzaXRlIH0pIGFzIGFueTtcbiAgICBjb25zdCBkZWNpc2lvbjogRGVjaXNpb24gPSByZXM/LmRlY2lzaW9uIHx8IHsgb2s6ZmFsc2UsIHRhcmdldExhbmc6J2VuJywgbW9kZTonYXV0bycgfTtcbiAgICBzdGF0ZS5kZWNpc2lvbiA9IGRlY2lzaW9uO1xuICAgIG1vdW50VG9nZ2xlKCk7XG4gICAgYmluZEtleWJvYXJkKCk7XG5cbiAgICBpZiAoZGVjaXNpb24ub2spIHtcbiAgICAgIGNvbnN0IG5vZGVzID0gY29sbGVjdFRleHROb2Rlcyhkb2N1bWVudC5ib2R5KTtcbiAgICAgIGF3YWl0IGRvVHJhbnNsYXRlKG5vZGVzKTtcbiAgICAgIHN0YXRlLnRyYW5zbGF0ZWQgPSB0cnVlO1xuICAgICAgb2JzZXJ2ZU11dGF0aW9ucygpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIGZhaWwgb3BlblxuICAgIGNvbnNvbGUud2FybignQXV0b1RyYW5zbGF0ZSBlcnJvcicsIGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHN0b3BQZW5kaW5nSW5kaWNhdG9yKCk7XG4gIH1cbn0pKCk7XG5cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobXNnKSA9PiB7XG4gIGlmIChtc2c/LnR5cGUgPT09ICdTSVRFX01PREVfQ0hBTkdFRCcpIHtcbiAgICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXV0b3RyYW5zbGF0ZS10b2dnbGUnKTtcbiAgICBpZiAoIWJ0bikgcmV0dXJuO1xuICAgIGJ0bi5zZXRBdHRyaWJ1dGUoJ3RpdGxlJywgYFx1N0FEOVx1NzBCOVx1NkEyMVx1NUYwRlx1NURGMlx1NTIwN1x1NTIzMFx1RkYxQSR7bXNnLm1vZGV9YCk7XG4gIH1cbiAgaWYgKG1zZz8udHlwZSA9PT0gJ1RPR0dMRV9UUkFOU0xBVElPTicpIHtcbiAgICB0b2dnbGVOb3coKS5jYXRjaCgoZXJyKSA9PiBjb25zb2xlLndhcm4oJ1RvZ2dsZSB0cmFuc2xhdGlvbiBlcnJvcicsIGVycikpO1xuICB9XG59KTtcblxuXG5mdW5jdGlvbiBlbnN1cmVJbnRlcnNlY3Rpb25PYnNlcnZlcigpOiBJbnRlcnNlY3Rpb25PYnNlcnZlciB7XG4gIGlmIChpbnRlcnNlY3Rpb24ub2JzZXJ2ZXIpIHJldHVybiBpbnRlcnNlY3Rpb24ub2JzZXJ2ZXI7XG4gIGludGVyc2VjdGlvbi5vYnNlcnZlciA9IG5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcigoZW50cmllcykgPT4ge1xuICAgIGNvbnN0IHRvVHJhbnNsYXRlOiBUZXh0W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGlmICghZW50cnkuaXNJbnRlcnNlY3RpbmcpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZW50cnkudGFyZ2V0IGFzIEVsZW1lbnQ7XG4gICAgICBjb25zdCBzZXQgPSBpbnRlcnNlY3Rpb24ucGVuZGluZy5nZXQodGFyZ2V0KTtcbiAgICAgIGlmICghc2V0KSB7XG4gICAgICAgIGludGVyc2VjdGlvbi5vYnNlcnZlcj8udW5vYnNlcnZlKHRhcmdldCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaW50ZXJzZWN0aW9uLnBlbmRpbmcuZGVsZXRlKHRhcmdldCk7XG4gICAgICBzZXQuZm9yRWFjaCgobm9kZSkgPT4ge1xuICAgICAgICBpZiAoc3RhdGUucHJvY2Vzc2VkLmhhcyhub2RlKSkgcmV0dXJuO1xuICAgICAgICB0b1RyYW5zbGF0ZS5wdXNoKG5vZGUpO1xuICAgICAgfSk7XG4gICAgICBpbnRlcnNlY3Rpb24ub2JzZXJ2ZXI/LnVub2JzZXJ2ZSh0YXJnZXQpO1xuICAgIH1cbiAgICBpZiAodG9UcmFuc2xhdGUubGVuZ3RoKSBlbnF1ZXVlRm9yVHJhbnNsYXRpb24odG9UcmFuc2xhdGUpO1xuICB9LCB7IHJvb3Q6IG51bGwsIHJvb3RNYXJnaW46ICcxMjhweCcsIHRocmVzaG9sZDogMCB9KTtcbiAgcmV0dXJuIGludGVyc2VjdGlvbi5vYnNlcnZlcjtcbn1cblxuZnVuY3Rpb24gcXVldWVJbnRlcnNlY3Rpb25PYnNlcnZhdGlvbihjYW5kaWRhdGVzOiBUZXh0W10pIHtcbiAgaWYgKCFjYW5kaWRhdGVzLmxlbmd0aCkgcmV0dXJuO1xuICBjb25zdCBvYnMgPSBlbnN1cmVJbnRlcnNlY3Rpb25PYnNlcnZlcigpO1xuICBmb3IgKGNvbnN0IG5vZGUgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmICghbm9kZSB8fCAhbm9kZS5pc0Nvbm5lY3RlZCkgY29udGludWU7XG4gICAgaWYgKHN0YXRlLnByb2Nlc3NlZC5oYXMobm9kZSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVsID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgIGlmICghZWwpIGNvbnRpbnVlO1xuICAgIGxldCBzZXQgPSBpbnRlcnNlY3Rpb24ucGVuZGluZy5nZXQoZWwpO1xuICAgIGlmICghc2V0KSB7XG4gICAgICBzZXQgPSBuZXcgU2V0PFRleHQ+KCk7XG4gICAgICBpbnRlcnNlY3Rpb24ucGVuZGluZy5zZXQoZWwsIHNldCk7XG4gICAgfVxuICAgIHNldC5hZGQobm9kZSk7XG4gICAgb2JzLm9ic2VydmUoZWwpO1xuICB9XG59XG5cblxuZnVuY3Rpb24gc2hvd1RvYXN0KG1zZzogc3RyaW5nKSB7XG4gIGNvbnN0IGlkID0gJ2F1dG90cmFuc2xhdGUtdG9hc3QnO1xuICBsZXQgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gIGlmICghZWwpIHtcbiAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGVsLmlkID0gaWQ7XG4gICAgZWwuc2V0QXR0cmlidXRlKCdzdHlsZScsJ3Bvc2l0aW9uOmZpeGVkO2JvdHRvbTo1NnB4O3JpZ2h0OjE2cHg7ei1pbmRleDoyMTQ3NDgzNjQ3O2JhY2tncm91bmQ6IzExMTtjb2xvcjojZmZmO3BhZGRpbmc6OHB4IDEycHg7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjEycHg7b3BhY2l0eTowLjkyO2JveC1zaGFkb3c6MCA2cHggMjRweCByZ2JhKDAsMCwwLC4yKScpO1xuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChlbCk7XG4gIH1cbiAgZWwudGV4dENvbnRlbnQgPSBtc2c7XG4gIGVsLmFuaW1hdGUoW3tvcGFjaXR5OjB9LHtvcGFjaXR5OjAuOTJ9XSx7ZHVyYXRpb246MTIwLGZpbGw6J2ZvcndhcmRzJ30pO1xuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBlbD8uYW5pbWF0ZShbe29wYWNpdHk6MC45Mn0se29wYWNpdHk6MH1dLHtkdXJhdGlvbjoyMjAsZmlsbDonZm9yd2FyZHMnfSkuYWRkRXZlbnRMaXN0ZW5lcignZmluaXNoJywoKT0+IGVsPy5yZW1vdmUoKSk7XG4gIH0sIDE4MDApO1xufVxuXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZykgPT4ge1xuICBpZiAobXNnPy50eXBlID09PSAnVE9BU1QnICYmIHR5cGVvZiBtc2cubWVzc2FnZSA9PT0gJ3N0cmluZycpIHNob3dUb2FzdChtc2cubWVzc2FnZSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUFBLE1BQU0sc0JBQXNCLG9CQUFJLElBQUk7QUFBQSxJQUNsQztBQUFBLElBQVM7QUFBQSxJQUFVO0FBQUEsSUFBVTtBQUFBLElBQzdCO0FBQUEsSUFBVTtBQUFBLElBQVU7QUFBQSxJQUNwQjtBQUFBLElBQVM7QUFBQSxJQUFTO0FBQUEsSUFDbEI7QUFBQSxJQUFVO0FBQUEsSUFBVTtBQUFBLElBQVU7QUFBQSxJQUFVO0FBQUEsSUFBVTtBQUFBLElBQVU7QUFBQSxJQUFVO0FBQUEsSUFBVTtBQUFBLElBQVU7QUFBQSxJQUFVO0FBQUEsSUFDcEc7QUFBQSxJQUFTO0FBQUEsSUFBUztBQUFBLEVBQ3BCLENBQUM7QUFFTSxXQUFTLHFCQUFxQixVQUEyQjtBQUM5RCxRQUFJLENBQUMsU0FBVSxRQUFPO0FBQ3RCLFVBQU0sV0FBVyxTQUFTLE1BQU0sR0FBRyxFQUFFLE9BQU8sT0FBTztBQUNuRCxRQUFJLFNBQVMsVUFBVSxFQUFHLFFBQU87QUFDakMsVUFBTSxRQUFRLFNBQVMsSUFBSSxDQUFDLE1BQU0sRUFBRSxZQUFZLENBQUM7QUFDakQsZUFBVyxVQUFVLHFCQUFxQjtBQUN4QyxZQUFNLGNBQWMsT0FBTyxNQUFNLEdBQUc7QUFDcEMsVUFBSSxNQUFNLFNBQVMsWUFBWSxRQUFRO0FBQ3JDLGNBQU0sT0FBTyxNQUFNLE1BQU0sQ0FBQyxZQUFZLE1BQU0sRUFBRSxLQUFLLEdBQUc7QUFDdEQsWUFBSSxTQUFTLFFBQVE7QUFDbkIsaUJBQU8sU0FBUyxNQUFNLEVBQUUsWUFBWSxTQUFTLEVBQUUsRUFBRSxLQUFLLEdBQUc7QUFBQSxRQUMzRDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsV0FB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
