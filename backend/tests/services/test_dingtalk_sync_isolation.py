# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-loop isolation contracts for DingTalk directory synchronization."""

from __future__ import annotations

import threading
from types import SimpleNamespace
from typing import Any

import pytest

from app.models.dingtalk_doc import DingTalkNodeSource
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService


def _empty_stats(sync_time: Any) -> dict[str, Any]:
    return {
        "added": 0,
        "updated": 0,
        "deleted": 0,
        "total": 0,
        "sync_time": sync_time,
    }


@pytest.mark.asyncio
async def test_docs_sync_keeps_config_and_database_work_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    threads: dict[str, int] = {}

    def resolve_url(preferences: object, service_id: str = "docs") -> str:
        assert preferences == {"detached": True}
        assert service_id == "docs"
        threads["config"] = threading.get_ident()
        return "https://docs.example.test/mcp"

    async def fetch_nodes(url: str) -> list[dict[str, Any]]:
        assert url == "https://docs.example.test/mcp"
        threads["network"] = threading.get_ident()
        return []

    def persist_nodes(
        user_id: int,
        nodes: list[dict[str, Any]],
        sync_time: Any,
        source: DingTalkNodeSource,
    ) -> dict[str, Any]:
        assert user_id == 17
        assert nodes == []
        assert source == DingTalkNodeSource.DOCS
        threads["database"] = threading.get_ident()
        return _empty_stats(sync_time)

    monkeypatch.setattr(
        DingTalkDocService,
        "get_dingtalk_mcp_url_from_preferences",
        resolve_url,
    )
    monkeypatch.setattr(DingTalkDocService, "_fetch_all_nodes", fetch_nodes)
    monkeypatch.setattr(
        DingTalkDocService,
        "_sync_nodes_with_owned_session",
        persist_nodes,
    )

    result = await DingTalkDocService.sync_dingtalk_docs(17, {"detached": True})

    assert result["mcp_nodes_fetched"] == 0
    assert threads["network"] == loop_thread
    assert threads["config"] != loop_thread
    assert threads["database"] != loop_thread


@pytest.mark.asyncio
async def test_wikispace_sync_keeps_config_and_database_work_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    threads: dict[str, int] = {}

    def resolve_urls(preferences: object) -> tuple[str, str]:
        assert preferences == "detached"
        threads["config"] = threading.get_ident()
        return (
            "https://wikispace.example.test/mcp",
            "https://docs.example.test/mcp",
        )

    async def fetch_nodes(
        wikispace_mcp_url: str,
        docs_mcp_url: str | None = None,
    ) -> list[dict[str, Any]]:
        assert wikispace_mcp_url == "https://wikispace.example.test/mcp"
        assert docs_mcp_url == "https://docs.example.test/mcp"
        threads["network"] = threading.get_ident()
        return []

    def persist_nodes(
        user_id: int,
        nodes: list[dict[str, Any]],
        sync_time: Any,
        source: DingTalkNodeSource,
    ) -> dict[str, Any]:
        assert user_id == 23
        assert nodes == []
        assert source == DingTalkNodeSource.WIKISPACE
        threads["database"] = threading.get_ident()
        return _empty_stats(sync_time)

    monkeypatch.setattr(DingTalkWikiSpaceService, "_resolve_sync_urls", resolve_urls)
    monkeypatch.setattr(
        DingTalkWikiSpaceService,
        "_fetch_all_wikispace_nodes",
        fetch_nodes,
    )
    monkeypatch.setattr(
        DingTalkDocService,
        "_sync_nodes_with_owned_session",
        persist_nodes,
    )

    result = await DingTalkWikiSpaceService.sync_wikispace_nodes(23, "detached")

    assert result["mcp_nodes_fetched"] == 0
    assert threads["network"] == loop_thread
    assert threads["config"] != loop_thread
    assert threads["database"] != loop_thread


@pytest.mark.asyncio
async def test_mcp_json_page_parsing_runs_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    parse_threads: list[int] = []
    result = SimpleNamespace(meta=None)

    class SessionStub:
        async def call_tool(self, name: str, args: dict[str, Any]) -> object:
            assert name == "list_nodes"
            assert args == {"pageSize": 50}
            return result

    def parse_page(value: object) -> tuple[list[dict[str, Any]], None]:
        assert value is result
        parse_threads.append(threading.get_ident())
        return [], None

    monkeypatch.setattr(
        DingTalkDocService,
        "_parse_list_nodes_result",
        parse_page,
    )

    await DingTalkDocService._list_nodes_recursive(
        SessionStub(),
        folder_id=None,
        workspace_id=None,
        all_nodes=[],
        depth=0,
    )

    assert parse_threads and parse_threads[0] != loop_thread
