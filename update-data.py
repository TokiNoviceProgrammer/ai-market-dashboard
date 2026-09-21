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
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

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


class YahooFinanceProvider:
    """Yahoo Finance のチャート API から株価を取得するプロバイダ。

    .. warning::
       これは **差し込み口の雛形** です。既定では有効化されていません。
       利用前に対象 API の利用規約を必ず確認してください。商用利用や
       高頻度アクセスには別途ライセンスが必要な場合があります。

    有効化の手順:
        1. ``pyproject.toml`` の ``[project] dependencies`` に ``httpx`` を追加。
        2. ``uv lock`` を実行してロックファイルを更新。
        3. ``uv run update-data.py --provider yahoo`` を実行。

    Attributes:
        name: プロバイダ名（``"yahoo"``）。
    """

    name = "yahoo"

    #: 1 シンボルあたりのリクエストタイムアウト（秒）
    TIMEOUT_SECONDS = 10.0

    #: 連続リクエスト間の待機時間（秒）。レート制限への配慮。
    REQUEST_INTERVAL_SECONDS = 0.5

    def fetch_quotes(self, symbols: Iterable[str]) -> dict[str, QuoteUpdate]:
        """Yahoo Finance から最新クオートを取得する。

        Args:
            symbols: 取得対象のシンボル一覧（例: ``["NVDA", "6506.T"]``）。

        Returns:
            シンボルをキー、:class:`QuoteUpdate` を値とする辞書。
            取得に失敗したシンボルは結果に含まれない。

        Raises:
            RuntimeError: 依存パッケージ ``httpx`` が未インストールの場合。
        """
        try:
            import httpx  # 遅延 import（既定プロバイダでは不要なため）
        except ImportError as exc:  # pragma: no cover - 依存未追加時のガイド
            raise RuntimeError(
                "YahooFinanceProvider requires 'httpx'. "
                "Add it to pyproject.toml dependencies and run `uv lock`."
            ) from exc

        import time

        results: dict[str, QuoteUpdate] = {}
        endpoint = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

        with httpx.Client(timeout=self.TIMEOUT_SECONDS, follow_redirects=True) as client:
            for symbol in symbols:
                try:
                    response = client.get(endpoint.format(symbol=symbol))
                    response.raise_for_status()
                    meta = response.json()["chart"]["result"][0]["meta"]
                    results[symbol] = QuoteUpdate(
                        symbol=symbol,
                        price=float(meta["regularMarketPrice"]),
                        previous_close=float(meta["chartPreviousClose"]),
                        as_of=dt.datetime.fromtimestamp(
                            int(meta["regularMarketTime"]), tz=dt.UTC
                        ).astimezone(JST),
                    )
                except Exception:  # 1 銘柄の失敗で全体を止めない
                    logger.warning("Failed to fetch quote for %s", symbol, exc_info=True)
                time.sleep(self.REQUEST_INTERVAL_SECONDS)

        logger.info("YahooFinanceProvider: fetched %d/%d quotes", len(results), len(list(symbols)))
        return results


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

    payload = dict(existing)
    payload["schemaVersion"] = SCHEMA_VERSION
    payload["generatedAt"] = dt.datetime.now(JST).isoformat(timespec="seconds")
    payload["generator"] = f"update-data.py ({provider.name} provider)"
    payload["items"] = items
    return payload, updated


def build_provider(name: str, base_quotes: dict[str, dict[str, Any]], seed: int | None) -> Provider:
    """名前からプロバイダのインスタンスを生成する。

    Args:
        name: プロバイダ名（``"mock"`` または ``"yahoo"``）。
        base_quotes: モックプロバイダの基準値に使う既存クオート。
        seed: モックプロバイダの乱数シード。

    Returns:
        生成されたプロバイダ。

    Raises:
        ValueError: 未知のプロバイダ名が指定された場合。
    """
    if name == "mock":
        return MockProvider(base_quotes, seed=seed)
    if name == "yahoo":
        return YahooFinanceProvider()
    raise ValueError(f"Unknown provider: {name!r}. Available: mock, yahoo")


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
        default=os.environ.get("DASHBOARD_PROVIDER", "mock"),
        help="使用するデータプロバイダ (mock | yahoo)。既定: mock",
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
