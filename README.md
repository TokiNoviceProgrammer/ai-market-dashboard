# AI × マーケット ダッシュボード

AI ニュース・注目銘柄の株価/IR・マクロニュースを **1 画面で把握する**ための、
個人投資家＆エンジニア向けダッシュボードです。

- 🌐 **多言語** — 日本語 / English / 한국어をヘッダーのボタンで切り替え
- 📱 **レスポンシブ** — スマホ 1 カラム、PC 3 カラム
- ⚡ **サマリ優先** — 各カードは 3 行要約＋最新値＋前日比。詳細は「詳細を見る」で展開
- 🧩 **設定駆動** — カテゴリもカードも JSON 定義。コードを触らず項目を増やせる
- 🔒 **サプライチェーン対策済み** — ロック凍結・Wheel 限定・公開後 3 日保護・Actions の SHA 固定
- 🤖 **AI 可読** — 全関数に JSDoc、構造ガイドは [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## 目次

1. [必要なもの](#1-必要なもの)
2. [ローカルで起動する](#2-ローカルで起動する)
3. [データを更新する](#3-データを更新する)
4. [自分用にカスタマイズする](#4-自分用にカスタマイズする)
5. [GitHub Pages で無料公開する](#5-github-pages-で無料公開する)
6. [サプライチェーン対策](#6-サプライチェーン対策)
7. [本番向けの追加対応（任意）](#7-本番向けの追加対応任意)
8. [トラブルシューティング](#8-トラブルシューティング)
9. [免責事項](#9-免責事項)

---

## 1. 必要なもの

| 用途 | 必要なもの |
|---|---|
| サイトを表示するだけ | モダンブラウザ＋任意の HTTP サーバ |
| データ更新スクリプトを動かす | [uv](https://docs.astral.sh/uv/)（Python は uv が自動管理） |
| GitHub Pages で公開する | GitHub アカウント |

uv のインストール:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

---

## 2. ローカルで起動する

> ⚠️ **`index.html` をダブルクリックしても動きません。**
> ES Modules と `fetch()` は `file://` では動作しないため、必ず HTTP サーバ経由で開いてください。

```bash
git clone https://github.com/YOUR_NAME/ai-market-dashboard.git
cd ai-market-dashboard

# いずれか 1 つ
uv run python -m http.server 8000     # uv 経由（推奨）
python -m http.server 8000            # Python が入っていれば
npx --yes serve .                     # Node が入っていれば
```

ブラウザで <http://localhost:8000> を開きます。

**言語を指定して開く**: <http://localhost:8000/?lang=en>（`ja` / `en` / `ko`）
選んだ言語は `localStorage` に保存され、次回以降も維持されます。

---

## 3. データを更新する

`data/dashboard.json` を更新するのは `update-data.py` です。

```bash
# 依存を導入（初回のみ。ロックファイルを凍結したまま導入する）
uv sync --frozen --extra dev

# 実データを更新（GitHub Actions では Secrets を利用）
uv run --frozen update-data.py

# モックデータで UI のみ確認する
uv run --frozen update-data.py --provider mock

# 書き込まずに結果だけ見る
uv run --frozen update-data.py --dry-run

# 既存データの整合性チェックのみ（CI と同じ検査）
uv run --frozen update-data.py --check

# 再現可能な出力が欲しいとき（モックの乱数シードを固定）
uv run --frozen update-data.py --seed 42
```

### プロバイダについて

| プロバイダ | 内容 | ネットワーク | 既定 |
|---|---|---|---|
| `alpha_vantage` | 株価・為替を文書化済み API から日次取得 | `ALPHA_VANTAGE_API_KEY` | ✅ |
| `mock` | 既存の値に ±3% の疑似変動を加える | 不要 | UI テスト用 |

実データ更新では、米10年債利回りを FRED、米国企業の開示資料を SEC EDGAR からも取得します。
GitHub の **Settings → Secrets and variables → Actions** に、次の値を登録してください。

| Secret | 用途 |
|---|---|
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage の価格・為替 API |
| `FRED_API_KEY` | FRED の米国10年債利回り API |
| `MALE_ADDRESS` | SEC EDGAR に送る識別用 User-Agent の連絡先 |

API キーと連絡先はリポジトリに保存せず、Actions 実行時だけ環境変数として渡されます。
取得に失敗した項目は前回の正常値を維持します。日次更新は平日 17:30 JST に実行されます。

> ⚠️ Alpha Vantage の無料枠は日次更新向けです。リアルタイムの株価を表示する用途には、別途データライセンスが必要です。

独自のデータ源を追加する手順は [`ARCHITECTURE.md` §5.8](./ARCHITECTURE.md#58-実データ取得に切り替える) を参照してください。

---

## 4. 自分用にカスタマイズする

**ほとんどのカスタマイズは JSON の編集だけで完了します。JS を読む必要はありません。**

| やりたいこと | 編集するファイル |
|---|---|
| ボタンやタブの文言を変える | `locales/ja.json` / `en.json` / `ko.json` |
| カード（銘柄・ニュース）を追加する | `data/dashboard.json` |
| カテゴリを追加・並べ替え・非表示にする | `config/categories.json` |
| アフィリエイト枠・投げ銭を設定する | `config/monetization.json` |
| 言語を追加する（中国語など） | `config/site.json` ＋ 各 JSON |
| リポジトリ URL・データ出典を変える | `config/site.json` |

各レシピの詳細は [`ARCHITECTURE.md` §5](./ARCHITECTURE.md#5-よくある変更のレシピ) にあります。

### アフィリエイト・投げ銭の設定

`config/monetization.json` を開いて、プレースホルダを自分の URL に差し替えます。

```jsonc
{
  "donation": {
    "enabled": true,
    "url": "https://www.buymeacoffee.com/YOUR_ID"   // ← ここを自分の ID に
  },
  "slots": [
    {
      "id": "sidebar-books",
      "enabled": true,
      "items": [
        { "url": "https://www.amazon.co.jp/dp/XXXX?tag=YOUR_AMAZON_TAG", … }
      ]
    },
    {
      "id": "header-banner",
      "enabled": false,      // ← true にすると表示される
      "html": ""             // ← A8.net 等のバナータグをここに貼る
    }
  ]
}
```

配置場所は 4 箇所用意してあります。

| `placement` | 表示位置 |
|---|---|
| `header` | ヘッダー直下の横長バナー |
| `aside` | サイドバー（書籍・ツール一覧向き） |
| `cardDetail` | カードの「詳細を見る」を展開した中（既定は無効） |
| `footer` | フッター |

> ⚠️ **`html` に貼った文字列はサニタイズされずそのまま挿入されます。**
> ASP から提供された自分のタグ以外を入れないでください。
> また、ASP のスクリプト配信元を `index.html` の CSP `script-src` に追加する必要があります。

> 📋 アフィリエイトプログラムの多くは「広告である旨の表示」を規約で義務づけています
> （Amazon アソシエイト等）。`locales/*.json` の `support.affiliateNote` に
> 既定の文言を用意してありますが、各プログラムの規約に合わせて調整してください。

---

## 5. GitHub Pages で無料公開する

### 手順

**1. リポジトリを作成して push する**

```bash
git init
git add .
git commit -m "feat: initial dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/ai-market-dashboard.git
git push -u origin main
```

**2. GitHub Pages を有効にする**

リポジトリの **Settings → Pages** を開き、
**Source** を **GitHub Actions** に設定します。

> ⚠️ 「Deploy from a branch」ではなく **「GitHub Actions」** を選んでください。
> 同梱のワークフローは Actions 経由のデプロイを前提にしています。

**3. Actions の書き込み権限を確認する**

**Settings → Actions → General → Workflow permissions** で
**Read and write permissions** を選択します
（`update.yml` が更新後の `data/dashboard.json` をコミットするために必要です）。

**4. 動作確認**

**Actions** タブ → **Update dashboard data** → **Run workflow** で手動実行します。
成功すると `https://YOUR_NAME.github.io/ai-market-dashboard/` で公開されます。

以降は **毎日 07:00（JST）に自動でデータが更新・再公開**されます。

### 公開後の URL を設定に反映する

`config/site.json` の `links.repository` を自分のリポジトリ URL に更新しておくと、
フッターのリンクが正しく動きます。

---

## 6. サプライチェーン対策

このリポジトリには、依存パッケージと CI 経由の攻撃に対する 4 つの防御が組み込まれています。

### 1. ロックファイルの凍結固定

```bash
uv sync --frozen        # ロックを一切更新せずに導入
```

`uv.lock` には全アーティファクトの **SHA256 ハッシュ**が記録されており、
一致しないものは拒否されます。CI では `UV_FROZEN=1` でも二重に強制しています。

### 2. ビルド済みバイナリ（Wheel）のみ許可

```toml
# pyproject.toml
[tool.uv]
no-build = true              # uv sync / uv lock 経路

[tool.uv.pip]
only-binary = [":all:"]      # uv pip install 経路
```

sdist（ソース配布）はインストール時にビルドスクリプトを実行するため、
任意コード実行の経路になりえます。Wheel に限定してこれを塞いでいます。

### 3. 公開後タイムラグ保護（3 日）

```yaml
# .github/workflows/*.yml
UV_EXCLUDE_NEWER: $(date -u -d '3 days ago' '+%Y-%m-%dT%H:%M:%SZ')
```

公開から 3 日未満のパッケージを解決対象から除外します。
アカウント乗っ取りや typosquatting による不正リリースが
発見・撤回されるまでの猶予を確保する狙いです。

### 4. GitHub Actions のコミット SHA 固定

```yaml
# ✅ 正しい（40 桁の commit SHA）
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1

# ❌ 禁止（タグは後から別コミットに付け替えられる）
uses: actions/checkout@v7
```

**CI がこれを自己検査します。** `ci.yml` の
「Verify GitHub Actions are pinned to a commit SHA」ステップが
タグ参照の混入を検出してビルドを失敗させます。

アクションを更新するときは SHA を確認してください:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.sha'
```

### フロントエンド側の対策

- **XSS**: `js/dom.js` は `innerHTML` を使わず、テキストは必ず `textContent` 経由で設定します。
  データ由来の文字列が HTML として解釈される経路が構造的にありません。
- **tabnabbing**: 外部リンクには `rel="noopener noreferrer"` が必ず付きます。
- **CSP**: `index.html` の `Content-Security-Policy` で外部オリジンを制限しています。

### 依存を更新する手順

```bash
uv lock --upgrade                 # ロックを更新
uv sync --frozen --extra dev      # 更新後のロックで導入
uv run --frozen ruff check update-data.py
uv run --frozen update-data.py --check
git add uv.lock pyproject.toml && git commit -m "chore(deps): update dependencies"
```

---

## 7. 本番向けの追加対応（任意）

### Tailwind をローカルビルドに切り替える（推奨）

既定では Tailwind を CDN から読み込んでいます。手軽な反面、2 つの弱点があります。

- CSP に `'unsafe-eval'` と `'unsafe-inline'` が必要（Play CDN の JIT が要求するため）
- 外部 CDN への依存が残る

本番運用ではローカルビルドへの切り替えを推奨します。

```bash
npm init -y
npm install --save-dev tailwindcss@3.4.17
npx tailwindcss init

# tailwind.config.js の content に対象を指定
#   content: ["./index.html", "./js/**/*.js"]

# assets/input.css を作成:
#   @tailwind base; @tailwind components; @tailwind utilities;

npx tailwindcss -i assets/input.css -o assets/tailwind.css --minify
```

`index.html` を次のように書き換えます。

```html
<!-- 削除: CDN の script タグと tailwind.config のインラインスクリプト -->
<link rel="stylesheet" href="assets/tailwind.css" />
```

CSP も次のように締められます。

```
script-src 'self';          ← 'unsafe-eval' と 'unsafe-inline' を削除できる
```

> `js/render.js` はクラス名を文字列連結で組み立てているため、
> Tailwind の content 検出が一部のクラスを取りこぼす場合があります。
> `tailwind.config.js` の `safelist` に不足分を追加してください。

Node 側でもサプライチェーン対策を適用する場合:

```bash
npm ci                         # package-lock.json を凍結して導入（npm install ではなく）
npm config set ignore-scripts true   # インストール時スクリプトの実行を禁止
```

### CSP をレスポンスヘッダで配信する

`<meta>` による CSP には `frame-ancestors` などが効かない制約があります。
Cloudflare Pages / Netlify など、ヘッダを設定できるホスティングに移す場合は
HTTP レスポンスヘッダとして配信してください。

---

## 8. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 画面が真っ白／「読み込み中…」のまま | `file://` で開いている。HTTP サーバ経由で開く（§2） |
| スタイルが崩れて素の HTML に見える | Tailwind CDN に到達できていない。ネットワークとブラウザの拡張機能（広告ブロッカー）を確認 |
| 一部の文字がキー名のまま表示される（例: `card.showDetail`） | `locales/*.json` にそのキーが無い。3 言語すべてに追加する |
| カードが 1 枚も出ない | `data/dashboard.json` の `categoryId` が `config/categories.json` に存在しない。`uv run --frozen update-data.py --check` で検出できる |
| CI が「not pinned to a 40-char SHA」で失敗 | ワークフローにタグ参照が混入している。SHA に戻す（§6-4） |
| CI が `uv lock --check` で失敗 | `pyproject.toml` を変えて `uv lock` を忘れている。`uv lock` を実行してコミット |
| CI が locale key の不一致で失敗 | 3 言語の辞書でキー構造が揃っていない。差分は CI ログに出力される |
| Actions がデータをコミットできない | Settings → Actions → General → Workflow permissions を **Read and write** に |

---

## 9. 免責事項

**本サイトおよび本リポジトリの情報は情報提供のみを目的としており、
投資勧誘・投資助言を目的としたものではありません。**
掲載データには誤りや遅延が含まれる可能性があります。
投資判断はご自身の責任と判断で行ってください。

同梱の初期データは **動作確認用のサンプル**であり、実在の市場データではありません。

---

## ライセンス

MIT
