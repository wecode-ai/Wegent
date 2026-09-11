# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the wiki bridge MCP tools (scope enforcement, delegation)."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import wiki as wiki_tools
from app.services.wiki.connector import (
    WikiApiError,
    WikiConnector,
    WikiPage,
    WikiPageMeta,
    WikiSiteConfig,
)


class FakeConnector(WikiConnector):
    connector_type = "wikijs"
    display_name = "Wiki.js"

    def __init__(self, pages=None):
        self.pages = {p.path: p for p in (pages or [])}
        self.get_calls = []

    async def test_connection(self, config):
        return SimpleNamespace(ok=True, message="ok", version=None)

    async def list_pages(self, config, *, path=None, locale=None, limit, offset=0):
        metas = [
            WikiPageMeta(id=p.id, path=p.path, title=p.title, is_published=True)
            for p in self.pages.values()
            if not path
            or p.path == path.strip("/")
            or p.path.startswith(f"{(path or '').strip('/')}/")
        ]
        return metas[offset : offset + limit], None

    async def get_page(self, config, path, locale=None):
        self.get_calls.append((config.api_key, path))
        return self.pages.get(path.strip("/"))

    async def search_pages(self, config, query, *, path=None, locale=None, limit):
        return [
            WikiPageMeta(id=p.id, path=p.path, title=p.title)
            for p in self.pages.values()
            if query.lower() in p.title.lower()
        ][:limit]


def _token():
    return TaskTokenInfo(task_id=11, subtask_id=22, user_id=33, user_name="bob")


def _entry(connector, target_type, path="", api_key="adder-key"):
    return SimpleNamespace(
        target_type=target_type,
        path=path,
        config=WikiSiteConfig(site_url="https://wiki.example.com", api_key=api_key),
        connector=connector,
        owner_user_id=77,
        owner_name="alice",
        kb_id=1,
    )


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    monkeypatch.setattr(wiki_tools, "_rate_limited", lambda *a: False)


def _scopes(monkeypatch, entries, unavailable=None):
    context = wiki_tools._ScopeContext(entries, unavailable or [], _token())
    monkeypatch.setattr(wiki_tools, "_load_scopes", lambda token: context)
    return context


class TestWikiGetPage:
    @pytest.mark.asyncio
    async def test_delegates_to_adder_credential(self, monkeypatch):
        connector = FakeConnector(
            [WikiPage(id="1", path="docs/a", title="A", content="# A\nbody")]
        )
        entry = _entry(connector, "knowledge_base")
        _scopes(monkeypatch, [entry])

        result = await wiki_tools.wiki_get_page(_token(), path="docs/a")

        assert result["title"] == "A"
        assert result["truncated"] is False
        # The outbound call must use the adder's key, not the querier's.
        assert connector.get_calls == [("adder-key", "docs/a")]

    @pytest.mark.asyncio
    async def test_out_of_scope_rejected_before_outbound(self, monkeypatch):
        connector = FakeConnector()
        _scopes(monkeypatch, [_entry(connector, "folder", "docs")])

        result = await wiki_tools.wiki_get_page(_token(), path="other/x")

        assert result["error"]["code"] == "wiki_out_of_scope"
        assert connector.get_calls == []

    @pytest.mark.asyncio
    async def test_truncation_and_section(self, monkeypatch):
        long_body = "# T\n" + "para\n\n## Head\n" + ("x" * 60000) + "\n\n## Tail\nend"
        connector = FakeConnector(
            [WikiPage(id="1", path="p", title="P", content=long_body)]
        )
        _scopes(monkeypatch, [_entry(connector, "knowledge_base")])

        full = await wiki_tools.wiki_get_page(_token(), path="p")
        assert full["truncated"] is True
        assert full["content_total_chars"] > 60000
        assert {"level": 2, "title": "Head"} in full["outline"]

        section = await wiki_tools.wiki_get_page(_token(), path="p", section="Tail")
        assert section["truncated"] is False
        assert section["content"].startswith("## Tail")

    @pytest.mark.asyncio
    async def test_connector_error_maps_to_contract(self, monkeypatch):
        connector = FakeConnector()

        async def boom(config, path, locale=None):
            raise WikiApiError("wiki_auth_failed", "bad key")

        connector.get_page = boom
        _scopes(monkeypatch, [_entry(connector, "knowledge_base")])

        result = await wiki_tools.wiki_get_page(_token(), path="docs/a")
        assert result["error"]["code"] == "wiki_auth_failed"
        assert result["error"]["connector"] == "wikijs"


class TestDegradation:
    @pytest.mark.asyncio
    async def test_no_entries_with_unavailable_notes(self, monkeypatch):
        _scopes(monkeypatch, [], ["「docs」的添加者连接不可用"])
        result = await wiki_tools.wiki_get_page(_token(), path="docs/a")
        assert result["error"]["code"] == "wiki_credential_unavailable"

    @pytest.mark.asyncio
    async def test_no_entries_without_notes_gives_config_guidance(self, monkeypatch):
        _scopes(monkeypatch, [])
        result = await wiki_tools.wiki_search(_token(), query="x")
        assert result["error"]["code"] == "wiki_not_configured"
        assert result["error"]["guidance"].startswith("wegent://")


class TestWikiSearch:
    @pytest.mark.asyncio
    async def test_results_filtered_to_scope(self, monkeypatch):
        connector = FakeConnector(
            [
                WikiPage(id="1", path="docs/a", title="Architecture"),
                WikiPage(id="2", path="ops/b", title="Architecture Ops"),
            ]
        )
        _scopes(monkeypatch, [_entry(connector, "folder", "docs")])

        result = await wiki_tools.wiki_search(_token(), query="Architecture")
        paths = [item["path"] for item in result["results"]]
        assert paths == ["docs/a"]


class TestWikiListPages:
    @pytest.mark.asyncio
    async def test_site_scope_lists_pages(self, monkeypatch):
        connector = FakeConnector(
            [
                WikiPage(id="1", path="docs/a", title="A"),
                WikiPage(id="2", path="ops/b", title="B"),
            ]
        )
        _scopes(monkeypatch, [_entry(connector, "knowledge_base")])

        result = await wiki_tools.wiki_list_pages(_token())
        assert [p["path"] for p in result["pages"]] == ["docs/a", "ops/b"]
        assert result["site_url"] == "https://wiki.example.com"
