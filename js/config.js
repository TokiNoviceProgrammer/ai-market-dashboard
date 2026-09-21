/**
 * @file config.js
 * @module config
 * @description
 *   設定ファイル（config/*.json）とデータファイル（data/dashboard.json）の
 *   読み込みだけを担当するモジュール。
 *
 *   【単一責任】ネットワーク越しの JSON 取得と、その結果のメモリキャッシュ。
 *   HTML 生成・国際化・イベント処理は一切行わない。
 *
 *   【AI向けメモ】
 *   データソースを差し替えたい場合（例: 外部 API を直接叩く）は、
 *   このファイルの `fetchJson` か、`loadDashboardData` の中だけを変更すれば足りる。
 *   呼び出し側（render.js / app.js）の変更は不要。
 */

/**
 * サイト全体設定ファイルのパス。
 * ここだけが唯一ハードコードされたパスであり、他のパスは site.json から解決される。
 * @constant {string}
 */
export const SITE_CONFIG_PATH = 'config/site.json';

/**
 * 取得済み JSON のメモリキャッシュ。キーは URL。
 * 同一 URL への重複リクエストを防ぐ。
 * @type {Map<string, Promise<unknown>>}
 */
const cache = new Map();

/**
 * JSON ファイルを取得する。同一 URL に対する結果はキャッシュされる。
 *
 * @param {string} url - 取得対象の URL（サイトルートからの相対パス可）。
 * @param {{ noCache?: boolean }} [options] - オプション。
 * @param {boolean} [options.noCache=false] - true の場合キャッシュを無視して再取得する。
 * @returns {Promise<unknown>} パース済み JSON。
 * @throws {Error} HTTP ステータスが 2xx でない場合、または JSON パースに失敗した場合。
 */
export async function fetchJson(url, options = {}) {
  const { noCache = false } = options;

  if (!noCache && cache.has(url)) {
    return cache.get(url);
  }

  const promise = (async () => {
    const response = await fetch(url, { cache: noCache ? 'reload' : 'default' });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new Error(`Failed to parse JSON from ${url}`, { cause });
    }
  })();

  cache.set(url, promise);

  // 失敗した Promise をキャッシュに残すと永続的に失敗し続けるため、失敗時は除去する。
  promise.catch(() => cache.delete(url));

  return promise;
}

/**
 * サイト全体設定（config/site.json）を読み込む。
 *
 * @returns {Promise<SiteConfig>} サイト設定オブジェクト。
 */
export async function loadSiteConfig() {
  return /** @type {Promise<SiteConfig>} */ (fetchJson(SITE_CONFIG_PATH));
}

/**
 * カテゴリ設定（config/categories.json）を読み込み、
 * enabled なカテゴリのみを order 昇順に整列して返す。
 *
 * @param {SiteConfig} siteConfig - サイト設定。パス解決に使用する。
 * @returns {Promise<CategoryConfig>} カテゴリ設定（categories は整列済み）。
 */
export async function loadCategories(siteConfig) {
  const raw = /** @type {CategoryConfig} */ (await fetchJson(siteConfig.paths.categories));
  const categories = (raw.categories ?? [])
    .filter((category) => category.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { ...raw, categories };
}

/**
 * 収益化設定（config/monetization.json）を読み込む。
 * 設定ファイルが存在しない場合でもサイトが壊れないよう、失敗時は空設定を返す。
 *
 * @param {SiteConfig} siteConfig - サイト設定。パス解決に使用する。
 * @returns {Promise<MonetizationConfig>} 収益化設定。
 */
export async function loadMonetization(siteConfig) {
  try {
    return /** @type {MonetizationConfig} */ (await fetchJson(siteConfig.paths.monetization));
  } catch {
    return { version: 0, donation: { enabled: false }, slots: [] };
  }
}

/**
 * ダッシュボードデータ（data/dashboard.json）を読み込む。
 *
 * 【AI向け拡張ポイント】
 * 外部 API を直接呼びたい場合は、この関数の中で fetch 先を差し替えるか、
 * 取得結果を DashboardData 形式（items[] を持つオブジェクト）に整形して返すこと。
 *
 * @param {SiteConfig} siteConfig - サイト設定。パス解決に使用する。
 * @param {{ noCache?: boolean }} [options] - オプション。再読み込み時は noCache: true を指定。
 * @returns {Promise<DashboardData>} ダッシュボードデータ（items は order 昇順に整列済み）。
 */
export async function loadDashboardData(siteConfig, options = {}) {
  const raw = /** @type {DashboardData} */ (
    await fetchJson(siteConfig.paths.data, options)
  );
  const items = [...(raw.items ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { ...raw, items };
}

/**
 * アプリの起動に必要な設定・データをまとめて取得する。
 *
 * @param {{ noCache?: boolean }} [options] - オプション。
 * @returns {Promise<{ site: SiteConfig, categories: CategoryConfig, monetization: MonetizationConfig, data: DashboardData }>}
 *   起動に必要な全リソース。
 */
export async function loadAll(options = {}) {
  const site = await loadSiteConfig();
  const [categories, monetization, data] = await Promise.all([
    loadCategories(site),
    loadMonetization(site),
    loadDashboardData(site, options),
  ]);
  return { site, categories, monetization, data };
}

/* -------------------------------------------------------------------------- */
/* 型定義（JSDoc typedef）                                                     */
/* AI がデータ構造を把握するための正式な型情報。実行時には影響しない。          */
/* -------------------------------------------------------------------------- */

/**
 * 言語コード。
 * @typedef {'ja' | 'en' | 'ko'} LocaleCode
 */

/**
 * 多言語文字列。全言語のキーを持つ想定だが、欠落時は i18n.js がフォールバックする。
 * @typedef {Partial<Record<LocaleCode, string>>} LocalizedString
 */

/**
 * 多言語文字列配列（要約の3行など）。
 * @typedef {Partial<Record<LocaleCode, string[]>>} LocalizedStringArray
 */

/**
 * サイト全体設定（config/site.json）。
 * @typedef {Object} SiteConfig
 * @property {number} version - 設定スキーマのバージョン。
 * @property {LocaleCode[]} locales - 有効な言語コード一覧。
 * @property {LocaleCode} defaultLocale - 既定の言語。
 * @property {string} localeStorageKey - 選択言語を保存する localStorage キー。
 * @property {string} themeStorageKey - テーマを保存する localStorage キー。
 * @property {{ locales: string, categories: string, monetization: string, data: string }} paths
 *   - 各リソースのパス。locales には `{locale}` プレースホルダを含む。
 * @property {{ repository?: string }} [links] - 外部リンク。
 * @property {{ name: string, url: string }[]} [dataSources] - フッターに表示するデータ出典。
 */

/**
 * カテゴリ定義（config/categories.json の categories 要素）。
 * @typedef {Object} Category
 * @property {string} id - カテゴリ識別子。items[].categoryId と対応する。
 * @property {number} order - 表示順（昇順）。
 * @property {boolean} [enabled=true] - false の場合は非表示。
 * @property {string} [icon] - アイコン識別子（icons.js のキー）。
 * @property {string} [accent] - アクセント色キー（categories.json の accents と対応）。
 * @property {'news' | 'equity' | 'macro'} cardType - カードの描画方式。
 * @property {LocalizedString} label - カテゴリ名。
 * @property {LocalizedString} [description] - カテゴリ説明。
 * @property {string[]} [fields] - このカテゴリで表示する項目のリスト。
 */

/**
 * カテゴリ設定ファイル全体。
 * @typedef {Object} CategoryConfig
 * @property {number} version - 設定スキーマのバージョン。
 * @property {string} [defaultCategoryId] - 初期選択カテゴリ。'all' で全件。
 * @property {Category[]} categories - カテゴリ一覧。
 * @property {Record<string, { description: string, requiredFields: string[], optionalFields: string[] }>} [cardTypes]
 *   - カードタイプの仕様（ドキュメント用途）。
 * @property {Record<string, { badge: string, bar: string }>} [accents] - アクセント色と Tailwind クラスの対応。
 */

/**
 * 株価・指標のクオート情報。
 * @typedef {Object} Quote
 * @property {string} [ticker] - ティッカーシンボル。
 * @property {string} [symbol] - 指標シンボル（マクロ指標の場合）。
 * @property {string} [exchange] - 取引所。
 * @property {string} [currency] - 通貨コード。
 * @property {number} [price] - 最新価格。
 * @property {number} [value] - 最新値（マクロ指標の場合）。
 * @property {number} [previousClose] - 前日終値。
 * @property {number} [change] - 前日比（絶対値）。
 * @property {number} [changePercent] - 前日比（%）。
 * @property {string} [marketCap] - 時価総額（表示用文字列）。
 * @property {string} [unit] - 単位（'%' など）。
 * @property {string} [asOf] - 基準時刻（ISO 8601）。
 */

/**
 * IR 資料への参照。
 * @typedef {Object} IrDocument
 * @property {string} date - 公開日（YYYY-MM-DD）。
 * @property {string} url - 資料 URL。
 * @property {LocalizedString} title - 資料タイトル。
 */

/**
 * ダッシュボードに表示する 1 枚のカード。
 * @typedef {Object} DashboardItem
 * @property {string} id - 一意な識別子。DOM の id やアコーディオン制御に使用する。
 * @property {string} categoryId - 所属カテゴリ。Category.id と対応。
 * @property {number} [order] - カテゴリ内の表示順。
 * @property {LocalizedString} title - カードタイトル。
 * @property {LocalizedStringArray} summary - 要約（3行程度の配列）。
 * @property {LocalizedStringArray} [highlights] - 短いキーワード群（バッジ表示）。
 * @property {LocalizedString} [detail] - アコーディオン内に表示する本文。改行は \n\n で段落分割。
 * @property {Quote} [quote] - 株価情報（cardType === 'equity'）。
 * @property {Quote} [metric] - 指標情報（cardType === 'macro'）。
 * @property {IrDocument[]} [irDocuments] - IR 資料一覧。
 * @property {string[]} [tags] - タグ（言語非依存の固有名詞のみを想定）。
 * @property {string} [publishedAt] - 公開日時（ISO 8601）。
 * @property {{ name: string, url: string }} [source] - 出典。
 * @property {'positive' | 'negative' | 'neutral'} [sentiment] - センチメント。
 * @property {'high' | 'medium' | 'low'} [impact] - 重要度。
 */

/**
 * ダッシュボードデータ全体（data/dashboard.json）。
 * @typedef {Object} DashboardData
 * @property {number} schemaVersion - データスキーマのバージョン。
 * @property {string} generatedAt - 生成日時（ISO 8601）。
 * @property {string} [generator] - 生成したスクリプト名。
 * @property {LocalizedString} [notice] - データに関する注意書き。
 * @property {DashboardItem[]} items - カード一覧。
 */

/**
 * 収益化設定（config/monetization.json）。
 * @typedef {Object} MonetizationConfig
 * @property {number} version - 設定スキーマのバージョン。
 * @property {{ enabled: boolean, provider?: string, url?: string, label?: LocalizedString }} donation
 *   - 投げ銭ボタンの設定。
 * @property {MonetizationSlot[]} slots - 広告・アフィリエイト枠の一覧。
 */

/**
 * 広告・アフィリエイト枠 1 つ分の設定。
 * @typedef {Object} MonetizationSlot
 * @property {string} id - スロット識別子。
 * @property {'header' | 'aside' | 'cardDetail' | 'footer'} placement - 配置場所。
 * @property {boolean} enabled - false の場合は描画されない。
 * @property {'banner' | 'list' | 'text'} [format] - 表示形式。
 * @property {string} [note] - 運用者向けのメモ（画面には表示されない）。
 * @property {string} [html] - 生 HTML（ASP の提供タグ）。指定時はこれが優先される。
 * @property {{ url: string, label: LocalizedString, imageUrl?: string }} [link] - 単一リンク。
 * @property {{ url: string, label: LocalizedString }[]} [items] - リンク一覧（format === 'list'）。
 */
