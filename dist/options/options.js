const DEFAULTS = {
    targetLang: (navigator.language || 'en').split('-')[0],
    autoTranslate: true,
    provider: { type: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' },
    siteModes: {},
    glossary: { pairs: [], protect: [] }
};
function getPrefs() {
    return new Promise((resolve) => chrome.storage.sync.get(['prefs'], (res) => {
        resolve(res?.prefs || DEFAULTS);
    }));
}
function setPrefs(p) {
    return new Promise((resolve) => chrome.storage.sync.set({ prefs: p }, () => resolve()));
}
function show(el, on) { el.classList.toggle('hidden', !on); }
function parsePairs(raw) {
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const ln of lines) {
        const m = ln.split('=');
        if (m.length >= 2)
            out.push({ src: m[0].trim(), tgt: m.slice(1).join('=').trim() });
    }
    return out;
}
function parseProtect(raw) {
    return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}
(async function () {
    const targetLang = document.getElementById('targetLang');
    const autoTranslate = document.getElementById('autoTranslate');
    const provRadios = Array.from(document.querySelectorAll('input[name="provider"]'));
    const dsFields = document.getElementById('deepseekFields');
    const lbFields = document.getElementById('libreFields');
    const dsBaseUrl = document.getElementById('dsBaseUrl');
    const dsApiKey = document.getElementById('dsApiKey');
    const dsModel = document.getElementById('dsModel');
    const lbBaseUrl = document.getElementById('lbBaseUrl');
    const lbApiKey = document.getElementById('lbApiKey');
    const glossaryPairs = document.getElementById('glossaryPairs');
    const protectTerms = document.getElementById('protectTerms');
    const saved = document.getElementById('saved');
    const prefs = await getPrefs();
    targetLang.value = prefs.targetLang || '';
    autoTranslate.checked = !!prefs.autoTranslate;
    const isDS = (prefs.provider?.type || 'deepseek') === 'deepseek';
    provRadios.forEach(r => r.checked = (r.value === (isDS ? 'deepseek' : 'libre')));
    show(dsFields, isDS);
    show(lbFields, !isDS);
    if (isDS) {
        const p = prefs.provider;
        dsBaseUrl.value = p.baseUrl || 'https://api.deepseek.com';
        dsApiKey.value = p.apiKey || '';
        dsModel.value = p.model || 'deepseek-chat';
    }
    else {
        const p = prefs.provider;
        lbBaseUrl.value = p.baseUrl || 'https://libretranslate.com';
        lbApiKey.value = p.apiKey || '';
    }
    // Glossary
    glossaryPairs.value = (prefs.glossary?.pairs || []).map(p => `${p.src}=${p.tgt}`).join('\n');
    protectTerms.value = (prefs.glossary?.protect || []).join(', ');
    provRadios.forEach(r => r.addEventListener('change', () => {
        const chosen = document.querySelector('input[name="provider"]:checked').value;
        show(dsFields, chosen === 'deepseek');
        show(lbFields, chosen === 'libre');
    }));
    document.getElementById('save').addEventListener('click', async () => {
        const chosen = document.querySelector('input[name="provider"]:checked').value;
        let provider;
        if (chosen === 'deepseek') {
            provider = {
                type: 'deepseek',
                baseUrl: (dsBaseUrl.value || 'https://api.deepseek.com').trim(),
                apiKey: (dsApiKey.value || '').trim(),
                model: (dsModel.value || 'deepseek-chat').trim()
            };
        }
        else {
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
        const next = {
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
export {};
