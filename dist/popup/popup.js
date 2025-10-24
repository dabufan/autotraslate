function getSite(url) {
    try {
        const u = new URL(url);
        const parts = u.hostname.split('.');
        return parts.length <= 2 ? u.hostname : parts.slice(-2).join('.');
    }
    catch {
        return '';
    }
}
function send(msg) { return new Promise(res => chrome.runtime.sendMessage(msg, (r) => res(r))); }
(async function () {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = getSite(tab?.url || '');
    (document.getElementById('site')).textContent = site || '未知站点';
    const prefs = (await send({ type: 'GET_PREFS' }))?.prefs;
    const current = prefs?.siteModes?.[site] || 'auto';
    const sel = document.getElementById('mode');
    sel.value = current;
    sel.addEventListener('change', async () => {
        await send({ type: 'SET_SITE_PREF', site, mode: sel.value });
        if (tab?.id)
            chrome.tabs.sendMessage(tab.id, { type: 'SITE_MODE_CHANGED', site, mode: sel.value });
        window.close();
    });
    document.getElementById('openOptions').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
        window.close();
    });
})();
export {};
