/**
 * @file app.js
 * @module app
 * @description
 *   アプリケーションのエントリーポイント。
 *
 *   【単一責任】アプリ状態の保持と、各モジュールの協調（オーケストレーション）。
 *   - データ取得は config.js に委譲。
 *   - 文字列解決は i18n.js に委譲。
 *   - DOM 生成は render.js に委譲。
 *   このファイルが持つのは「状態」と「イベント → 状態変更 → 再描画」の流れだけ。
 *
 *   【データフロー】
 *     起動
 *       → config.loadAll()          … 設定とデータを取得
 *       → i18n.initI18n/setLocale() … 言語決定（URL ?lang= > localStorage > ブラウザ設定 > 既定）
 *       → refreshAll()              … 全体を描画
 *     言語切替ボタン
 *       → setLocale()               … 辞書を差し替え
 *       → refreshAll()              … 再描画
 *     カテゴリタブ
 *       → state.activeCategoryId 更新
 *       → renderDashboard()         … 本体のみ再描画
 *
 *   【AI向けメモ】
 *   新しい UI 機能を足す場合は、(1) state に状態を追加、(2) render.js に描画関数を追加、
 *   (3) このファイルで両者をつなぐ、という順序で行うと構造が崩れない。
 */

import { loadAll, loadDashboardData } from './config.js';
import {
  initI18n,
  setLocale,
  getLocale,
  getAvailableLocales,
  t,
  pick,
  formatDateTime,
} from './i18n.js';
import {
  renderCategoryTabs,
  renderDashboard,
  renderLanguageSwitcher,
  renderMonetizationPlacement,
  renderDonation,
  renderDataSources,
  renderStatus,
} from './render.js';

/**
 * アプリ全体の状態。
 * この単一オブジェクトが唯一の真実の源（single source of truth）である。
 *
 * @type {{
 *   site: import('./config.js').SiteConfig | null,
 *   categoryConfig: import('./config.js').CategoryConfig | null,
 *   monetization: import('./config.js').MonetizationConfig | null,
 *   data: import('./config.js').DashboardData | null,
 *   activeCategoryId: string,
 *   localeLabels: Record<string, string>
 * }}
 */
const state = {
  site: null,
  categoryConfig: null,
  monetization: null,
  data: null,
  activeCategoryId: 'all',
  localeLabels: {},
};

/**
 * 頻繁に参照する DOM 要素への参照をまとめたもの。
 * 初期化時に {@link cacheElements} で一度だけ取得する。
 *
 * @type {Record<string, HTMLElement>}
 */
const dom = {};

/**
 * DOM 要素の参照をキャッシュする。
 *
 * @returns {void}
 * @throws {Error} 必須要素が見つからない場合。
 */
function cacheElements() {
  /** @type {Record<string, string>} */
  const selectors = {
    appTitle: '#app-title',
    appSubtitle: '#app-subtitle',
    languageSwitcher: '#language-switcher',
    languageLabel: '#language-label',
    lastUpdated: '#last-updated',
    lastUpdatedLabel: '#last-updated-label',
    refreshButton: '#refresh-button',
    categoryTabs: '#category-tabs',
    dashboard: '#dashboard',
    status: '#status-area',
    headerSlots: '#header-slots',
    asideSlots: '#aside-slots',
    footerSlots: '#footer-slots',
    donation: '#donation-area',
    supportHeading: '#support-heading',
    supportDescription: '#support-description',
    dataSources: '#data-sources',
    disclaimer: '#disclaimer',
    copyright: '#copyright',
    skipLink: '#skip-link',
    notice: '#data-notice',
  };

  for (const [key, selector] of Object.entries(selectors)) {
    const node = document.querySelector(selector);
    if (!node) {
      throw new Error(`Required element not found: ${selector}`);
    }
    dom[key] = /** @type {HTMLElement} */ (node);
  }
}

/**
 * 使用する言語を決定する。
 * 優先順位: URL クエリ `?lang=` > localStorage > ブラウザ設定 > 既定言語。
 *
 * @param {import('./config.js').SiteConfig} site - サイト設定。
 * @returns {string} 決定された言語コード。
 */
function resolveInitialLocale(site) {
  const available = site.locales ?? [];

  const fromQuery = new URLSearchParams(window.location.search).get('lang');
  if (fromQuery && available.includes(fromQuery)) {
    return fromQuery;
  }

  try {
    const stored = localStorage.getItem(site.localeStorageKey);
    if (stored && available.includes(stored)) {
      return stored;
    }
  } catch {
    // プライベートブラウジング等で localStorage が使えない場合は無視する。
  }

  for (const preferred of navigator.languages ?? []) {
    const base = preferred.split('-')[0];
    if (available.includes(base)) {
      return base;
    }
  }

  return site.defaultLocale ?? available[0] ?? 'ja';
}

/**
 * 選択言語を localStorage に保存する。保存に失敗しても処理は続行する。
 *
 * @param {string} locale - 保存する言語コード。
 * @returns {void}
 */
function persistLocale(locale) {
  try {
    localStorage.setItem(/** @type {import('./config.js').SiteConfig} */ (state.site).localeStorageKey, locale);
  } catch {
    // localStorage が使えない環境では永続化を諦める（機能自体は動作する）。
  }
}

/**
 * 各言語辞書の meta.label を読み込み、言語切り替えボタンのラベルを作る。
 * 各辞書は fetchJson によりキャッシュされるため、2 回目以降は通信が発生しない。
 *
 * @param {import('./config.js').SiteConfig} site - サイト設定。
 * @returns {Promise<Record<string, string>>} 言語コード → 短縮ラベルの対応表。
 */
async function loadLocaleLabels(site) {
  const { fetchJson } = await import('./config.js');
  /** @type {Record<string, string>} */
  const labels = {};

  await Promise.all(
    (site.locales ?? []).map(async (locale) => {
      try {
        const dict = /** @type {{ meta?: { shortLabel?: string, label?: string } }} */ (
          await fetchJson(site.paths.locales.replace('{locale}', locale))
        );
        labels[locale] = dict.meta?.shortLabel ?? dict.meta?.label ?? locale.toUpperCase();
      } catch {
        labels[locale] = locale.toUpperCase();
      }
    }),
  );

  return labels;
}

/**
 * 現在の言語・データに基づき、静的な UI テキストを更新する。
 *
 * @returns {void}
 */
function refreshStaticText() {
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.title = t('app.title');

  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.setAttribute('content', t('app.description'));
  }

  dom.appTitle.textContent = t('app.title');
  dom.appSubtitle.textContent = t('app.subtitle');
  dom.languageLabel.textContent = t('header.languageLabel');
  dom.lastUpdatedLabel.textContent = `${t('header.lastUpdated')}:`;
  dom.refreshButton.setAttribute('aria-label', t('header.refresh'));
  dom.refreshButton.setAttribute('title', t('header.refresh'));
  dom.categoryTabs.setAttribute('aria-label', t('nav.filterLabel'));
  dom.supportHeading.textContent = t('support.heading');
  dom.supportDescription.textContent = t('support.description');
  dom.disclaimer.textContent = t('footer.disclaimer');
  dom.skipLink.textContent = t('header.skipToContent');
  dom.copyright.textContent = `© ${new Date().getFullYear()} ${t('footer.copyright')}`;

  if (state.data?.generatedAt) {
    dom.lastUpdated.textContent = formatDateTime(state.data.generatedAt);
    dom.lastUpdated.setAttribute('datetime', state.data.generatedAt);
  }

  const notice = pick(state.data?.notice);
  if (notice) {
    dom.notice.textContent = notice;
    dom.notice.hidden = false;
  } else {
    dom.notice.hidden = true;
  }
}

/**
 * ダッシュボード本体（タブ + カード群）を再描画する。
 *
 * @returns {void}
 */
function refreshDashboard() {
  if (!state.categoryConfig || !state.data || !state.monetization) {
    return;
  }

  renderCategoryTabs(dom.categoryTabs, state.categoryConfig.categories, state.activeCategoryId);

  const inlineSlots = (state.monetization.slots ?? []).filter((slot) => slot.placement === 'cardDetail');

  renderDashboard(dom.dashboard, {
    categoryConfig: state.categoryConfig,
    items: state.data.items,
    activeCategoryId: state.activeCategoryId,
    inlineSlots,
  });
}

/**
 * 画面全体を再描画する。言語切り替え時やデータ再取得時に呼ぶ。
 *
 * @returns {void}
 */
function refreshAll() {
  if (!state.site || !state.monetization) {
    return;
  }

  refreshStaticText();
  renderLanguageSwitcher(dom.languageSwitcher, getAvailableLocales(), getLocale(), state.localeLabels);
  renderMonetizationPlacement(dom.headerSlots, state.monetization, 'header');
  renderMonetizationPlacement(dom.asideSlots, state.monetization, 'aside');
  renderMonetizationPlacement(dom.footerSlots, state.monetization, 'footer');
  renderDonation(dom.donation, state.monetization);
  renderDataSources(dom.dataSources, state.site.dataSources ?? []);
  refreshDashboard();
}

/**
 * 言語を切り替え、永続化して再描画する。
 *
 * @param {string} locale - 切り替え先の言語コード。
 * @returns {Promise<void>}
 */
async function changeLocale(locale) {
  if (locale === getLocale()) {
    return;
  }
  await setLocale(locale);
  persistLocale(getLocale());

  // URL のクエリも更新しておくと、その言語の状態を共有できる。
  const url = new URL(window.location.href);
  url.searchParams.set('lang', getLocale());
  window.history.replaceState({}, '', url);

  refreshAll();
}

/**
 * データを再取得して再描画する。
 *
 * @returns {Promise<void>}
 */
async function reloadData() {
  if (!state.site) {
    return;
  }
  dom.refreshButton.setAttribute('disabled', '');
  dom.refreshButton.classList.add('animate-spin');
  try {
    state.data = await loadDashboardData(state.site, { noCache: true });
    refreshStaticText();
    refreshDashboard();
    renderStatus(dom.status, null);
  } catch (error) {
    renderStatus(dom.status, 'error', {
      message: error instanceof Error ? error.message : String(error),
      onRetry: () => void reloadData(),
    });
  } finally {
    dom.refreshButton.removeAttribute('disabled');
    dom.refreshButton.classList.remove('animate-spin');
  }
}

/**
 * イベントリスナを登録する。
 * 動的に生成される要素はイベント委譲で扱うため、リスナの登録は起動時の一度きりでよい。
 *
 * @returns {void}
 */
function bindEvents() {
  // 言語切り替え（委譲）。
  dom.languageSwitcher.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('[data-locale]');
    if (button instanceof HTMLElement && button.dataset.locale) {
      void changeLocale(button.dataset.locale);
    }
  });

  // カテゴリタブ（委譲）。
  dom.categoryTabs.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('[data-category-id]');
    if (button instanceof HTMLElement && button.dataset.categoryId) {
      state.activeCategoryId = button.dataset.categoryId;
      refreshDashboard();
    }
  });

  // 再読み込み。
  dom.refreshButton.addEventListener('click', () => void reloadData());

  // アコーディオンのラベル切り替え（「詳細を見る」⇄「詳細を閉じる」）。
  // <details> の toggle はバブリングしないため、キャプチャフェーズで拾う。
  dom.dashboard.addEventListener(
    'toggle',
    (event) => {
      const details = /** @type {HTMLElement} */ (event.target);
      if (!(details instanceof HTMLDetailsElement)) {
        return;
      }
      const label = details.querySelector('[data-detail-label]');
      if (label) {
        label.textContent = details.open ? t('card.hideDetail') : t('card.showDetail');
      }
    },
    true,
  );

  // ブラウザの戻る/進むで言語が変わった場合に追従する。
  window.addEventListener('popstate', () => {
    const lang = new URLSearchParams(window.location.search).get('lang');
    if (lang && lang !== getLocale()) {
      void changeLocale(lang);
    }
  });
}

/**
 * アプリを起動する。
 * 設定とデータを取得し、言語を決定して初回描画を行う。
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  cacheElements();
  renderStatus(dom.status, 'loading');

  try {
    const { site, categories, monetization, data } = await loadAll();
    state.site = site;
    state.categoryConfig = categories;
    state.monetization = monetization;
    state.data = data;
    state.activeCategoryId = categories.defaultCategoryId ?? 'all';

    initI18n(site);
    await setLocale(resolveInitialLocale(site));
    state.localeLabels = await loadLocaleLabels(site);

    bindEvents();
    refreshAll();
    renderStatus(dom.status, null);
  } catch (error) {
    console.error('[app] bootstrap failed', error);
    // 辞書の読み込み前に失敗した場合でも最低限のメッセージを出せるよう、
    // t() がキーをそのまま返す挙動を利用せず、素のテキストを併記する。
    renderStatus(dom.status ?? document.body, 'error', {
      message: error instanceof Error ? error.message : String(error),
      onRetry: () => window.location.reload(),
    });
  }
}

// DOM 構築後に起動する。index.html 側で type="module" + defer 相当のため
// 通常は readyState === 'loading' ではないが、念のため両方に対応する。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void bootstrap());
} else {
  void bootstrap();
}
