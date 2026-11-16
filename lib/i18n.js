/* dsh-agnes-create — 多语言核心（宿主与客户端共用同一份字典）。
 *
 * 设计：中文原文就是字典 key，所以 zh 是恒等映射、不需要字典文件；
 * 其它语言的文件里是 { "中文原文": "译文" }，缺失的 key 会回退到中文原文，
 * 因此新增文案不会因为还没翻译而显示空白。
 *
 * 占位符统一写成 {name} / {n} / {status}，由 translate() 插值 —— 译文的词序可以随意调整。
 */
import en from './locales/en.js';
import ja from './locales/ja.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import pt from './locales/pt.js';
import ru from './locales/ru.js';
import es from './locales/es.js';

export const DEFAULT_LOCALE = 'zh';
export const AUTO_LOCALE = 'auto';

/* 顺序即设置面板里的顺序：中文在最前，其余按母语者常见程度排列 */
export const LOCALES = ['zh', 'en', 'ja', 'fr', 'de', 'pt', 'ru', 'es'];

export const LOCALE_LABELS = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  es: 'Español',
};

/* zh 恒等，不占字典；其余七种语言文件 */
export const DICTS = { en, ja, fr, de, pt, ru, es };

/* Electron / 浏览器给的可能是 zh-Hans、en-US、pt_BR 这类标签，归一到基础语言 */
const ALIASES = {
  'zh-hans': 'zh',
  'zh-hant': 'zh',
  'zh-cn': 'zh',
  'zh-sg': 'zh',
  'zh-tw': 'zh',
  'zh-hk': 'zh',
  'en-us': 'en',
  'en-gb': 'en',
  'en-au': 'en',
  'ja-jp': 'ja',
  'fr-fr': 'fr',
  'fr-ca': 'fr',
  'de-de': 'de',
  'de-at': 'de',
  'pt-br': 'pt',
  'pt-pt': 'pt',
  'ru-ru': 'ru',
  'ru-by': 'ru',
  'es-es': 'es',
  'es-mx': 'es',
  'es-ar': 'es',
};

/** 把任意语言标签归一成受支持的语言代码；不认识返回 null（区别于「就是中文」）。 */
export function normalizeLocale(value) {
  const raw = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (raw === '') return null;
  if (LOCALES.indexOf(raw) !== -1) return raw;
  if (Object.prototype.hasOwnProperty.call(ALIASES, raw)) return ALIASES[raw];
  const base = raw.split('-')[0];
  return LOCALES.indexOf(base) !== -1 ? base : null;
}

/**
 * 解析实际生效的语言：
 * 配置里存了具体语言就用它；存 auto（或空）时跟随宿主/客户端给的语言标签。
 */
export function resolveLocale(pref, fallback) {
  const explicit = normalizeLocale(pref);
  if (explicit !== null) return explicit;
  return normalizeLocale(fallback) || DEFAULT_LOCALE;
}

/**
 * 某语言的字典（zh 与未知语言返回空对象，调用方自然回退到中文原文）。
 * 非中文语言以英文为兜底：某条还没来得及翻译时显示英文，而不是掉回中文。
 */
export function dictFor(locale) {
  const key = normalizeLocale(locale);
  if (key === null || key === 'zh') return {};
  const base = DICTS.en || {};
  if (key === 'en') return Object.assign({}, base);
  return Object.assign({}, base, DICTS[key] || {});
}

/** 与客户端 T() 完全一致的插值规则，供宿主侧文案使用。 */
export function translate(source, locale, params) {
  const dict = dictFor(locale);
  const hit = dict[source];
  let out = typeof hit === 'string' && hit !== '' ? hit : source;
  if (params && typeof params === 'object') {
    out = out.replace(/\{(\w+)\}/g, (whole, name) =>
      params[name] === undefined || params[name] === null ? whole : String(params[name]),
    );
  }
  return out;
}

/** 设置面板需要的下拉选项（自动 + 八种语言）。 */
export function localeOptions() {
  return [
    { value: AUTO_LOCALE, label: '自动 / Auto' },
    ...LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] })),
  ];
}
