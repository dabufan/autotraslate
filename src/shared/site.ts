const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ph',
  'co.in', 'co.kr', 'co.za'
]);

export function getRegistrableDomain(hostname?: string): string {
  if (!hostname) return '';
  const rawParts = hostname.split('.').filter(Boolean);
  if (rawParts.length <= 2) return hostname;
  const parts = rawParts.map((p) => p.toLowerCase());
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

export function getSiteFromUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    return getRegistrableDomain(u.hostname);
  } catch {
    return '';
  }
}

export { MULTI_PART_SUFFIXES };
