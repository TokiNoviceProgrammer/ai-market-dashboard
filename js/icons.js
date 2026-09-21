/**
 * @file icons.js
 * @module icons
 * @description
 *   インライン SVG アイコンを提供するモジュール。
 *   外部アイコンライブラリを CDN から読み込まないことで、
 *   依存を 1 つ減らしサプライチェーンの攻撃面を小さくしている。
 *
 *   【単一責任】アイコン名 → SVG 要素の変換のみ。
 *
 *   【AI向けメモ】
 *   アイコンを追加する場合は PATHS に `名前: 'd属性の文字列'` を追加し、
 *   config/categories.json の categories[].icon からその名前を参照する。
 *   すべて 24x24 viewBox・stroke ベース（currentColor）で統一すること。
 */

/**
 * アイコン名と SVG path の `d` 属性（複数可）の対応表。
 * すべて 24x24 の viewBox、線幅 1.5 の stroke 描画を前提とする。
 * @type {Record<string, string[]>}
 */
const PATHS = {
  sparkles: [
    'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z',
    'M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z',
  ],
  cloud: ['M7.5 18h9a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.8 3.8 0 007.5 18z'],
  cpu: [
    'M8 8h8v8H8z',
    'M5 5h14v14H5z',
    'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  ],
  robot: [
    'M6 9h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6a2 2 0 012-2z',
    'M12 5v4M9.5 14h.01M14.5 14h.01',
    'M12 3.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  ],
  'trending-up': ['M3 17l6-6 4 4 7-7', 'M17 8h4v4'],
  globe: [
    'M12 3a9 9 0 100 18 9 9 0 000-18z',
    'M3.6 9h16.8M3.6 15h16.8',
    'M12 3a13 13 0 000 18 13 13 0 000-18z',
  ],
  grid: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  chevron: ['M6 9l6 6 6-6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'],
  coffee: [
    'M4 8h13v6a5 5 0 01-5 5H9a5 5 0 01-5-5V8z',
    'M17 9h1.5a2.5 2.5 0 010 5H17',
    'M7 2v3M11 2v3',
  ],
  refresh: ['M3 12a9 9 0 0115.5-6.2M21 12a9 9 0 01-15.5 6.2', 'M18 3v4h-4M6 21v-4h4'],
  alert: ['M12 8v5', 'M12 16.5h.01', 'M12 3l9.5 17h-19L12 3z'],
};

/**
 * アイコン名から SVG 要素を生成する。
 * 装飾目的のため `aria-hidden="true"` を付与し、スクリーンリーダーからは隠す。
 *
 * @param {string} name - アイコン名（{@link PATHS} のキー）。未知の名前の場合は 'grid' を使う。
 * @param {{ className?: string, size?: number }} [options] - オプション。
 * @param {string} [options.className='w-4 h-4'] - class 属性。
 * @param {number} [options.size] - width/height 属性（px）。未指定なら className のサイズに従う。
 * @returns {SVGSVGElement} 生成された SVG 要素。
 */
export function icon(name, options = {}) {
  const { className = 'w-4 h-4', size } = options;
  const paths = PATHS[name] ?? PATHS.grid;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }

  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * 登録済みのアイコン名一覧を返す（デバッグ・ドキュメント用途）。
 *
 * @returns {string[]} アイコン名の配列。
 */
export function listIconNames() {
  return Object.keys(PATHS);
}
