export {};

type DeepSeekProvider = {
  type: 'deepseek';
  baseUrl: string;
  apiKey: string;
  model: string;
}
type QwenProvider = {
  type: 'qwen';
  baseUrl: string;
  apiKey: string;
  model: string;
}
type LibreProvider = {
  type: 'libre';
  baseUrl: string;
  apiKey?: string;
}
type Glossary = {
  pairs: { src: string; tgt: string }[];
  protect: string[];
}
type Prefs = {
  targetLang: string;
  autoTranslate: boolean;
  provider: DeepSeekProvider | LibreProvider | QwenProvider;
  siteModes: Record<string,'always'|'never'|'auto'>;
  glossary: Glossary;
};
const DEFAULTS: Prefs = {
  targetLang: (navigator.language || 'en').split('-')[0],
  autoTranslate: true,
  provider: { type: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: '', model: 'qwen-turbo' },
  siteModes: {},
  glossary: { pairs: [], protect: [] }
};

function getPrefs(): Promise<Prefs> {
  return new Promise((resolve) => chrome.storage.sync.get(['prefs'], (res) => {
    resolve(res?.prefs || DEFAULTS);
  }));
}
function setPrefs(p: Prefs): Promise<void> {
  return new Promise((resolve) => chrome.storage.sync.set({ prefs: p }, () => resolve()));
}
function show(el: HTMLElement, on: boolean) { el.classList.toggle('hidden', !on); }

function parsePairs(raw: string): {src:string, tgt:string}[] {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out: {src:string, tgt:string}[] = [];
  for (const ln of lines) {
    const m = ln.split('=');
    if (m.length >= 2) out.push({ src: m[0].trim(), tgt: m.slice(1).join('=').trim() });
  }
  return out;
}
function parseProtect(raw: string): string[] {
  return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

(async function () {
  const targetLang = document.getElementById('targetLang') as HTMLInputElement;
  const autoTranslate = document.getElementById('autoTranslate') as HTMLInputElement;

  const provRadios = Array.from(document.querySelectorAll('input[name="provider"]')) as HTMLInputElement[];
  const qwFields = document.getElementById('qwenFields') as HTMLDivElement;
  const dsFields = document.getElementById('deepseekFields') as HTMLDivElement;
  const lbFields = document.getElementById('libreFields') as HTMLDivElement;

  const qwBaseUrl = document.getElementById('qwBaseUrl') as HTMLInputElement;
  const qwApiKey = document.getElementById('qwApiKey') as HTMLInputElement;
  const qwModel = document.getElementById('qwModel') as HTMLInputElement;

  const dsBaseUrl = document.getElementById('dsBaseUrl') as HTMLInputElement;
  const dsApiKey = document.getElementById('dsApiKey') as HTMLInputElement;
  const dsModel = document.getElementById('dsModel') as HTMLInputElement;

  const lbBaseUrl = document.getElementById('lbBaseUrl') as HTMLInputElement;
  const lbApiKey = document.getElementById('lbApiKey') as HTMLInputElement;

  const glossaryPairs = document.getElementById('glossaryPairs') as HTMLTextAreaElement;
  const protectTerms = document.getElementById('protectTerms') as HTMLTextAreaElement;

  const saved = document.getElementById('saved') as HTMLSpanElement;

  const prefs = await getPrefs();
  targetLang.value = prefs.targetLang || '';
  autoTranslate.checked = !!prefs.autoTranslate;

  const providerType = (prefs.provider?.type || 'qwen');
  provRadios.forEach(r => r.checked = (r.value === providerType));
  show(qwFields, providerType === 'qwen');
  show(dsFields, providerType === 'deepseek');
  show(lbFields, providerType === 'libre');

  if (providerType === 'qwen') {
    const p = prefs.provider as QwenProvider;
    qwBaseUrl.value = p.baseUrl || 'https://dashscope.aliyuncs.com';
    qwApiKey.value = p.apiKey || '';
    qwModel.value = p.model || 'qwen-turbo';
  } else if (providerType === 'deepseek') {
    const p = prefs.provider as DeepSeekProvider;
    dsBaseUrl.value = p.baseUrl || 'https://api.deepseek.com';
    dsApiKey.value = p.apiKey || '';
    dsModel.value = p.model || 'deepseek-chat';
  } else {
    const p = prefs.provider as LibreProvider;
    lbBaseUrl.value = p.baseUrl || 'https://libretranslate.com';
    lbApiKey.value = p.apiKey || '';
  }

  // Glossary
  glossaryPairs.value = (prefs.glossary?.pairs || []).map(p => `${p.src}=${p.tgt}`).join('\n');
  protectTerms.value = (prefs.glossary?.protect || []).join(', ');

  provRadios.forEach(r => r.addEventListener('change', () => {
    const chosen = (document.querySelector('input[name="provider"]:checked') as HTMLInputElement).value;
    show(qwFields, chosen === 'qwen');
    show(dsFields, chosen === 'deepseek');
    show(lbFields, chosen === 'libre');
  }));

  document.getElementById('save')!.addEventListener('click', async () => {
    const chosen = (document.querySelector('input[name="provider"]:checked') as HTMLInputElement).value;
    let provider: DeepSeekProvider | LibreProvider | QwenProvider;
    if (chosen === 'qwen') {
      provider = {
        type: 'qwen',
        baseUrl: (qwBaseUrl.value || 'https://dashscope.aliyuncs.com').trim(),
        apiKey: (qwApiKey.value || '').trim(),
        model: (qwModel.value || 'qwen-turbo').trim()
      };
    } else if (chosen === 'deepseek') {
      provider = {
        type: 'deepseek',
        baseUrl: (dsBaseUrl.value || 'https://api.deepseek.com').trim(),
        apiKey: (dsApiKey.value || '').trim(),
        model: (dsModel.value || 'deepseek-chat').trim()
      };
    } else {
      provider = {
        type: 'libre',
        baseUrl: (lbBaseUrl.value || 'https://libretranslate.com').trim(),
        apiKey: (lbApiKey.value || undefined) || undefined
      };
    }
    const glossary = {
      pairs: parsePairs(glossaryPairs.value),
      protect: parseProtect(protectTerms.value)
    };
    const next: Prefs = {
      targetLang: (targetLang.value || 'en').trim(),
      autoTranslate: autoTranslate.checked,
      provider,
      siteModes: prefs.siteModes || {},
      glossary
    };
    await setPrefs(next);
    saved.textContent = '已保存';
    setTimeout(() => saved.textContent = '', 1500);
  });
})();
