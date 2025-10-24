export type DeepSeekProvider = {
  type: 'deepseek';
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type QwenProvider = {
  type: 'qwen';
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type LibreProvider = {
  type: 'libre';
  baseUrl: string;
  apiKey?: string;
};

export type Glossary = {
  pairs: { src: string; tgt: string }[];
  protect: string[];
};

export type Prefs = {
  targetLang: string;
  autoTranslate: boolean;
  siteModes: Record<string, 'always' | 'never' | 'auto'>;
  provider: DeepSeekProvider | LibreProvider | QwenProvider;
  glossary: Glossary;
};

const defaultLang = (() => {
  try {
    const lang = navigator.language || (navigator as any).userLanguage;
    if (typeof lang === 'string' && lang.length) {
      return lang.split('-')[0];
    }
  } catch {
    // ignore access errors such as navigator being unavailable
  }
  return 'en';
})();

export const DEFAULT_PREFS: Prefs = {
  targetLang: defaultLang,
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

export function withPrefDefaults(partial?: Partial<Prefs>): Prefs {
  const provider = partial?.provider
    ? { ...partial.provider }
    : { ...DEFAULT_PREFS.provider };
  const glossaryPairs = partial?.glossary?.pairs
    ? partial.glossary.pairs
        .filter((pair): pair is { src: string; tgt: string } => !!pair && typeof pair.src === 'string' && typeof pair.tgt === 'string')
        .map((pair) => ({ src: pair.src, tgt: pair.tgt }))
    : [];
  const glossaryProtect = partial?.glossary?.protect
    ? partial.glossary.protect.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    targetLang: (partial?.targetLang || DEFAULT_PREFS.targetLang).trim() || DEFAULT_PREFS.targetLang,
    autoTranslate: partial?.autoTranslate ?? DEFAULT_PREFS.autoTranslate,
    siteModes: partial?.siteModes ? { ...partial.siteModes } : {},
    provider: provider as Prefs['provider'],
    glossary: {
      pairs: glossaryPairs,
      protect: glossaryProtect
    }
  };
}
