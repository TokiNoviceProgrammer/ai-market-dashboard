/**
 * @file render.js
 * @module render
 * @description
 *   データと設定から DOM を組み立てる描画モジュール。
 *
 *   【単一責任】「状態 → DOM」の変換のみ。
 *   - データ取得は行わない（config.js の責務）。
 *   - 文字列の言語解決は i18n.js に委譲する。
 *   - イベントリスナの登録は app.js の責務（例外: アコーディオンの開閉は
 *     `<details>` 要素のネイティブ挙動を使うため JS 不要）。
 *
 *   【描画の全体構造】
 *     renderCategoryTabs()  … カテゴリ絞り込みタブ
 *     renderDashboard()     … カテゴリごとのセクション + カード群
 *       └ renderCard()      … カード 1 枚（サマリ + <details> による詳細）
 *            ├ renderQuoteBlock()   … 株価・指標の数値ブロック
 *            ├ renderSummaryList()  … 3 行要約
 *            └ renderDetailBody()   … アコーディオン内の本文・IR 資料・出典
 *     renderMonetizationSlot() … 広告・アフィリエイト枠
 *
 *   【AI向けメモ】
 *   新しい cardType を追加する場合は、config/categories.json の cardTypes に
 *   定義を足し、renderCard() 内の分岐に対応する描画を追加する。
 */

import { el, externalLink, fragment, clear, setTrustedHtml } from './dom.js';
import { icon } from './icons.js';
import { t, pick, formatDate, formatDateTime, formatNumber, formatSignedNumber } from './i18n.js';

/**
 * 前日比の符号に応じた Tailwind クラス。
 * @type {{ up: string, down: string, flat: string }}
 */
const CHANGE_CLASSES = {
  up: 'text-emerald-400',
  down: 'text-rose-400',
  flat: 'text-slate-400',
};

/**
 * センチメントに応じたバッジのクラス。
 * @type {Record<string, string>}
 */
const SENTIMENT_CLASSES = {
  positive: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  negative: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  neutral: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
};

/**
 * 重要度に応じたバッジのクラス。
 * @type {Record<string, string>}
 */
const IMPACT_CLASSES = {
  high: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  medium: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  low: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
};

/**
 * 数値の符号から色クラスのキーを求める。
 *
 * @param {number | null | undefined} value - 判定対象の数値。
 * @returns {'up' | 'down' | 'flat'} 符号に対応するキー。
 */
function signOf(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || value === 0) {
    return 'flat';
  }
  return value > 0 ? 'up' : 'down';
}

/**
 * 小さなバッジ（ピル）要素を生成する。
 *
 * @param {string} label - 表示テキスト。
 * @param {string} [extraClass=''] - 追加のクラス（色指定など）。
 * @returns {HTMLElement} バッジ要素。
 */
function badge(label, extraClass = '') {
  return el('span', {
    className:
      'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap ' +
      (extraClass || 'bg-slate-500/15 text-slate-300 ring-slate-500/30'),
    text: label,
  });
}

/**
 * カテゴリ絞り込みタブを描画する。
 * 各ボタンには `data-category-id` が付き、app.js がイベント委譲で拾う。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {import('./config.js').Category[]} categories - カテゴリ一覧。
 * @param {string} activeCategoryId - 選択中のカテゴリ ID（'all' で全件）。
 * @returns {void}
 */
export function renderCategoryTabs(container, categories, activeCategoryId) {
  clear(container);

  /**
   * タブボタンを 1 つ生成する内部ヘルパー。
   * @param {string} id - カテゴリ ID。
   * @param {string} label - 表示ラベル。
   * @param {string} [iconName] - アイコン名。
   * @returns {HTMLElement} ボタン要素。
   */
  const tab = (id, label, iconName) => {
    const isActive = id === activeCategoryId;
    const button = el('button', {
      className:
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
        (isActive
          ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
          : 'border-slate-700/80 bg-slate-900/40 text-slate-300 hover:border-slate-500 hover:text-slate-100'),
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(isActive) },
      dataset: { categoryId: id },
    });
    if (iconName) {
      button.appendChild(icon(iconName, { className: 'w-3.5 h-3.5' }));
    }
    button.appendChild(el('span', { text: label }));
    return button;
  };

  const tabs = [tab('all', t('nav.all'), 'grid')];
  for (const category of categories) {
    tabs.push(tab(category.id, pick(category.label) ?? category.id, category.icon));
  }
  container.appendChild(fragment(tabs));
}

/**
 * 株価・マクロ指標の数値ブロックを描画する。
 * 価格・前日比・前日比率・時価総額・基準時刻を表示する。
 *
 * @param {import('./config.js').Quote} quote - クオート情報。
 * @returns {HTMLElement} 数値ブロック要素。
 */
function renderQuoteBlock(quote) {
  const value = quote.price ?? quote.value;
  const sign = signOf(quote.change);
  const unit = quote.unit && quote.unit !== quote.currency ? quote.unit : '';

  // 金利など単位が '%' の指標は、変化幅が 0.01 未満のことが多い。
  // 小数 2 桁のままだと「0.00」と表示されて変化が消えるため桁数を増やす。
  const isRateLike = unit === '%';
  const valueDigits = isRateLike ? 2 : 2;
  const changeDigits = isRateLike ? 3 : 2;

  const priceText = el('div', {
    className: 'flex items-baseline gap-1.5',
    children: [
      el('span', {
        className: 'text-2xl font-semibold tabular-nums tracking-tight text-slate-50',
        text: formatNumber(value, {
          minimumFractionDigits: valueDigits,
          maximumFractionDigits: valueDigits,
        }),
      }),
      el('span', {
        className: 'text-xs font-medium text-slate-400',
        text: unit || quote.currency || '',
      }),
    ],
  });

  const changeParts = [
    formatSignedNumber(quote.change, { fractionDigits: changeDigits }),
    typeof quote.changePercent === 'number'
      ? `(${formatSignedNumber(quote.changePercent, { suffix: '%' })})`
      : '',
  ].filter(Boolean);

  const changeText = el('div', {
    className: `flex items-center gap-1 text-sm font-medium tabular-nums ${CHANGE_CLASSES[sign]}`,
    children: [
      el('span', { text: sign === 'up' ? '▲' : sign === 'down' ? '▼' : '—', className: 'text-[10px]' }),
      el('span', { text: changeParts.join(' ') }),
    ],
  });

  /** @type {HTMLElement[]} */
  const metaRows = [];
  const symbol = quote.ticker ?? quote.symbol;
  if (symbol) {
    metaRows.push(
      badge(quote.exchange ? `${symbol} · ${quote.exchange}` : symbol, 'bg-slate-800 text-slate-300 ring-slate-700'),
    );
  }
  if (quote.marketCap) {
    metaRows.push(
      el('span', {
        className: 'text-[11px] text-slate-400',
        text: `${t('card.marketCap')}: ${quote.marketCap}`,
      }),
    );
  }

  return el('div', {
    className: 'rounded-lg border border-slate-800 bg-slate-900/50 px-3.5 py-3',
    children: [
      el('div', {
        className: 'flex flex-wrap items-end justify-between gap-x-4 gap-y-1',
        children: [
          el('div', { children: [priceText, changeText] }),
          metaRows.length
            ? el('div', { className: 'flex flex-col items-end gap-1', children: metaRows })
            : null,
        ],
      }),
      quote.asOf
        ? el('p', {
            className: 'mt-2 text-[11px] text-slate-500',
            text: formatDateTime(quote.asOf),
          })
        : null,
    ],
  });
}

/**
 * 3 行要約のリストを描画する。
 *
 * @param {string[]} lines - 要約の各行。
 * @returns {HTMLElement} `<ul>` 要素。
 */
function renderSummaryList(lines) {
  return el('ul', {
    className: 'space-y-1.5',
    children: lines.map((line) =>
      el('li', {
        className: 'flex gap-2 text-sm leading-relaxed text-slate-300',
        children: [
          el('span', { className: 'mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-600' }),
          el('span', { text: line }),
        ],
      }),
    ),
  });
}

/**
 * アコーディオン内の詳細本文を描画する。
 * 本文は `\n\n` を段落区切りとして複数の `<p>` に分割する。
 *
 * @param {import('./config.js').DashboardItem} item - 対象カード。
 * @param {import('./config.js').MonetizationSlot[]} inlineSlots
 *   - カード詳細内に差し込む広告枠（placement === 'cardDetail'）。
 * @returns {HTMLElement} 詳細本文のコンテナ要素。
 */
function renderDetailBody(item, inlineSlots) {
  /** @type {(HTMLElement | null)[]} */
  const blocks = [];

  const detailText = pick(item.detail);
  if (detailText) {
    blocks.push(
      el('div', {
        className: 'space-y-3',
        children: detailText
          .split(/\n{2,}/)
          .map((paragraph) =>
            el('p', {
              className: 'text-sm leading-7 text-slate-300',
              text: paragraph.trim(),
            }),
          ),
      }),
    );
  }

  if (item.irDocuments?.length) {
    blocks.push(
      el('div', {
        className: 'space-y-2',
        children: [
          el('h4', {
            className: 'text-xs font-semibold uppercase tracking-wide text-slate-400',
            text: 'IR',
          }),
          el('ul', {
            className: 'space-y-1.5',
            children: item.irDocuments.map((doc) =>
              el('li', {
                className: 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm',
                children: [
                  el('span', {
                    className: 'tabular-nums text-xs text-slate-500',
                    text: formatDate(doc.date),
                  }),
                  externalLink(doc.url, pick(doc.title) ?? doc.url, {
                    className:
                      'text-sky-300 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-200',
                  }),
                ],
              }),
            ),
          }),
        ],
      }),
    );
  }

  // 詳細内のアフィリエイト枠（設定で有効化された場合のみ）。
  for (const slot of inlineSlots) {
    const node = renderMonetizationSlot(slot);
    if (node) {
      blocks.push(node);
    }
  }

  if (item.source?.url) {
    blocks.push(
      el('p', {
        className: 'flex items-center gap-1.5 text-xs text-slate-500',
        children: [
          el('span', { text: `${t('card.source')}:` }),
          externalLink(item.source.url, item.source.name ?? item.source.url, {
            className: 'inline-flex items-center gap-1 text-slate-400 underline underline-offset-2 hover:text-slate-200',
          }),
        ],
      }),
    );
  }

  return el('div', { className: 'space-y-4', children: blocks });
}

/**
 * カード 1 枚を描画する。
 *
 * サマリ部（タイトル・バッジ・数値・3 行要約）は常時表示、
 * 詳細部は `<details>`/`<summary>` のネイティブアコーディオンで開閉する。
 * JS に依存しないため、スクリプトが失敗しても詳細が閲覧可能である。
 *
 * @param {import('./config.js').DashboardItem} item - 描画対象のカード。
 * @param {import('./config.js').Category} category - 所属カテゴリ。
 * @param {import('./config.js').CategoryConfig} categoryConfig - カテゴリ設定全体（accents 参照用）。
 * @param {import('./config.js').MonetizationSlot[]} [inlineSlots=[]] - 詳細内に差し込む広告枠。
 * @returns {HTMLElement} `<article>` 要素。
 */
export function renderCard(item, category, categoryConfig, inlineSlots = []) {
  const accent = categoryConfig.accents?.[category.accent ?? ''] ?? null;

  /** @type {(HTMLElement | null)[]} */
  const badges = [];
  if (item.impact) {
    badges.push(badge(t(`impact.${item.impact}`), IMPACT_CLASSES[item.impact]));
  }
  if (item.sentiment) {
    badges.push(badge(t(`sentiment.${item.sentiment}`), SENTIMENT_CLASSES[item.sentiment]));
  }

  const header = el('div', {
    className: 'flex items-start justify-between gap-3',
    children: [
      el('div', {
        className: 'min-w-0 space-y-1.5',
        children: [
          el('div', {
            className: 'flex flex-wrap items-center gap-1.5',
            children: [
              badge(pick(category.label) ?? category.id, accent?.badge),
              ...badges,
            ],
          }),
          el('h3', {
            className: 'text-base font-semibold leading-snug text-slate-50',
            text: pick(item.title) ?? item.id,
          }),
        ],
      }),
    ],
  });

  const quote = item.quote ?? item.metric;
  const summaryLines = pick(item.summary) ?? [];
  const highlights = pick(item.highlights) ?? [];

  /** @type {(HTMLElement | null)[]} */
  const body = [
    quote ? renderQuoteBlock(quote) : null,
    summaryLines.length ? renderSummaryList(summaryLines) : null,
    highlights.length
      ? el('div', {
          className: 'flex flex-wrap gap-1.5',
          children: highlights.map((h) => badge(h, 'bg-slate-800/80 text-slate-300 ring-slate-700')),
        })
      : null,
  ];

  // 詳細アコーディオン。<details> のネイティブ挙動を使うため JS 不要。
  // ラベルの切り替え（詳細を見る / 閉じる）のみ app.js が toggle イベントで行う。
  const detailsLabel = el('span', {
    className: 'text-xs font-medium',
    text: t('card.showDetail'),
    dataset: { detailLabel: item.id },
  });

  const details = el('details', {
    className: 'group/details mt-1 border-t border-slate-800 pt-3',
    dataset: { detailsFor: item.id },
    children: [
      el('summary', {
        className:
          'flex cursor-pointer list-none items-center gap-1.5 text-slate-400 transition hover:text-slate-200 ' +
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
          '[&::-webkit-details-marker]:hidden',
        children: [
          detailsLabel,
          icon('chevron', {
            className: 'w-3.5 h-3.5 transition-transform group-open/details:rotate-180',
          }),
        ],
      }),
      el('div', {
        className: 'mt-3',
        children: [renderDetailBody(item, inlineSlots)],
      }),
    ],
  });

  /** @type {(HTMLElement | null)[]} */
  const footerMeta = [];
  if (item.publishedAt) {
    footerMeta.push(
      el('span', { className: 'text-[11px] text-slate-500', text: formatDate(item.publishedAt) }),
    );
  }
  if (item.tags?.length) {
    footerMeta.push(
      el('div', {
        className: 'flex flex-wrap gap-1',
        children: item.tags.map((tag) =>
          el('span', {
            className: 'rounded bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-400',
            text: tag,
          }),
        ),
      }),
    );
  }

  return el('article', {
    className:
      'relative flex flex-col gap-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 ' +
      'shadow-sm transition hover:border-slate-700 hover:shadow-md',
    attrs: { id: `card-${item.id}` },
    dataset: { cardId: item.id, categoryId: item.categoryId },
    children: [
      accent
        ? el('span', {
            className: `absolute inset-x-0 top-0 h-[3px] ${accent.bar}`,
            attrs: { 'aria-hidden': 'true' },
          })
        : null,
      header,
      ...body,
      details,
      footerMeta.length
        ? el('div', {
            className: 'flex flex-wrap items-center justify-between gap-2 pt-1',
            children: footerMeta,
          })
        : null,
    ],
  });
}

/**
 * ダッシュボード本体（カテゴリごとのセクション）を描画する。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {{
 *   categoryConfig: import('./config.js').CategoryConfig,
 *   items: import('./config.js').DashboardItem[],
 *   activeCategoryId: string,
 *   inlineSlots?: import('./config.js').MonetizationSlot[]
 * }} params - 描画パラメータ。
 * @param {import('./config.js').CategoryConfig} params.categoryConfig - カテゴリ設定。
 * @param {import('./config.js').DashboardItem[]} params.items - 全カードデータ。
 * @param {string} params.activeCategoryId - 選択中カテゴリ（'all' で全件）。
 * @param {import('./config.js').MonetizationSlot[]} [params.inlineSlots=[]] - 詳細内広告枠。
 * @returns {void}
 */
export function renderDashboard(container, { categoryConfig, items, activeCategoryId, inlineSlots = [] }) {
  clear(container);

  const visibleCategories = categoryConfig.categories.filter(
    (category) => activeCategoryId === 'all' || category.id === activeCategoryId,
  );

  /** @type {HTMLElement[]} */
  const sections = [];

  for (const category of visibleCategories) {
    const categoryItems = items.filter(
      (item) => item.categoryId === category.id && item.selected !== false,
    );
    if (categoryItems.length === 0) {
      continue;
    }

    // 見出し行。`shrink-0` と `whitespace-nowrap` が無いと、
    // flex コンテナ内で h2 が縮められてカテゴリ名が1文字ずつ折り返される。
    const heading = el('div', {
      className: 'flex flex-wrap items-baseline gap-x-3 gap-y-1',
      children: [
        el('h2', {
          className:
            'flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-semibold tracking-tight text-slate-100',
          attrs: { id: `heading-${category.id}` },
          children: [
            icon(category.icon ?? 'grid', { className: 'h-5 w-5 shrink-0 text-slate-400' }),
            el('span', { text: pick(category.label) ?? category.id }),
          ],
        }),
        el('p', {
          className: 'text-xs text-slate-500',
          text: pick(category.description) ?? '',
        }),
      ],
    });

    sections.push(
      el('section', {
        className: 'space-y-3 scroll-mt-24',
        attrs: { id: `section-${category.id}`, 'aria-labelledby': `heading-${category.id}` },
        dataset: { categoryId: category.id },
        children: [
          heading,
          el('div', {
            className: 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3',
            children: categoryItems.map((item) =>
              renderCard(item, category, categoryConfig, inlineSlots),
            ),
          }),
        ],
      }),
    );
  }

  if (sections.length === 0) {
    container.appendChild(
      el('p', {
        className: 'rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500',
        text: t('status.empty'),
      }),
    );
    return;
  }

  container.appendChild(fragment(sections));
}

/**
 * 広告・アフィリエイト枠を 1 つ描画する。
 * `enabled` が false の場合、または表示すべき内容が無い場合は null を返す。
 *
 * 【描画の優先順位】 slot.html（生 HTML） > slot.items（リンク一覧） > slot.link（単一リンク）
 * どれも無い場合は、運用者が枠の位置を確認できるようプレースホルダを表示する。
 *
 * @param {import('./config.js').MonetizationSlot} slot - スロット設定。
 * @returns {HTMLElement | null} 描画された要素。非表示の場合は null。
 */
export function renderMonetizationSlot(slot) {
  if (!slot?.enabled) {
    return null;
  }

  const container = el('div', {
    className: 'rounded-lg border border-slate-800/80 bg-slate-900/40 p-3',
    dataset: { monetizationSlot: slot.id },
  });

  // (1) ASP の提供タグをそのまま使う場合。運用者が自ら貼った信頼済み HTML のみ。
  if (slot.html?.trim()) {
    setTrustedHtml(container, slot.html);
    return container;
  }

  // (2) リンク一覧形式（書籍紹介など）。
  if (slot.items?.length) {
    const links = slot.items
      .filter((entry) => entry.url)
      .map((entry) =>
        el('li', {
          children: [
            externalLink(entry.url, pick(entry.label) ?? entry.url, {
              className:
                'block rounded px-2 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800/60 hover:text-slate-100',
              rel: 'sponsored',
            }),
          ],
        }),
      );
    if (links.length) {
      container.appendChild(
        el('div', {
          className: 'space-y-2',
          children: [
            el('p', {
              className: 'text-xs font-semibold uppercase tracking-wide text-slate-400',
              text: t('support.affiliateHeading'),
            }),
            el('ul', { className: 'space-y-0.5', children: links }),
            el('p', { className: 'text-[10px] text-slate-600', text: t('support.affiliateNote') }),
          ],
        }),
      );
      return container;
    }
  }

  // (3) 単一リンク（バナー）形式。
  if (slot.link?.url) {
    const label = pick(slot.link.label) ?? slot.link.url;
    const anchor = externalLink(slot.link.url, slot.link.imageUrl ? '' : label, {
      className: 'block text-center text-sm text-slate-300 hover:text-slate-100',
      rel: 'sponsored',
      ariaLabel: label,
    });
    if (slot.link.imageUrl) {
      anchor.appendChild(
        el('img', {
          className: 'mx-auto h-auto max-w-full',
          attrs: { src: slot.link.imageUrl, alt: label, loading: 'lazy', decoding: 'async' },
        }),
      );
    }
    container.appendChild(anchor);
    return container;
  }

  // (4) 内容未設定。位置確認用のプレースホルダ。
  container.className =
    'rounded-lg border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-600';
  container.textContent = `${t('support.placeholder')} · ${slot.id}`;
  return container;
}

/**
 * 指定した配置場所の広告枠をまとめて描画する。
 *
 * @param {HTMLElement} container - 描画先の要素。中身は一度クリアされる。
 * @param {import('./config.js').MonetizationConfig} monetization - 収益化設定。
 * @param {'header' | 'aside' | 'cardDetail' | 'footer'} placement - 対象の配置場所。
 * @returns {number} 実際に描画されたスロット数。
 */
export function renderMonetizationPlacement(container, monetization, placement) {
  clear(container);
  const nodes = (monetization.slots ?? [])
    .filter((slot) => slot.placement === placement)
    .map((slot) => renderMonetizationSlot(slot))
    .filter(Boolean);
  container.appendChild(fragment(/** @type {HTMLElement[]} */ (nodes)));
  return nodes.length;
}

/**
 * 投げ銭（ドネーション）ボタンを描画する。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {import('./config.js').MonetizationConfig} monetization - 収益化設定。
 * @returns {void}
 */
export function renderDonation(container, monetization) {
  clear(container);
  const donation = monetization.donation;
  if (!donation?.enabled || !donation.url) {
    return;
  }

  const label = pick(donation.label) ?? t('support.coffeeLabel');
  const anchor = externalLink(donation.url, '', {
    className:
      'inline-flex items-center gap-2 rounded-lg bg-amber-500/90 px-3.5 py-2 text-sm font-semibold text-slate-950 ' +
      'transition hover:bg-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
      'focus-visible:outline-amber-300',
    ariaLabel: label,
  });
  anchor.appendChild(icon('coffee', { className: 'w-4 h-4' }));
  anchor.appendChild(el('span', { text: label }));
  container.appendChild(anchor);
}

/**
 * 言語切り替えボタン群を描画する。
 * 各ボタンには `data-locale` が付き、app.js がイベント委譲で拾う。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {string[]} locales - 利用可能な言語コード。
 * @param {string} activeLocale - 現在選択中の言語コード。
 * @param {Record<string, string>} labels - 言語コード → 表示ラベルの対応表。
 * @returns {void}
 */
export function renderLanguageSwitcher(container, locales, activeLocale, labels) {
  clear(container);
  const buttons = locales.map((locale) => {
    const isActive = locale === activeLocale;
    return el('button', {
      className:
        'rounded-md px-2.5 py-1 text-xs font-semibold transition ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
        (isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'),
      attrs: {
        type: 'button',
        'aria-pressed': String(isActive),
        lang: locale,
      },
      dataset: { locale },
      text: labels[locale] ?? locale.toUpperCase(),
    });
  });
  container.appendChild(fragment(buttons));
}

/**
 * データ出典の一覧をフッターに描画する。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {{ name: string, url: string }[]} sources - データ出典一覧。
 * @returns {void}
 */
export function renderDataSources(container, sources) {
  clear(container);
  if (!sources?.length) {
    return;
  }
  container.appendChild(
    el('div', {
      className: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500',
      children: [
        el('span', { className: 'font-medium text-slate-400', text: `${t('footer.dataSource')}:` }),
        ...sources.map((source) =>
          source.url
            ? externalLink(source.url, source.name, { className: 'underline underline-offset-2 hover:text-slate-300' })
            : el('span', { text: source.name }),
        ),
      ],
    }),
  );
}

/**
 * 読み込み中・エラーなどのステータス表示を描画する。
 *
 * @param {HTMLElement} container - 描画先の要素。
 * @param {'loading' | 'error' | 'empty' | null} status - 表示する状態。null で非表示。
 * @param {{ message?: string, onRetry?: () => void }} [options] - オプション。
 * @param {string} [options.message] - エラー時に併記する詳細メッセージ。
 * @param {() => void} [options.onRetry] - 再試行ボタンのハンドラ。指定時のみボタンを表示。
 * @returns {void}
 */
export function renderStatus(container, status, options = {}) {
  clear(container);
  if (!status) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  if (status === 'loading') {
    container.appendChild(
      el('div', {
        className: 'flex items-center gap-2 text-sm text-slate-400',
        children: [
          el('span', {
            className: 'h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300',
            attrs: { 'aria-hidden': 'true' },
          }),
          el('span', { text: t('status.loading') }),
        ],
      }),
    );
    return;
  }

  const children = [
    el('div', {
      className: 'flex items-center gap-2',
      children: [
        icon('alert', { className: 'w-4 h-4 text-amber-400' }),
        el('span', { className: 'text-sm font-medium text-slate-200', text: t(`status.${status}`) }),
      ],
    }),
  ];
  if (options.message) {
    children.push(el('p', { className: 'mt-1 text-xs text-slate-500', text: options.message }));
  }
  if (options.onRetry) {
    const retry = el('button', {
      className:
        'mt-2 inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 ' +
        'transition hover:border-slate-500 hover:text-slate-100',
      attrs: { type: 'button' },
      text: t('status.retry'),
    });
    retry.addEventListener('click', options.onRetry);
    children.push(retry);
  }

  container.appendChild(
    el('div', {
      className: 'rounded-lg border border-slate-800 bg-slate-900/60 p-4',
      attrs: { role: 'status' },
      children,
    }),
  );
}
