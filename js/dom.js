/**
 * @file dom.js
 * @module dom
 * @description
 *   DOM 生成のための小さなヘルパー群。
 *
 *   【単一責任】要素の生成とテキスト設定のみ。
 *   ビジネスロジック・国際化・データ取得は含まない。
 *
 *   【セキュリティ方針】
 *   このモジュールは `innerHTML` を使わない。テキストは必ず `textContent` 経由で
 *   設定されるため、データ由来の文字列が HTML として解釈されることはない（XSS 対策）。
 *   唯一の例外は {@link setTrustedHtml} で、運用者が config/monetization.json に
 *   自分で貼り付けた ASP タグのみを対象とする明示的なオプトイン API。
 */

/**
 * 要素を生成する。
 *
 * @param {string} tagName - タグ名（例: 'div'）。
 * @param {{
 *   className?: string,
 *   text?: string,
 *   attrs?: Record<string, string | number | boolean | null | undefined>,
 *   dataset?: Record<string, string>,
 *   children?: (Node | null | undefined)[]
 * }} [options] - 生成オプション。
 * @param {string} [options.className] - class 属性。
 * @param {string} [options.text] - textContent（HTML としては解釈されない）。
 * @param {Record<string, string|number|boolean|null|undefined>} [options.attrs]
 *   - 属性。値が null / undefined / false の場合は設定しない。
 * @param {Record<string, string>} [options.dataset] - data-* 属性。
 * @param {(Node|null|undefined)[]} [options.children] - 子ノード。null/undefined は無視される。
 * @returns {HTMLElement} 生成された要素。
 *
 * @example
 * el('p', { className: 'text-sm', text: '要約' });
 */
export function el(tagName, options = {}) {
  const { className, text, attrs, dataset, children } = options;
  const node = document.createElement(tagName);

  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      node.dataset[key] = value;
    }
  }
  if (children) {
    for (const child of children) {
      if (child) {
        node.appendChild(child);
      }
    }
  }
  return node;
}

/**
 * 外部リンク用の `<a>` を生成する。
 * 外部タブで開く際の tabnabbing 対策として `rel="noopener noreferrer"` を必ず付与する。
 *
 * @param {string} href - リンク先 URL。
 * @param {string} label - リンクテキスト。
 * @param {{ className?: string, rel?: string, ariaLabel?: string }} [options] - オプション。
 * @param {string} [options.className] - class 属性。
 * @param {string} [options.rel] - 追加の rel 値（例: 'sponsored'）。noopener noreferrer に連結される。
 * @param {string} [options.ariaLabel] - aria-label。
 * @returns {HTMLAnchorElement} 生成された `<a>` 要素。
 */
export function externalLink(href, label, options = {}) {
  const { className, rel, ariaLabel } = options;
  const anchor = /** @type {HTMLAnchorElement} */ (
    el('a', {
      className,
      text: label,
      attrs: {
        href,
        target: '_blank',
        rel: ['noopener', 'noreferrer', rel].filter(Boolean).join(' '),
        'aria-label': ariaLabel,
      },
    })
  );
  return anchor;
}

/**
 * 子ノードをすべて削除する。
 *
 * @param {Element} node - 対象要素。
 * @returns {Element} 空になった同じ要素（チェーン用）。
 */
export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * 複数ノードを DocumentFragment にまとめる。大量ノード追加時のリフローを抑える。
 *
 * @param {(Node | null | undefined)[]} nodes - まとめる対象のノード。
 * @returns {DocumentFragment} 生成されたフラグメント。
 */
export function fragment(nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    if (node) {
      frag.appendChild(node);
    }
  }
  return frag;
}

/**
 * 運用者が設定ファイルに直接記述した HTML を挿入する。
 *
 * ⚠️ セキュリティ上の注意:
 *   この関数はサニタイズを行わない。呼び出してよいのは、リポジトリ管理下の
 *   config/monetization.json に運用者自身が貼り付けた ASP 提供タグに限る。
 *   外部 API から取得した文字列や、ユーザー入力を渡してはならない。
 *
 * @param {HTMLElement} container - 挿入先の要素。
 * @param {string} html - 挿入する HTML 文字列（運用者が明示的に信頼したもの）。
 * @returns {void}
 */
export function setTrustedHtml(container, html) {
  container.innerHTML = html;
}
