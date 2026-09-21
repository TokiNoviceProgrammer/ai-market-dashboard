#!/usr/bin/env python3
"""多言語対応ダッシュボードデータ更新スクリプト。

このスクリプトは ``data/dashboard.json`` を生成・更新する唯一の入口です。

設計方針
--------
1. **プロバイダ分離**: 実際のデータ取得は ``Provider`` プロトコルを満たす
   クラスに閉じ込めてあります。既定は ``MockProvider``（ネットワーク不要）で、
   API キーを用意して ``YahooFinanceProvider`` などを差し込めば実データに切り替わります。
2. **既存データの保全**: 取得に失敗した項目は既存の ``data/dashboard.json`` の
   値をそのまま引き継ぎます。1 銘柄の取得失敗でサイト全体が壊れないようにするためです。
3. **多言語の一貫性**: すべてのテキストフィールドは ``{"ja": ..., "en": ..., "ko": ...}``
   の形を保ちます。``validate_payload`` が言語欠落を検出して警告します。

AI（Codex / ChatGPT 等）向けの拡張ガイド
----------------------------------------
- 新しいデータ源を足す → ``Provider`` を継承したクラスを追加し、
  ``build_provider()`` の分岐に登録するだけ。他の関数は変更不要です。
- 新しいカテゴリを足す → ``config/categories.json`` にカテゴリを追加し、
  ``SEED_ITEMS`` か外部プロバイダから該当 ``categoryId`` の項目を返すようにします。
- 出力形式を変える → ``validate_payload`` の必須フィールド定義と、
  ``js/config.js`` の JSDoc typedef を必ず同時に更新してください。

使い方
------
.. code-block:: console

    uv run update-data.py                 # モックデータで更新
    uv run update-data.py --provider mock # 同上（明示）
    uv run update-data.py --dry-run       # 書き込まずに差分だけ表示
    uv run update-data.py --check         # 既存データの検証のみ（CI 用）
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import random
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# --------------------------------------------------------------------------- #
# 定数
# --------------------------------------------------------------------------- #

#: リポジトリルート（このファイルが置かれているディレクトリ）
ROOT = Path(__file__).resolve().parent

#: 出力先のデータファイル
DATA_PATH = ROOT / "data" / "dashboard.json"

#: カテゴリ設定ファイル
CATEGORIES_PATH = ROOT / "config" / "categories.json"

#: サイト設定ファイル
SITE_PATH = ROOT / "config" / "site.json"

#: 出力データのスキーマバージョン。構造を変えたら必ず上げること。
SCHEMA_VERSION = 1

#: すべての多言語フィールドが備えるべき言語コード
REQUIRED_LOCALES: tuple[str, ...] = ("ja", "en", "ko")

#: 日本標準時（GitHub Actions は UTC で動くため明示的に指定する）
JST = dt.timezone(dt.timedelta(hours=9), "JST")

logger = logging.getLogger("update-data")


# --------------------------------------------------------------------------- #
# 型定義
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class QuoteUpdate:
    """1 銘柄・1 指標分の最新値。

    Attributes:
        symbol: ティッカーまたは指標シンボル（例: ``"NVDA"``, ``"USD/JPY"``）。
        price: 最新値。
        previous_close: 前日終値。
        as_of: 基準時刻（タイムゾーン付き）。
    """

    symbol: str
    price: float
    previous_close: float
    as_of: dt.datetime

    @property
    def change(self) -> float:
        """前日比（絶対値）を返す。

        Returns:
            前日終値との差分。小数第 4 位で丸める。
        """
        return round(self.price - self.previous_close, 4)

    @property
    def change_percent(self) -> float:
        """前日比（パーセント）を返す。

        Returns:
            前日終値に対する変化率（%）。前日終値が 0 の場合は 0.0。
        """
        if self.previous_close == 0:
            return 0.0
        return round((self.price - self.previous_close) / self.previous_close * 100, 2)

    def to_dict(self, *, base: dict[str, Any] | None = None) -> dict[str, Any]:
        """既存のクオート辞書に最新値をマージした辞書を返す。

        Args:
            base: 既存のクオート辞書。``ticker`` や ``currency`` など
                取得対象外のメタ情報を引き継ぐために使う。

        Returns:
            更新後のクオート辞書。
        """
        merged: dict[str, Any] = dict(base or {})
        value_key = "value" if "value" in merged and "price" not in merged else "price"
        merged[value_key] = round(self.price, 4)
        merged["previousClose"] = round(self.previous_close, 4)
        merged["change"] = self.change
        merged["changePercent"] = self.change_percent
        merged["asOf"] = self.as_of.isoformat()
        return merged


class Provider(Protocol):
    """データ取得プロバイダのインターフェース。

    新しいデータ源を追加する場合はこのプロトコルを満たすクラスを実装し、
    :func:`build_provider` に登録する。
    """

    #: プロバイダ名（``--provider`` で指定する値）
    name: str

    def fetch_quotes(self, symbols: Iterable[str]) -> dict[str, QuoteUpdate]:
        """指定シンボルの最新クオートを取得する。

        Args:
            symbols: 取得対象のシンボル一覧。

        Returns:
            シンボルをキー、:class:`QuoteUpdate` を値とする辞書。
            取得できなかったシンボルはキーごと省略してよい（呼び出し側が既存値を保持する）。
        """
        ...


# --------------------------------------------------------------------------- #
# プロバイダ実装
# --------------------------------------------------------------------------- #


class MockProvider:
    """ネットワークを使わないモックプロバイダ。

    既存データの価格に ±3% の範囲で疑似的な変動を加えて返す。
    オフライン環境や CI での動作確認、UI 開発時に使う。

    Attributes:
        name: プロバイダ名（``"mock"``）。
        seed: 乱数シード。``None`` の場合は実行ごとに異なる値になる。
    """

    name = "mock"

    def __init__(self, base_quotes: dict[str, dict[str, Any]], seed: int | None = None) -> None:
        """モックプロバイダを初期化する。

        Args:
            base_quotes: シンボルをキーとする既存クオート辞書。変動の基準値に使う。
            seed: 乱数シード。再現可能な出力が必要な場合に指定する。
        """
        self._base = base_quotes
        self._random = random.Random(seed)

    def fetch_quotes(self, symbols: Iterable[str]) -> dict[str, QuoteUpdate]:
        """疑似的な最新クオートを生成する。

        Args:
            symbols: 取得対象のシンボル一覧。

        Returns:
            シンボルをキー、:class:`QuoteUpdate` を値とする辞書。
        """
        now = dt.datetime.now(JST)
        results: dict[str, QuoteUpdate] = {}

        for symbol in symbols:
            base = self._base.get(symbol)
            if not base:
                continue
            previous = float(base.get("price") or base.get("value") or 0.0)
            if previous <= 0:
                continue
            drift = self._random.uniform(-0.03, 0.03)
            price = round(previous * (1 + drift), 4)
            results[symbol] = QuoteUpdate(
                symbol=symbol,
                price=price,
                previous_close=previous,
                as_of=now,
            )

        logger.info("MockProvider: generated %d quotes", len(results))
        return results


class JsonHttpClient:
    """JSON API への最小限の HTTP クライアント。"""

    def __init__(self, *, user_agent: str, timeout_seconds: float = 15.0) -> None:
        """クライアントを初期化する。

        Args:
            user_agent: 取得元へ送る識別子。
            timeout_seconds: 各リクエストのタイムアウト秒数。
        """
        self._timeout_seconds = timeout_seconds
        self._user_agent = user_agent

    def get(self, url: str, *, query: dict[str, str] | None = None) -> dict[str, Any]:
        """JSON を取得して辞書として返す。

        Args:
            url: リクエスト先 URL。
            query: URL エンコードするクエリパラメーター。

        Returns:
            JSON レスポンス。

        Raises:
            RuntimeError: HTTP または JSON 取得に失敗した場合。
        """
        target = f"{url}?{urlencode(query)}" if query else url
        request = Request(
            target,
            headers={"Accept": "application/json", "User-Agent": self._user_agent},
        )
        try:
            # 許可済みの固定 API エンドポイントだけを呼び出す。
            with urlopen(request, timeout=self._timeout_seconds) as response:  # noqa: S310
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Request failed for {url}: {exc}") from exc


class AlphaVantageProvider:
    """文書化された Alpha Vantage API から日次の価格と為替を取得する。"""

    name = "alpha_vantage"
    REQUEST_INTERVAL_SECONDS = 1.0

    def __init__(self, api_key: str) -> None:
        """プロバイダを初期化する。

        Args:
            api_key: ``ALPHA_VANTAGE_API_KEY`` の値。
        """
        self._api_key = api_key
        self._client = JsonHttpClient(user_agent="AI Market Dashboard data updater")

    def _get(self, function: str, **parameters: str) -> dict[str, Any]:
        """Alpha Vantage API を呼び出し、エラー応答を検出する。"""
        response = self._client.get(
            "https://www.alphavantage.co/query",
            query={"function": function, "apikey": self._api_key, **parameters},
        )
        if "Error Message" in response or "Information" in response or "Note" in response:
            message = (
                response.get("Error Message") or response.get("Information") or response.get("Note")
            )
            raise RuntimeError(f"Alpha Vantage returned an error: {message}")
        return response

    def fetch_quotes(self, symbols: Iterable[str]) -> dict[str, QuoteUpdate]:
        """日次終値ベースの株価と USD/JPY を取得する。"""
        results: dict[str, QuoteUpdate] = {}
        for symbol in symbols:
            if symbol == "US10Y":
                continue
            try:
                if symbol == "USD/JPY":
                    response = self._get("FX_DAILY", from_symbol="USD", to_symbol="JPY")
                    observations = list(response["Time Series FX (Daily)"].values())
                    if len(observations) < 2:
                        raise RuntimeError(
                            "Alpha Vantage returned fewer than two USD/JPY observations"
                        )
                    price = float(observations[0]["4. close"])
                    previous_close = float(observations[1]["4. close"])
                else:
                    response = self._get("GLOBAL_QUOTE", symbol=symbol)
                    quote = response["Global Quote"]
                    price = float(quote["05. price"])
                    previous_close = float(quote["08. previous close"])
                results[symbol] = QuoteUpdate(
                    symbol=symbol,
                    price=price,
                    previous_close=previous_close,
                    as_of=dt.datetime.now(JST),
                )
            except (KeyError, TypeError, ValueError, RuntimeError) as exc:
                logger.warning("Alpha Vantage update failed for %s: %s", symbol, exc)
            time.sleep(self.REQUEST_INTERVAL_SECONDS)
        logger.info("Alpha Vantage: fetched %d quotes", len(results))
        return results


def require_secret(name: str) -> str:
    """必須の GitHub Actions Secret を環境変数から取得する。

    Args:
        name: 環境変数名。

    Returns:
        空白を除去した秘密値。

    Raises:
        RuntimeError: 値が未設定の場合。
    """
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not configured")
    return value


def fetch_fred_updates() -> dict[str, QuoteUpdate]:
    """FRED から米国10年国債利回りを取得する。

    Returns:
        ``US10Y`` をキーとする最新値と直前観測値。

    Raises:
        RuntimeError: FRED の応答に利用可能な観測値がない場合。
    """
    client = JsonHttpClient(user_agent="AI Market Dashboard data updater")
    response = client.get(
        "https://api.stlouisfed.org/fred/series/observations",
        query={
            "series_id": "DGS10",
            "api_key": require_secret("FRED_API_KEY"),
            "file_type": "json",
            "sort_order": "desc",
            "limit": "10",
        },
    )
    observations = [
        item for item in response.get("observations", []) if item.get("value") not in (None, ".")
    ]
    if len(observations) < 2:
        raise RuntimeError("FRED returned fewer than two usable DGS10 observations")
    latest, previous = observations[:2]
    observed_at = dt.datetime.combine(
        dt.date.fromisoformat(latest["date"]), dt.time(), tzinfo=dt.UTC
    )
    return {
        "US10Y": QuoteUpdate(
            symbol="US10Y",
            price=float(latest["value"]),
            previous_close=float(previous["value"]),
            as_of=observed_at.astimezone(JST),
        )
    }


def refresh_sec_filings(items: list[dict[str, Any]]) -> int:
    """米国上場企業の最新 EDGAR 提出書類をカードへ反映する。

    Args:
        items: 更新対象のカード一覧。

    Returns:
        ``irDocuments`` を更新したカード数。
    """
    contact = require_secret("MALE_ADDRESS")
    client = JsonHttpClient(user_agent=f"AI Market Dashboard {contact}")
    ticker_rows = client.get("https://www.sec.gov/files/company_tickers_exchange.json").get(
        "data", []
    )
    ticker_to_cik = {
        str(row[2]).upper(): int(row[0])
        for row in ticker_rows
        if isinstance(row, list) and len(row) >= 3 and str(row[0]).isdigit()
    }
    supported_forms = {"10-K", "10-Q", "8-K", "20-F", "6-K"}
    updated = 0

    for item in items:
        ticker = str((item.get("quote") or {}).get("ticker", "")).upper()
        cik = ticker_to_cik.get(ticker)
        if cik is None:
            continue
        try:
            time.sleep(0.2)
            submissions = client.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
            recent = submissions.get("filings", {}).get("recent", {})
            documents: list[dict[str, Any]] = []
            for index, form in enumerate(recent.get("form", [])):
                if form not in supported_forms:
                    continue
                accession = recent["accessionNumber"][index].replace("-", "")
                primary_document = recent["primaryDocument"][index]
                filing_date = recent["filingDate"][index]
                url = (
                    f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{primary_document}"
                )
                title = f"SEC {form} filing ({filing_date})"
                documents.append(
                    {
                        "date": filing_date,
                        "url": url,
                        "title": {locale: title for locale in REQUIRED_LOCALES},
                    }
                )
                if len(documents) == 3:
                    break
            if documents:
                item["irDocuments"] = documents
                updated += 1
        except (KeyError, TypeError, RuntimeError) as exc:
            logger.warning("SEC EDGAR update failed for %s: %s", ticker, exc)
    logger.info("SEC EDGAR: updated filings for %d cards", updated)
    return updated


# --------------------------------------------------------------------------- #
# 入出力
# --------------------------------------------------------------------------- #


def read_json(path: Path) -> dict[str, Any]:
    """JSON ファイルを読み込む。

    Args:
        path: 読み込むファイルのパス。

    Returns:
        パース済みの辞書。

    Raises:
        FileNotFoundError: ファイルが存在しない場合。
        json.JSONDecodeError: JSON として不正な場合。
    """
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """JSON ファイルを書き出す。

    ``ensure_ascii=False`` により日本語・韓国語をエスケープせずに保存し、
    git の差分を人間と AI の双方が読める状態に保つ。

    Args:
        path: 書き出し先のパス。親ディレクトリが無い場合は作成する。
        payload: 書き出す辞書。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def load_existing_data() -> dict[str, Any]:
    """既存の ``data/dashboard.json`` を読み込む。

    ファイルが無い場合や壊れている場合は空のペイロードを返し、
    初回実行時でもスクリプトが動作するようにする。

    Returns:
        既存のダッシュボードデータ。取得できない場合は空の骨格。
    """
    try:
        return read_json(DATA_PATH)
    except (FileNotFoundError, json.JSONDecodeError):
        logger.warning("No valid existing data at %s; starting fresh", DATA_PATH)
        return {"schemaVersion": SCHEMA_VERSION, "items": []}


# --------------------------------------------------------------------------- #
# 変換・検証
# --------------------------------------------------------------------------- #


def collect_symbols(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """データ内の全項目から、クオートを持つものを抽出する。

    Args:
        items: ダッシュボード項目の一覧。

    Returns:
        シンボルをキー、既存のクオート辞書を値とする辞書。
    """
    symbols: dict[str, dict[str, Any]] = {}
    for item in items:
        quote = item.get("quote") or item.get("metric")
        if not isinstance(quote, dict):
            continue
        symbol = quote.get("ticker") or quote.get("symbol")
        if symbol:
            symbols[str(symbol)] = quote
    return symbols


def apply_quotes(items: list[dict[str, Any]], quotes: dict[str, QuoteUpdate]) -> int:
    """取得したクオートを各項目に反映する。

    取得できなかったシンボルの項目は変更しない（既存値を維持する）。

    Args:
        items: ダッシュボード項目の一覧。この引数は破壊的に更新される。
        quotes: シンボルをキーとする最新クオート。

    Returns:
        更新された項目の件数。
    """
    updated = 0
    for item in items:
        key = "quote" if "quote" in item else "metric" if "metric" in item else None
        if key is None:
            continue
        existing = item[key]
        symbol = existing.get("ticker") or existing.get("symbol")
        update = quotes.get(str(symbol))
        if update is None:
            continue
        item[key] = update.to_dict(base=existing)
        updated += 1
    return updated


def validate_payload(payload: dict[str, Any], *, category_ids: set[str]) -> list[str]:
    """出力データの整合性を検証する。

    検証内容:
        - 必須フィールド（``id``, ``categoryId``, ``title``, ``summary``）の存在。
        - ``categoryId`` が ``config/categories.json`` に定義されているか。
        - ``id`` の重複が無いか。
        - 多言語フィールドに ``ja`` / ``en`` / ``ko`` が揃っているか。

    Args:
        payload: 検証対象のダッシュボードデータ。
        category_ids: 有効なカテゴリ ID の集合。

    Returns:
        検出された問題のメッセージ一覧。問題が無ければ空リスト。
    """
    problems: list[str] = []
    items = payload.get("items", [])

    if not isinstance(items, list):
        return ["'items' must be a list"]

    seen_ids: set[str] = set()
    localized_fields = ("title", "summary", "highlights", "detail")

    for index, item in enumerate(items):
        where = f"items[{index}]"

        for field in ("id", "categoryId", "title", "summary"):
            if field not in item:
                problems.append(f"{where}: missing required field '{field}'")

        item_id = item.get("id")
        if item_id:
            if item_id in seen_ids:
                problems.append(f"{where}: duplicate id '{item_id}'")
            seen_ids.add(item_id)

        category_id = item.get("categoryId")
        if category_id and category_id not in category_ids:
            problems.append(f"{where}: unknown categoryId '{category_id}'")

        for field in localized_fields:
            value = item.get(field)
            if not isinstance(value, dict):
                continue
            missing = [loc for loc in REQUIRED_LOCALES if loc not in value]
            if missing:
                problems.append(f"{where}.{field}: missing locales {missing}")

    return problems


def build_payload(existing: dict[str, Any], provider: Provider) -> tuple[dict[str, Any], int]:
    """プロバイダから最新値を取得し、出力ペイロードを組み立てる。

    Args:
        existing: 既存のダッシュボードデータ。
        provider: 使用するデータ取得プロバイダ。

    Returns:
        ``(新しいペイロード, 更新された項目数)`` のタプル。
    """
    items: list[dict[str, Any]] = json.loads(json.dumps(existing.get("items", [])))
    symbols = collect_symbols(items)

    logger.info("Fetching %d symbols via provider '%s'", len(symbols), provider.name)
    quotes = provider.fetch_quotes(symbols.keys())
    updated = apply_quotes(items, quotes)

    if isinstance(provider, AlphaVantageProvider):
        fred_updates = fetch_fred_updates()
        updated += apply_quotes(items, fred_updates)
        refresh_sec_filings(items)

    payload = dict(existing)
    payload["schemaVersion"] = SCHEMA_VERSION
    payload["generatedAt"] = dt.datetime.now(JST).isoformat(timespec="seconds")
    payload["generator"] = (
        "update-data.py (Alpha Vantage, FRED, SEC EDGAR)"
        if isinstance(provider, AlphaVantageProvider)
        else f"update-data.py ({provider.name} provider)"
    )
    if isinstance(provider, AlphaVantageProvider):
        payload["notice"] = {
            "ja": "市場データは日次更新です。取得に失敗した項目は前回の正常値を表示します。",
            "en": (
                "Market data is refreshed daily. Items that fail to update retain their "
                "last verified value."
            ),
            "ko": "시장 데이터는 매일 갱신됩니다. 가져오기에 실패한 항목은 마지막 정상 값을 유지합니다.",
        }
    payload["items"] = items
    return payload, updated


def build_provider(name: str, base_quotes: dict[str, dict[str, Any]], seed: int | None) -> Provider:
    """名前からプロバイダのインスタンスを生成する。

    Args:
        name: プロバイダ名（``"mock"`` または ``"alpha_vantage"``）。
        base_quotes: モックプロバイダの基準値に使う既存クオート。
        seed: モックプロバイダの乱数シード。

    Returns:
        生成されたプロバイダ。

    Raises:
        ValueError: 未知のプロバイダ名が指定された場合。
    """
    if name == "mock":
        return MockProvider(base_quotes, seed=seed)
    if name == "alpha_vantage":
        return AlphaVantageProvider(require_secret("ALPHA_VANTAGE_API_KEY"))
    raise ValueError(f"Unknown provider: {name!r}. Available: mock, alpha_vantage")


# --------------------------------------------------------------------------- #
# エントリーポイント
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """コマンドライン引数を解析する。

    Args:
        argv: 引数リスト。``None`` の場合は ``sys.argv[1:]`` を使う。

    Returns:
        解析済みの引数。
    """
    parser = argparse.ArgumentParser(
        description="AI × Market Dashboard のデータを更新する",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--provider",
        default=os.environ.get("DASHBOARD_PROVIDER", "alpha_vantage"),
        help="使用するデータプロバイダ (alpha_vantage | mock)。既定: alpha_vantage",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="ファイルに書き込まず、更新内容の要約だけを表示する",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="データ取得を行わず、既存データの検証のみ実行する（CI 用）",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="モックプロバイダの乱数シード（再現可能な出力が必要な場合）",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="詳細ログを出力する",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911 - 終了コードごとに早期 return する CLI のため
    """スクリプトのエントリーポイント。

    Args:
        argv: コマンドライン引数。``None`` の場合は ``sys.argv[1:]`` を使う。

    Returns:
        終了コード。0 は成功、1 は検証エラー、2 は実行時エラー。
    """
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        categories = read_json(CATEGORIES_PATH)
        category_ids = {c["id"] for c in categories.get("categories", [])}
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as exc:
        logger.error("Failed to read categories config: %s", exc)
        return 2

    existing = load_existing_data()

    # --check: 取得せず検証のみ
    if args.check:
        problems = validate_payload(existing, category_ids=category_ids)
        if problems:
            for problem in problems:
                logger.error("%s", problem)
            logger.error("Validation failed with %d problem(s)", len(problems))
            return 1
        logger.info("Validation passed: %d items", len(existing.get("items", [])))
        return 0

    try:
        provider = build_provider(
            args.provider,
            collect_symbols(existing.get("items", [])),
            args.seed,
        )
    except ValueError as exc:
        logger.error("%s", exc)
        return 2

    try:
        payload, updated = build_payload(existing, provider)
    except Exception as exc:  # 失敗理由をログに残して終了する
        logger.error("Failed to build payload: %s", exc, exc_info=args.verbose)
        return 2

    problems = validate_payload(payload, category_ids=category_ids)
    if problems:
        for problem in problems:
            logger.error("%s", problem)
        logger.error("Refusing to write invalid payload (%d problem(s))", len(problems))
        return 1

    logger.info("Updated %d/%d items", updated, len(payload.get("items", [])))

    if args.dry_run:
        logger.info("--dry-run specified; not writing to %s", DATA_PATH)
        return 0

    write_json(DATA_PATH, payload)
    logger.info("Wrote %s (generatedAt=%s)", DATA_PATH, payload["generatedAt"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
