# ARCHITECTURE — AI 向けプロジェクト構造ガイド

> このドキュメントは、**外部の AI（ChatGPT / Codex / Claude 等）がこのリポジトリを読んで
> 安全に改修できるようにする**ことを主目的に書かれています。
> 人間が読んでも問題ありませんが、記述は「どこを触れば何が変わるか」に最適化されています。

---

## 0. 30 秒サマリ

- **ビルド不要の静的サイト**です。`index.html` をブラウザで開けば動きます（要 HTTP サーバ）。
- **画面に出る文字・数値・カードは一切ハードコードされていません。** すべて JSON から生成されます。
- したがって **「表示を変えたい」のほとんどは JSON の編集だけで済み、JS を読む必要はありません。**
- JS を触るのは「新しい種類の UI 部品を足す」場合だけです。

---

## 1. ディレクトリ構成

```
ai-market-dashboard/
├── index.html                  # 静的な骨格のみ。中身は JS が生成する
│
├── config/                     # 「何を・どう表示するか」の設定（構造）
│   ├── site.json               #   サイト全体設定（言語一覧・各ファイルのパス）
│   ├── categories.json         #   カテゴリ定義（タブ・セクションの元）
│   └── monetization.json       #   アフィリエイト枠・投げ銭ボタンの設定
│
├── locales/                    # 「UI の固定文字列」の辞書（文言）
│   ├── ja.json
│   ├── en.json
│   └── ko.json
│
├── data/
│   └── dashboard.json          # 「表示する中身」（カード本体のデータ）
│
├── js/                         # 描画ロジック。単一責任で分割
│   ├── config.js               #   JSON 取得とキャッシュ + 全型定義（JSDoc typedef）
│   ├── i18n.js                 #   言語切替・文字列解決・日付/数値フォーマット
│   ├── dom.js                  #   DOM 生成ヘルパー（XSS 対策の要）
│   ├── icons.js                #   インライン SVG アイコン
│   ├── render.js               #   状態 → DOM の変換（描画の本体）
│   └── app.js                  #   状態保持とイベント処理（エントリーポイント）
│
├── update-data.py              # data/dashboard.json を更新するスクリプト
├── pyproject.toml              # Python 依存とサプライチェーン設定
├── uv.lock                     # 依存のハッシュ固定（編集禁止）
│
└── .github/workflows/
    ├── update.yml              # 毎日 07:00 JST にデータ更新 → GitHub Pages 公開
    └── ci.yml                  # PR/push 時の検証（Lint・JSON 検証・SHA 固定検査）
```

---

## 2. データフロー

### 2.1 起動時の流れ

```
ブラウザが index.html を読む
   │
   └─ <script type="module" src="js/app.js">
         │
         ├─ (1) config.js: loadAll()
         │        ├─ config/site.json        … 言語一覧・パス定義を取得
         │        ├─ config/categories.json  … enabled のみ order 順に整列
         │        ├─ config/monetization.json… 広告枠設定（失敗しても空で続行）
         │        └─ data/dashboard.json     … カードデータを order 順に整列
         │
         ├─ (2) i18n.js: 言語を決定して辞書を読む
         │        優先順位: URL ?lang= > localStorage > navigator.languages > 既定
         │        → locales/{locale}.json を取得
         │
         ├─ (3) app.js: bindEvents()  … イベント委譲を1度だけ登録
         │
         └─ (4) app.js: refreshAll()  … render.js の各関数を呼んで描画
                  ├─ renderLanguageSwitcher()     → #language-switcher
                  ├─ renderCategoryTabs()         → #category-tabs
                  ├─ renderDashboard()            → #dashboard
                  ├─ renderMonetizationPlacement()→ #header-slots / #aside-slots / #footer-slots
                  ├─ renderDonation()             → #donation-area
                  └─ renderDataSources()          → #data-sources
```

### 2.2 ユーザー操作時の流れ

| 操作 | 経路 | 再描画範囲 |
|---|---|---|
| 言語ボタン | `app.changeLocale()` → `i18n.setLocale()` → `refreshAll()` | 画面全体 |
| カテゴリタブ | `state.activeCategoryId` 更新 → `refreshDashboard()` | カード部分のみ |
| 「詳細を見る」 | `<details>` のネイティブ挙動（**JS 不要**）＋ toggle でラベル差し替え | ラベルのみ |
| 再読み込みボタン | `app.reloadData()` → `config.loadDashboardData({noCache:true})` | カード部分のみ |

> **重要**: アコーディオンは `<details>`/`<summary>` のネイティブ機能です。
> JS が失敗しても詳細は閲覧できます。この性質を壊さないでください。

### 2.3 データ更新の流れ（CI）

```
GitHub Actions (毎日 22:00 UTC = 翌 07:00 JST)
   │
   ├─ uv sync --frozen           … ロック固定・Wheel のみ・3日タイムラグ保護
   ├─ ruff check                 … Lint
   ├─ update-data.py --check     … 既存データの検証
   ├─ update-data.py             … Provider が最新値を取得 → data/dashboard.json 更新
   │     └─ 検証に失敗したら書き込まない（壊れたデータを公開しない）
   ├─ git commit & push          … 差分があるときだけ
   └─ GitHub Pages へデプロイ
```

---

## 3. 各モジュールの責務（単一責任）

| ファイル | 責務 | やらないこと |
|---|---|---|
| `js/config.js` | JSON 取得・キャッシュ・**全型定義** | DOM 操作、文言解決 |
| `js/i18n.js` | 言語状態・文字列解決・日付/数値整形 | DOM 操作、データ取得 |
| `js/dom.js` | 要素生成・テキスト設定 | ビジネスロジック |
| `js/icons.js` | アイコン名 → SVG | それ以外すべて |
| `js/render.js` | **状態 → DOM** の変換 | データ取得、状態保持、イベント登録 |
| `js/app.js` | **状態保持**とイベント処理、各モジュールの協調 | DOM の直接組み立て |

依存の向き（循環なし）:

```
app.js ──→ config.js
   │  └──→ i18n.js ──→ config.js
   └──→ render.js ──→ dom.js
                  ├──→ icons.js
                  └──→ i18n.js
```

---

## 4. データ構造

### 4.1 多言語フィールドの規約

**テキストは必ず言語キーを持つオブジェクトにします。**

```jsonc
// 単一文字列
"title": { "ja": "日本語", "en": "English", "ko": "한국어" }

// 文字列配列（3行要約など）
"summary": {
  "ja": ["1行目。", "2行目。", "3行目。"],
  "en": ["Line 1.", "Line 2.", "Line 3."],
  "ko": ["1행.", "2행.", "3행."]
}
```

解決は `i18n.pick()` が行い、`現在言語 → 既定言語 → 最初に見つかった値` の順にフォールバックします。
**言語が欠けていても画面は壊れません**が、`ci.yml` の検証と `update-data.py --check` が警告します。

言語非依存の値（ティッカー・数値・タグ・URL・日付）は多言語化しません。

### 4.2 `data/dashboard.json` の 1 項目

```jsonc
{
  "id": "eq-nvda",                    // 必須・一意。DOM の id になる
  "categoryId": "equity-semiconductor",// 必須。categories.json の id と対応
  "order": 10,                         // カテゴリ内の表示順（昇順）
  "sentiment": "positive",             // positive | negative | neutral
  "impact": "high",                    // high | medium | low
  "tags": ["GPU", "DataCenter"],       // 言語非依存
  "publishedAt": "2026-09-20T09:00:00+09:00",

  "title":      { "ja": …, "en": …, "ko": … },  // 必須
  "summary":    { "ja": […], "en": […], "ko": … },// 必須。3要素程度
  "highlights": { "ja": […], "en": […], "ko": … },// 短いバッジ
  "detail":     { "ja": …, "en": …, "ko": … },  // 本文。\n\n で段落分割

  // 株価カード（cardType: "equity"）
  "quote": {
    "ticker": "NVDA", "exchange": "NASDAQ", "currency": "USD",
    "price": 182.45, "previousClose": 176.90,
    "change": 5.55, "changePercent": 3.14,
    "marketCap": "4.45T", "asOf": "2026-09-19T16:00:00-04:00"
  },

  // マクロ指標カード（cardType: "macro"）は quote の代わりに metric を使い、
  // price ではなく value、symbol、unit を持つ
  "metric": { "symbol": "US10Y", "value": 3.92, "unit": "%", … },

  "irDocuments": [
    { "date": "2026-08-27", "url": "…", "title": { "ja": …, "en": …, "ko": … } }
  ],
  "source": { "name": "NVIDIA IR", "url": "…" }
}
```

> **`quote` と `metric` の使い分け**
> `quote` は株価（`price` キー）、`metric` はマクロ指標（`value` キー）です。
> `update-data.py` の `QuoteUpdate.to_dict()` がこの差を自動判別して書き分けます。
> 描画は `render.js` の `renderQuoteBlock()` が両方を扱います。

型の正式な定義は **`js/config.js` の末尾にある JSDoc `@typedef` 群**にあります。
データ構造を変更したら、必ずそこも同時に更新してください。

---

## 5. よくある変更のレシピ

### 5.1 UI の文言を変える
`locales/{ja,en,ko}.json` の該当キーを編集するだけ。**3言語すべてを同時に編集してください**
（`ci.yml` がキー集合の一致を検査し、欠けていると CI が落ちます）。

### 5.2 カードを追加・編集する
`data/dashboard.json` の `items` に要素を追加。`id` の一意性と `categoryId` の
実在は `update-data.py --check` が検証します。

### 5.3 カテゴリを追加する
`config/categories.json` の `categories` に追加するだけで、
**タブ・セクション・カードの割り当てが自動的に増えます。JS の変更は不要です。**

```jsonc
{
  "id": "equity-defense",
  "order": 55,
  "enabled": true,
  "icon": "grid",            // js/icons.js に定義済みの名前
  "accent": "amber",         // categories.json の accents のキー
  "cardType": "equity",      // news | equity | macro
  "label":       { "ja": "防衛関連", "en": "Defense", "ko": "방위 관련" },
  "description": { "ja": "…",       "en": "…",       "ko": "…" }
}
```

カテゴリを一時的に隠すだけなら `"enabled": false` にします。

### 5.4 言語を追加する（例: 中国語 `zh`）
1. `locales/zh.json` を作成（`ja.json` をコピーして翻訳。**キー構造は変えない**）
2. `config/site.json` の `locales` に `"zh"` を追加
3. `data/dashboard.json` の各多言語フィールドに `"zh"` を追加
4. `update-data.py` の `REQUIRED_LOCALES` に `"zh"` を追加

**JS の変更は不要です。**

### 5.5 アフィリエイト枠・投げ銭を有効にする
`config/monetization.json` を編集します。

- **投げ銭**: `donation.url` を自分の Buy Me a Coffee 等の URL に差し替える
- **リンク一覧**: `slots[].items[].url` を自分のアフィリエイト URL に差し替える
- **ASP のバナータグ**: 該当スロットの `html` に貼り付け、`enabled: true` にする

> ⚠️ `html` に入れた文字列は **サニタイズされずそのまま挿入されます**
> （`dom.js` の `setTrustedHtml`）。ASP から提供された自分のタグ以外を
> 絶対に入れないでください。また ASP のスクリプト配信元を
> `index.html` の CSP `script-src` に追加する必要があります。

### 5.6 新しいアイコンを追加する
`js/icons.js` の `PATHS` に `名前: ['<path の d 属性>']` を追加し、
`categories.json` の `icon` からその名前を参照します。
24×24 の viewBox・stroke ベース（`currentColor`）で統一してください。

### 5.7 新しいカード種別（cardType）を追加する
1. `config/categories.json` の `cardTypes` に仕様を定義
2. `js/render.js` の `renderCard()` に分岐と描画処理を追加
3. `js/config.js` の `@typedef` にフィールドを追記

### 5.8 実データ取得に切り替える
`update-data.py` の `Provider` プロトコルを満たすクラスを追加し、
`build_provider()` の分岐に登録します。**他の関数の変更は不要です。**
外部 HTTP ライブラリが必要なら `pyproject.toml` の `dependencies` に追加して
`uv lock` を実行してください（§6 のサプライチェーン制約が自動適用されます）。

---

## 6. サプライチェーン対策（変更時の必須事項）

このリポジトリは 4 つの防御を組み込んでいます。**緩めないでください。**

| # | 対策 | 実装箇所 | 破ると起きること |
|---|---|---|---|
| 1 | ロックファイル凍結 | `uv sync --frozen`、`UV_FROZEN=1` | 意図しないバージョンが混入 |
| 2 | Wheel のみ許可 | `pyproject.toml` の `no-build = true` / `[tool.uv.pip] only-binary`、CI の `UV_NO_BUILD=1` | sdist のビルド時に任意コードが実行される |
| 3 | 公開後 3 日の保護 | CI の `UV_EXCLUDE_NEWER`（実行時に動的計算）、`pyproject.toml` の `exclude-newer` | 公開直後の不正リリースを掴む |
| 4 | Actions の SHA 固定 | `.github/workflows/*.yml` の全 `uses:` が 40 桁 SHA | タグ付け替えによる任意コード実行 |

**CI が自己検査します**: `ci.yml` の「Verify GitHub Actions are pinned to a commit SHA」
ステップが、タグ参照（`uses: owner/repo@v4`）の混入を検出して失敗します。

アクションを更新する際は SHA を確認してください:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.sha'
```

### フロントエンド側

- **`dom.js` は `innerHTML` を使いません。** テキストは必ず `textContent` 経由です。
  データ由来の文字列が HTML として解釈されないため、XSS が構造的に防がれています。
  唯一の例外が `setTrustedHtml()`（§5.5 参照）です。**この設計を壊さないでください。**
- 外部リンクは `dom.js` の `externalLink()` 経由で生成し、
  `rel="noopener noreferrer"` が必ず付きます（tabnabbing 対策）。
- `index.html` の CSP で外部オリジンを制限しています。

> ⚠️ **現状の CSP の弱点**: Tailwind Play CDN を使うため
> `script-src` に `'unsafe-eval'` と `'unsafe-inline'` が必要です。
> README の「Tailwind をローカルビルドに切り替える」手順を実施すると
> 両方を削除でき、`script-src 'self'` にできます（本番では推奨）。

---

## 7. 検証コマンド

改修後は最低限これらを通してください。

```bash
uv run --frozen ruff check update-data.py      # Lint
uv run --frozen ruff format --check update-data.py
uv run --frozen update-data.py --check         # データ整合性
uv lock --check                                # ロックと pyproject の整合
uv run --frozen update-data.py --dry-run       # 書き込まずに更新を試す
```

ブラウザでの確認は `python -m http.server 8000` を起動して
`http://localhost:8000` を開きます（`file://` では ES Modules と fetch が動きません）。

---

## 8. AI が改修する際の注意点

1. **JSON を先に疑ってください。** 表示に関する要望の大半は JS ではなく
   `config/` か `locales/` か `data/` の編集で完結します。
2. **3言語を揃えてください。** 片方だけ編集すると CI が落ちます。
3. **`dom.js` の `innerHTML` 不使用ポリシーを壊さないでください。**
   「テンプレート文字列で HTML を組む方が短い」は、この設計では改悪です。
4. **`<details>` によるアコーディオンを JS 実装に置き換えないでください。**
   JS 非依存であることが意図された設計です。
5. **`uv.lock` を手で編集しないでください。** `uv lock` で再生成します。
6. **Actions をタグ参照に戻さないでください。** CI が検出して落とします。
7. **新しい外部 CDN を安易に追加しないでください。** 依存が増えるほど攻撃面が広がります。
   追加する場合は CSP の更新も必須です。
