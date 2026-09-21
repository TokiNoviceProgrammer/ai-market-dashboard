/**
 * @file i18n.js
 * @module i18n
 * @description
 *   多言語対応（国際化）を担当するモジュール。
 *
 *   【単一責任】
 *   1. locales/{locale}.json（UI 文字列辞書）の読み込みと保持。
 *   2. ドット記法キー（例: 'card.showDetail'）による UI 文字列の解決。
 *   3. データ側の多言語オブジェクト（例: { ja, en, ko }）から現在言語の値を取り出す。
 *   4. 日付・数値の言語別フォーマット。
 *
 *   DOM 操作は一切行わない。描画は render.js の責務。
 *
 *   【AI向けメモ】
 *   言語を追加する場合は (1) locales/xx.json を追加、(2) config/site.json の
 *   locales 配列に 'xx' を追加、(3) データ側の多言語オブジェクトに xx キーを追加。
 *   このファイルの変更は不要。
 */

import { fetchJson } from './config.js';

/**
 * i18n の内部状態。モジュールスコープに閉じており、外部からは関数経由でのみ操作する。
 * @type {{ locale: string, fallbackLocale: string, dictionary: Record<string, unknown>, availableLocales: string[], localePathTemplate: string }}
 */
const state = {
  locale: 'ja',
  fallbackLocale: 'ja',
  dictionary: {},
  availableLocales: ['ja'],
  localePathTemplate: 'locales/{locale}.json',
};

/**
 * 言語変更を購読しているコールバックの集合。
 * @type {Set<(locale: string) => void>}
 */
const listeners = new Set();

/**
 * i18n を初期化する。サイト設定から利用可能言語とパステンプレートを取り込む。
 * 辞書の読み込みは行わないため、続けて {@link setLocale} を呼ぶこと。
 *
 * @param {import('./config.js').SiteConfig} siteConfig - サイト設定。
 * @returns {void}
 */
export function initI18n(siteConfig) {
  state.availableLocales = siteConfig.locales ?? ['ja'];
  state.fallbackLocale = siteConfig.defaultLocale ?? state.availableLocales[0];
  state.localePathTemplate = siteConfig.paths?.locales ?? 'locales/{locale}.json';
}

/**
 * 現在選択されている言語コードを返す。
 *
 * @returns {string} 言語コード（例: 'ja'）。
 */
export function getLocale() {
  return state.locale;
}

/**
 * 利用可能な言語コードの一覧を返す。
 *
 * @returns {string[]} 言語コード配列。
 */
export function getAvailableLocales() {
  return [...state.availableLocales];
}

/**
 * 指定した言語に切り替え、対応する辞書を読み込む。
 * 読み込みに成功すると購読者（{@link onLocaleChange} で登録）へ通知する。
 *
 * @param {string} locale - 切り替え先の言語コード。
 * @returns {Promise<void>} 辞書の読み込み完了で解決する Promise。
 * @throws {Error} 辞書ファイルの取得に失敗し、フォールバックも失敗した場合。
 */
export async function setLocale(locale) {
  const target = state.availableLocales.includes(locale) ? locale : state.fallbackLocale;
  const url = state.localePathTemplate.replace('{locale}', target);

  try {
    state.dictionary = /** @type {Record<string, unknown>} */ (await fetchJson(url));
    state.locale = target;
  } catch (error) {
    if (target === state.fallbackLocale) {
      throw error;
    }
    // 指定言語の辞書が壊れていてもサイトを止めず、既定言語へ退避する。
    console.warn(`[i18n] Failed to load locale "${target}", falling back.`, error);
    await setLocale(state.fallbackLocale);
    return;
  }

  listeners.forEach((listener) => listener(state.locale));
}

/**
 * 言語変更を購読する。
 *
 * @param {(locale: string) => void} listener - 言語変更時に呼ばれるコールバック。
 * @returns {() => void} 購読を解除する関数。
 */
export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * UI 文字列辞書からドット記法キーで文字列を取得する。
 *
 * @param {string} key - ドット区切りのキー（例: 'card.showDetail'）。
 * @param {Record<string, string | number>} [params] - `{name}` 形式のプレースホルダ置換に使う値。
 * @returns {string} 解決された文字列。見つからない場合はキー自体を返す（デバッグしやすくするため）。
 *
 * @example
 * t('card.showDetail'); // → '詳細を見る'
 * t('header.lastUpdated', { time: '10:00' });
 */
export function t(key, params) {
  const resolved = key
    .split('.')
    .reduce(
      (node, segment) =>
        node && typeof node === 'object' ? /** @type {Record<string, unknown>} */ (node)[segment] : undefined,
      /** @type {unknown} */ (state.dictionary),
    );

  if (typeof resolved !== 'string') {
    return key;
  }
  if (!params) {
    return resolved;
  }
  return resolved.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * データ側の多言語オブジェクトから、現在の言語に対応する値を取り出す。
 * 現在言語のキーが無い場合は既定言語 → 最初に見つかった値の順にフォールバックする。
 *
 * @template T
 * @param {Partial<Record<string, T>> | T | null | undefined} field
 *   - 多言語オブジェクト（例: `{ ja: '…', en: '…' }`）。多言語でない素の値もそのまま返す。
 * @returns {T | undefined} 現在言語の値。取得できない場合は undefined。
 *
 * @example
 * pick({ ja: 'こんにちは', en: 'Hello' }); // locale が 'ja' なら 'こんにちは'
 * pick(['a', 'b']);                        // 多言語オブジェクトでなければそのまま返る
 */
export function pick(field) {
  if (field === null || field === undefined) {
    return undefined;
  }
  // 配列や文字列など、多言語オブジェクトでない値はそのまま返す。
  if (typeof field !== 'object' || Array.isArray(field)) {
    return /** @type {T} */ (field);
  }

  const record = /** @type {Record<string, T>} */ (field);
  if (record[state.locale] !== undefined) {
    return record[state.locale];
  }
  if (record[state.fallbackLocale] !== undefined) {
    return record[state.fallbackLocale];
  }
  const firstAvailable = Object.values(record).find((value) => value !== undefined);
  return firstAvailable;
}

/**
 * 現在言語の Intl ロケールタグを返す（例: 'ja' → 'ja-JP'）。
 * 辞書の meta.dateFormat が定義されていればそれを優先する。
 *
 * @returns {string} Intl に渡すロケールタグ。
 */
export function getIntlLocale() {
  const fromDictionary = t('meta.dateFormat');
  return fromDictionary === 'meta.dateFormat' ? state.locale : fromDictionary;
}

/**
 * ISO 8601 文字列を現在言語の日付表記にフォーマットする。
 *
 * @param {string | null | undefined} isoString - ISO 8601 形式の日時文字列。
 * @param {Intl.DateTimeFormatOptions} [options] - Intl.DateTimeFormat のオプション。
 * @returns {string} フォーマット済み文字列。入力が不正な場合は空文字。
 */
export function formatDate(isoString, options = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!isoString) {
    return '';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(getIntlLocale(), options).format(date);
}

/**
 * ISO 8601 文字列を現在言語の日時表記（分まで）にフォーマットする。
 *
 * @param {string | null | undefined} isoString - ISO 8601 形式の日時文字列。
 * @returns {string} フォーマット済み文字列。入力が不正な場合は空文字。
 */
export function formatDateTime(isoString) {
  return formatDate(isoString, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 数値を現在言語の表記にフォーマットする。
 *
 * @param {number | null | undefined} value - 対象の数値。
 * @param {Intl.NumberFormatOptions} [options] - Intl.NumberFormat のオプション。
 * @returns {string} フォーマット済み文字列。入力が数値でない場合は空文字。
 */
export function formatNumber(value, options = { maximumFractionDigits: 2 }) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '';
  }
  return new Intl.NumberFormat(getIntlLocale(), options).format(value);
}

/**
 * 前日比などの符号付き数値を、符号を明示してフォーマットする。
 *
 * @param {number | null | undefined} value - 対象の数値。
 * @param {{ suffix?: string, fractionDigits?: number }} [options] - オプション。
 * @param {string} [options.suffix=''] - 末尾に付与する単位（例: '%'）。
 * @param {number} [options.fractionDigits=2] - 小数点以下の桁数。
 * @returns {string} 例: '+3.14%' / '-1.01%'。入力が数値でない場合は空文字。
 */
export function formatSignedNumber(value, options = {}) {
  const { suffix = '', fractionDigits = 2 } = options;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '';
  }
  const formatted = new Intl.NumberFormat(getIntlLocale(), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay: 'exceptZero',
  }).format(value);
  return `${formatted}${suffix}`;
}
