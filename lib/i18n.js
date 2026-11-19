/* dsh-agnes-create — 多语言字典（宿主侧）。
 *
 * 设计：中文原文就是字典 key，所以 zh 是恒等映射、不需要字典文件；
 * 其它语言的文件里是 { "中文原文": "译文" }。
 *
 * 0.14.0 起文案由宿主 locale 服务负责：客户端把这里的七份字典 + 一份 zh 恒等表
 * register 进自己的命名空间，再 locale.bind(ns)，于是宿主切语言时自动跟着变。
 * 这个文件只负责「把字典交出去」，不再自己做语言选择。
 */
import en from './locales/en.js';
import ja from './locales/ja.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import pt from './locales/pt.js';
import ru from './locales/ru.js';
import es from './locales/es.js';

/* 顺序即宿主语言列表里的顺序：中文在最前 */
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

/* Electron / 浏览器 / 宿主给的可能是 zh-Hans、en-US、pt_BR 这类标签，归一到基础语言 */
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

/** 把任意语言标签归一成受支持的语言代码；不认识返回 null。 */
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
