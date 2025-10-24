import { getSiteFromUrl } from '../shared/site';

function send(msg: any) { return new Promise<any>(res => chrome.runtime.sendMessage(msg, (r) => res(r))); }

(async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = getSiteFromUrl(tab?.url);
  (document.getElementById('site')!).textContent = site || '未知站点';
  const prefs = (await send({ type: 'GET_PREFS' }))?.prefs as any;
  const current = prefs?.siteModes?.[site] || 'auto';
  const sel = document.getElementById('mode') as HTMLSelectElement;
  sel.value = current;
  sel.addEventListener('change', async () => {
    await send({ type: 'SET_SITE_PREF', site, mode: sel.value });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'SITE_MODE_CHANGED', site, mode: sel.value });
    window.close();
  });

  document.getElementById('openOptions')!.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
