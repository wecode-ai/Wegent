# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the external wiki document metadata backfill (design §4.3).

The backfill is a pure planning + apply pipeline over (documents, fetcher),
so tests exercise it with in-memory rows and a fake page fetcher instead of
a live Wiki.js site.
"""

from types import SimpleNamespace

import pytest

from app.services.wiki.backfill import WikiBackfillResult, backfill_wiki_documents
from app.services.wiki.connector import WikiPage


def _document(
    doc_id: int,
    path: str,
    *,
    name: str = "wiki page",
    file_size: int = 0,
    updated_at=None,
    page_updated_at: str = "",
):
    config = {
        "path": path,
        "locale": "zh",
        "page_updated_at": page_updated_at,
        "bound_by_user_id": 7,
    }
    return SimpleNamespace(
        id=doc_id,
        name=name,
        file_size=file_size,
        updated_at=updated_at,
        source_config={"wiki": dict(config)},
    )


class _FakeFetcher:
    """Connector double: returns canned pages, records requested paths."""

    def __init__(self, pages: dict[str, WikiPage | Exception]):
        self.pages = pages
        self.requested: list[str] = []

    async def fetch(self, document) -> WikiPage | None:
        path = document.source_config["wiki"]["path"]
        self.requested.append(path)
        result = self.pages.get(path)
        if isinstance(result, Exception):
            raise result
        return result


def _page(path: str, content: str, updated_at: str) -> WikiPage:
    return WikiPage(
        id="1", path=path, title=f"wiki:{path}", content=content, updated_at=updated_at
    )


@pytest.mark.asyncio
class TestBackfillWikiDocuments:
    async def test_backfills_size_and_source_updated_at(self):
        document = _document(1, "docs/a", page_updated_at="")
        fetcher = _FakeFetcher(
            {"docs/a": _page("docs/a", "# 标题", "2026-09-03T12:34:56Z")}
        )

        result = await backfill_wiki_documents([document], fetcher.fetch)

        assert result.updated_ids == [1]
        assert document.file_size == len("# 标题".encode("utf-8"))
        assert document.updated_at is not None
        assert document.updated_at.year == 2026
        assert (
            document.source_config["wiki"]["page_updated_at"] == "2026-09-03T12:34:56Z"
        )

    async def test_is_idempotent_on_second_run(self):
        document = _document(1, "docs/a", page_updated_at="")
        fetcher = _FakeFetcher(
            {"docs/a": _page("docs/a", "body", "2026-09-03T12:34:56Z")}
        )

        await backfill_wiki_documents([document], fetcher.fetch)
        # metadata_refreshed_at is an observability stamp and changes every
        # run; idempotency is about the data values users see.
        first = (
            document.file_size,
            document.updated_at,
            document.source_config["wiki"]["page_updated_at"],
        )
        await backfill_wiki_documents([document], fetcher.fetch)

        assert (
            document.file_size,
            document.updated_at,
            document.source_config["wiki"]["page_updated_at"],
        ) == first

    async def test_missing_page_is_reported_and_skipped(self):
        document = _document(1, "docs/gone")
        fetcher = _FakeFetcher({})

        result = await backfill_wiki_documents([document], fetcher.fetch)

        assert result.updated_ids == []
        assert result.failed_ids == [1]
        # Failures never leak page content; only ids and error codes.
        assert result.failures[0]["document_id"] == 1
        assert result.failures[0]["error_code"] == "wiki_page_missing"

    async def test_fetch_error_continues_to_next_document(self):
        from app.services.wiki.connector import WikiApiError

        documents = [
            _document(1, "docs/broken"),
            _document(2, "docs/ok"),
        ]
        fetcher = _FakeFetcher(
            {
                "docs/broken": WikiApiError("wiki_auth_failed", "key rejected"),
                "docs/ok": _page("docs/ok", "ok", "2026-09-01T00:00:00Z"),
            }
        )

        result = await backfill_wiki_documents(documents, fetcher.fetch)

        assert result.updated_ids == [2]
        assert result.failed_ids == [1]
        assert result.failures[0]["error_code"] == "wiki_auth_failed"

    async def test_invalid_source_timestamp_keeps_row_time(self):
        document = _document(1, "docs/a", updated_at="2026-09-04 00:00:00")
        fetcher = _FakeFetcher({"docs/a": _page("docs/a", "body", "not-a-date")})

        result = await backfill_wiki_documents([document], fetcher.fetch)

        assert result.updated_ids == [1]
        # Size still refreshes; the row timestamp stays untouched.
        assert document.file_size == len("body".encode("utf-8"))
        assert document.source_config["wiki"]["page_updated_at"] == "not-a-date"

    async def test_document_without_path_is_reported(self):
        document = _document(1, "")
        fetcher = _FakeFetcher({})

        result = await backfill_wiki_documents([document], fetcher.fetch)

        assert result.updated_ids == []
        assert result.failures[0]["error_code"] == "wiki_document_invalid"
        assert fetcher.requested == []

    async def test_result_counts_are_consistent(self):
        documents = [
            _document(1, "docs/ok"),
            _document(2, "docs/missing"),
        ]
        fetcher = _FakeFetcher(
            {"docs/ok": _page("docs/ok", "x", "2026-09-01T00:00:00Z")}
        )

        result: WikiBackfillResult = await backfill_wiki_documents(
            documents, fetcher.fetch
        )

        assert len(result.updated_ids) + len(result.failed_ids) == len(documents)
