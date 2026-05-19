# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalkWikiSpaceService — two-phase KB sync."""

from __future__ import annotations

import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.dingtalk_doc import DingTalkNodeSource, DingtalkSyncedNode
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import (
    MCP_TOOL_LIST_WIKI_SPACES,
    WIKISPACE_SOURCE,
    DingTalkWikiSpaceService,
    _sanitize_url_for_telemetry,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_text_content(data: object) -> MagicMock:
    """Create a mock MCP content item with type='text' carrying JSON data."""
    item = MagicMock()
    item.type = "text"
    item.text = json.dumps(data)
    return item


def _make_mcp_result(data: object) -> MagicMock:
    """Create a mock MCP tool call result wrapping JSON data."""
    result = MagicMock()
    result.content = [_make_text_content(data)]
    return result


class TestSanitizeUrlForTelemetry:
    """Tests for URL sanitization used in telemetry."""

    def test_preserves_port_while_stripping_credentials_and_query(self) -> None:
        """Sanitized URL keeps host and port but removes credentials and query."""
        sanitized = _sanitize_url_for_telemetry(
            "https://user:secret@mcp.example.com:8443/api?token=secret#frag"
        )

        assert sanitized == "https://mcp.example.com:8443/api"

    def test_returns_invalid_placeholder_on_parse_failure(self) -> None:
        """Invalid URLs never echo the raw input back to telemetry."""
        sanitized = _sanitize_url_for_telemetry("http://[invalid-url")

        assert sanitized == "<invalid-url>"


# ---------------------------------------------------------------------------
# _list_wiki_spaces
# ---------------------------------------------------------------------------


class TestListWikiSpaces:
    """Tests for DingTalkWikiSpaceService._list_wiki_spaces."""

    @pytest.mark.asyncio
    async def test_returns_knowledge_bases_from_items_key(self) -> None:
        """Returns KB nodes when list_wikiSpaces responds with an 'items' envelope."""
        kb_data = [
            {"workspaceId": "WS001", "name": "KB One"},
            {"workspaceId": "WS002", "name": "KB Two"},
        ]

        mock_session = AsyncMock()
        mock_session.list_tools.return_value = MagicMock(tools=[])
        mock_session.call_tool.return_value = _make_mcp_result({"items": kb_data})

        with patch.object(
            DingTalkWikiSpaceService,
            "_list_wiki_spaces",
            wraps=DingTalkWikiSpaceService._list_wiki_spaces,
        ):
            with (
                patch("mcp.client.streamable_http.streamablehttp_client") as mock_http,
                patch("mcp.ClientSession") as mock_cls,
            ):
                mock_http.return_value.__aenter__ = AsyncMock(
                    return_value=(MagicMock(), MagicMock(), None)
                )
                mock_http.return_value.__aexit__ = AsyncMock(return_value=False)
                mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_session)
                mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

                with (
                    patch(
                        "app.services.dingtalk_wikispace_service.streamablehttp_client",
                        mock_http,
                        create=True,
                    ),
                    patch(
                        "app.services.dingtalk_wikispace_service.ClientSession",
                        mock_cls,
                        create=True,
                    ),
                ):
                    result = await DingTalkWikiSpaceService._list_wiki_spaces(
                        "https://ws.mcp.example.com"
                    )

        assert len(result) == 2
        assert result[0]["workspaceId"] == "WS001"
        assert result[1]["name"] == "KB Two"


class TestListNodesInWikispace:
    """Tests for DingTalkWikiSpaceService._list_nodes_in_wikispace."""

    @pytest.mark.asyncio
    async def test_recurses_into_root_folder_and_continues_root_pagination(
        self,
    ) -> None:
        """Lists first page, recurses into folders, then continues root pagination."""
        first_page = _make_mcp_result(
            {
                "items": [
                    {"nodeId": "folder-1", "nodeType": "folder", "workspaceId": "WS1"},
                    {"nodeId": "doc-1", "nodeType": "doc", "workspaceId": "WS1"},
                ],
                "nextPageToken": "page-2",
            }
        )
        second_page = _make_mcp_result(
            {
                "items": [
                    {"nodeId": "folder-2", "nodeType": "folder", "workspaceId": "WS1"},
                    {"nodeId": "doc-2", "nodeType": "doc", "workspaceId": "WS1"},
                ]
            }
        )

        session = AsyncMock()
        session.call_tool = AsyncMock(side_effect=[first_page, second_page])
        all_nodes: list[dict[str, str]] = []

        with patch.object(
            DingTalkDocService,
            "_list_nodes_recursive",
            new=AsyncMock(),
        ) as mock_recursive:
            await DingTalkWikiSpaceService._list_nodes_in_wikispace(
                session=session,
                workspace_id="WS1",
                all_nodes=all_nodes,
            )

        assert [node["nodeId"] for node in all_nodes] == [
            "folder-1",
            "doc-1",
            "folder-2",
            "doc-2",
        ]
        assert session.call_tool.await_count == 2
        assert mock_recursive.await_count == 2
        first_recursive_call = mock_recursive.await_args_list[0]
        assert first_recursive_call.kwargs["folder_id"] == "folder-1"
        second_recursive_call = mock_recursive.await_args_list[1]
        assert second_recursive_call.kwargs["folder_id"] == "folder-2"

    @pytest.mark.asyncio
    async def test_handles_empty_first_page_without_recursion(self) -> None:
        """Empty result stops pagination and avoids recursive folder traversal."""
        session = AsyncMock()
        session.call_tool = AsyncMock(return_value=_make_mcp_result({"items": []}))
        all_nodes: list[dict[str, str]] = []

        with patch.object(
            DingTalkDocService,
            "_list_nodes_recursive",
            new=AsyncMock(),
        ) as mock_recursive:
            await DingTalkWikiSpaceService._list_nodes_in_wikispace(
                session=session,
                workspace_id="WS1",
                all_nodes=all_nodes,
            )

        assert all_nodes == []
        mock_recursive.assert_not_awaited()


class TestParseListNodesResult:
    """Tests for DingTalkDocService._parse_list_nodes_result."""

    def test_returns_knowledge_bases_from_wiki_spaces_key(self) -> None:
        """Returns KB nodes when list_wikiSpaces responds with a 'wikiSpaces' key."""
        kb_data = [{"workspaceId": "WS100", "name": "Org KB"}]
        result, token = DingTalkDocService._parse_list_nodes_result(
            _make_mcp_result({"wikiSpaces": kb_data})
        )
        assert len(result) == 1
        assert result[0]["workspaceId"] == "WS100"
        assert token is None

    @pytest.mark.parametrize("key", ["spaces", "spaceList", "documents", "files"])
    def test_supports_extended_list_keys(self, key: str) -> None:
        """All supported alternative list keys are parsed correctly."""
        payload = {key: [{"workspaceId": "WS200", "name": f"Node from {key}"}]}

        result, token = DingTalkDocService._parse_list_nodes_result(
            _make_mcp_result(payload)
        )

        assert len(result) == 1
        assert result[0]["workspaceId"] == "WS200"
        assert token is None

    def test_returns_empty_list_when_no_content(self) -> None:
        """Returns empty list when the MCP result has no content."""
        empty_result = MagicMock()
        empty_result.content = []
        result, token = DingTalkDocService._parse_list_nodes_result(empty_result)
        assert result == []
        assert token is None

    def test_pagination_token_extracted(self) -> None:
        """nextPageToken is extracted from the response envelope."""
        data = {
            "items": [{"workspaceId": "WS1", "name": "KB 1"}],
            "nextPageToken": "tok2",
        }
        result, token = DingTalkDocService._parse_list_nodes_result(
            _make_mcp_result(data)
        )
        assert len(result) == 1
        assert token == "tok2"


# ---------------------------------------------------------------------------
# _fetch_all_wikispace_nodes
# ---------------------------------------------------------------------------


class TestFetchAllWikispaceNodes:
    """Tests for DingTalkWikiSpaceService._fetch_all_wikispace_nodes."""

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_kbs(self) -> None:
        """Returns empty list when list_wikiSpaces returns no knowledge bases."""
        with patch.object(
            DingTalkWikiSpaceService,
            "_list_wiki_spaces",
            new=AsyncMock(return_value=[]),
        ):
            result = await DingTalkWikiSpaceService._fetch_all_wikispace_nodes(
                wikispace_mcp_url="https://ws.mcp.example.com",
                docs_mcp_url="https://docs.mcp.example.com",
            )
        assert result == []

    @pytest.mark.asyncio
    async def test_adds_kb_root_as_folder_node(self) -> None:
        """Each knowledge base is added as a folder-type root node."""
        kb_nodes = [{"workspaceId": "WSABC", "name": "Test KB"}]
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        with (
            patch.object(
                DingTalkWikiSpaceService,
                "_list_wiki_spaces",
                new=AsyncMock(return_value=kb_nodes),
            ),
            patch.object(
                DingTalkWikiSpaceService,
                "_list_nodes_in_wikispace",
                new=AsyncMock(return_value=None),
            ),
            patch("mcp.client.streamable_http.streamablehttp_client") as mock_http,
            patch("mcp.ClientSession") as mock_cls,
        ):
            mock_http.return_value.__aenter__ = AsyncMock(
                return_value=(MagicMock(), MagicMock(), None)
            )
            mock_http.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await DingTalkWikiSpaceService._fetch_all_wikispace_nodes(
                wikispace_mcp_url="https://ws.mcp.example.com",
                docs_mcp_url="https://docs.mcp.example.com",
            )

        assert len(result) == 1
        kb_root = result[0]
        assert kb_root["nodeId"] == "WSABC"
        assert kb_root["nodeType"] == "folder"
        assert kb_root["workspaceId"] == "WSABC"
        assert kb_root["name"] == "Test KB"

    @pytest.mark.asyncio
    async def test_uses_wikispace_mcp_url_as_docs_fallback(self) -> None:
        """Falls back to wikispace MCP URL when docs MCP URL is not configured."""
        kb_nodes = [{"workspaceId": "WS1", "name": "KB 1"}]
        captured_sessions: list = []

        async def capture_session(
            session: object, workspace_id: str, all_nodes: list
        ) -> None:
            captured_sessions.append(session)

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        with (
            patch.object(
                DingTalkWikiSpaceService,
                "_list_wiki_spaces",
                new=AsyncMock(return_value=kb_nodes),
            ),
            patch.object(
                DingTalkWikiSpaceService,
                "_list_nodes_in_wikispace",
                new=AsyncMock(side_effect=capture_session),
            ),
            patch("mcp.client.streamable_http.streamablehttp_client") as mock_http,
            patch("mcp.ClientSession") as mock_cls,
        ):
            mock_http.return_value.__aenter__ = AsyncMock(
                return_value=(MagicMock(), MagicMock(), None)
            )
            mock_http.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            await DingTalkWikiSpaceService._fetch_all_wikispace_nodes(
                wikispace_mcp_url="https://ws.mcp.example.com",
                docs_mcp_url=None,
            )

        assert len(captured_sessions) == 1
        mock_http.assert_called_once()
        call_args = mock_http.call_args
        assert call_args is not None
        assert call_args.kwargs.get("url") == "https://ws.mcp.example.com"

    @pytest.mark.asyncio
    async def test_skips_kb_with_no_workspace_id(self) -> None:
        """Skips KB nodes that have no workspaceId/nodeId/id field."""
        kb_nodes = [
            {"name": "No ID KB"},
            {"workspaceId": "WS2", "name": "Good KB"},
        ]
        list_nodes_calls: list[str] = []

        async def track_call(
            session: object, workspace_id: str, all_nodes: list
        ) -> None:
            list_nodes_calls.append(workspace_id)

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        with (
            patch.object(
                DingTalkWikiSpaceService,
                "_list_wiki_spaces",
                new=AsyncMock(return_value=kb_nodes),
            ),
            patch.object(
                DingTalkWikiSpaceService,
                "_list_nodes_in_wikispace",
                new=AsyncMock(side_effect=track_call),
            ),
            patch("mcp.client.streamable_http.streamablehttp_client") as mock_http,
            patch("mcp.ClientSession") as mock_cls,
        ):
            mock_http.return_value.__aenter__ = AsyncMock(
                return_value=(MagicMock(), MagicMock(), None)
            )
            mock_http.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await DingTalkWikiSpaceService._fetch_all_wikispace_nodes(
                wikispace_mcp_url="https://ws.mcp.example.com",
            )

        assert list_nodes_calls == ["WS2"]
        assert len(result) == 1
        assert result[0]["workspaceId"] == "WS2"

    @pytest.mark.asyncio
    async def test_continues_after_kb_error(self) -> None:
        """Continues syncing remaining KBs even if one fails."""
        kb_nodes = [
            {"workspaceId": "WS_FAIL", "name": "Failing KB"},
            {"workspaceId": "WS_OK", "name": "Good KB"},
        ]
        call_count = 0

        async def maybe_fail(
            session: object, workspace_id: str, all_nodes: list
        ) -> None:
            nonlocal call_count
            call_count += 1
            if workspace_id == "WS_FAIL":
                raise ConnectionError("MCP connection failed")

        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()

        with (
            patch.object(
                DingTalkWikiSpaceService,
                "_list_wiki_spaces",
                new=AsyncMock(return_value=kb_nodes),
            ),
            patch.object(
                DingTalkWikiSpaceService,
                "_list_nodes_in_wikispace",
                new=AsyncMock(side_effect=maybe_fail),
            ),
            patch("mcp.client.streamable_http.streamablehttp_client") as mock_http,
            patch("mcp.ClientSession") as mock_cls,
        ):
            mock_http.return_value.__aenter__ = AsyncMock(
                return_value=(MagicMock(), MagicMock(), None)
            )
            mock_http.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_session)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await DingTalkWikiSpaceService._fetch_all_wikispace_nodes(
                wikispace_mcp_url="https://ws.mcp.example.com",
            )

        assert call_count == 2
        assert len(result) == 1
        assert result[0]["workspaceId"] == "WS_OK"
        assert all(node.get("workspaceId") != "WS_FAIL" for node in result)


class TestDedupeNodesById:
    """Tests for DingTalkWikiSpaceService._dedupe_nodes_by_id."""

    def test_keeps_more_complete_duplicate(self) -> None:
        """More complete node replaces less complete node with same ID."""
        nodes = [
            {"nodeId": "dup-1", "name": "Node", "url": ""},
            {
                "nodeId": "dup-1",
                "name": "Node",
                "url": "https://example.com",
                "workspaceId": "WS1",
            },
        ]

        result = DingTalkWikiSpaceService._dedupe_nodes_by_id(nodes)

        assert len(result) == 1
        assert result[0]["url"] == "https://example.com"
        assert result[0]["workspaceId"] == "WS1"

    def test_keeps_first_node_when_completeness_ties(self) -> None:
        """When completeness is tied, the first node remains selected."""
        first = {"nodeId": "dup-2", "name": "First", "workspaceId": "WS1"}
        second = {"nodeId": "dup-2", "name": "Second", "workspaceId": "WS2"}

        result = DingTalkWikiSpaceService._dedupe_nodes_by_id([first, second])

        assert len(result) == 1
        assert result[0]["name"] == "First"
        assert result[0]["workspaceId"] == "WS1"


class TestReadHelpers:
    """Tests for read-only wikispace helper methods."""

    def test_get_wikispace_nodes_returns_only_active_wikispace_nodes(
        self, test_db, test_user
    ) -> None:
        """Only active nodes from wikispace source are returned."""
        now = datetime.now()
        active_wikispace = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="w" * 32,
            name="Active Wiki",
            doc_url="https://alidocs.dingtalk.com/i/nodes/wiki",
            parent_node_id="",
            node_type="folder",
            source=DingTalkNodeSource.WIKISPACE.value,
            is_active=True,
            last_synced_at=now,
            content_updated_at=now,
        )
        inactive_wikispace = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="x" * 32,
            name="Inactive Wiki",
            doc_url="https://alidocs.dingtalk.com/i/nodes/wiki2",
            parent_node_id="",
            node_type="folder",
            source=DingTalkNodeSource.WIKISPACE.value,
            is_active=False,
            last_synced_at=now,
            content_updated_at=now,
        )
        docs_node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="d" * 32,
            name="Docs Node",
            doc_url="https://alidocs.dingtalk.com/i/nodes/doc",
            parent_node_id="",
            node_type="doc",
            source=DingTalkNodeSource.DOCS.value,
            is_active=True,
            last_synced_at=now,
            content_updated_at=now,
        )
        test_db.add_all([active_wikispace, inactive_wikispace, docs_node])
        test_db.commit()

        result = DingTalkWikiSpaceService.get_wikispace_nodes(test_user.id, test_db)

        assert len(result) == 1
        assert result[0].name == "Active Wiki"

    @patch.object(DingTalkWikiSpaceService, "is_configured", return_value=True)
    def test_get_sync_status_counts_only_active_wikispace_nodes(
        self, _mock_is_configured: MagicMock, test_db, test_user
    ) -> None:
        """Sync status excludes docs source and inactive wikispace rows."""
        older = datetime(2026, 1, 1, 10, 0, 0)
        newer = datetime(2026, 1, 2, 10, 0, 0)
        active_old = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Active Old",
            doc_url="https://alidocs.dingtalk.com/i/nodes/a",
            parent_node_id="",
            node_type="folder",
            source=DingTalkNodeSource.WIKISPACE.value,
            is_active=True,
            last_synced_at=older,
            content_updated_at=older,
        )
        active_new = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="b" * 32,
            name="Active New",
            doc_url="https://alidocs.dingtalk.com/i/nodes/b",
            parent_node_id="",
            node_type="doc",
            source=DingTalkNodeSource.WIKISPACE.value,
            is_active=True,
            last_synced_at=newer,
            content_updated_at=newer,
        )
        docs_node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="c" * 32,
            name="Docs Node",
            doc_url="https://alidocs.dingtalk.com/i/nodes/c",
            parent_node_id="",
            node_type="doc",
            source=DingTalkNodeSource.DOCS.value,
            is_active=True,
            last_synced_at=datetime(2026, 1, 3, 10, 0, 0),
            content_updated_at=datetime(2026, 1, 3, 10, 0, 0),
        )
        test_db.add_all([active_old, active_new, docs_node])
        test_db.commit()

        status = DingTalkWikiSpaceService.get_sync_status(test_user, test_db)

        assert status["is_configured"] is True
        assert status["total_nodes"] == 2
        assert status["last_synced_at"] == newer


# ---------------------------------------------------------------------------
# sync_wikispace_nodes (integration-style with mocked MCP)
# ---------------------------------------------------------------------------


class TestSyncWikispaceNodes:
    """Tests for DingTalkWikiSpaceService.sync_wikispace_nodes."""

    @pytest.mark.asyncio
    @patch("app.services.dingtalk_wikispace_service.UserMCPService")
    @patch("app.services.dingtalk_wikispace_service.DingTalkDocService")
    async def test_raises_when_not_configured(
        self, _mock_doc_service: MagicMock, mock_mcp_svc: MagicMock
    ) -> None:
        """Raises ValueError when wikispace MCP URL is not configured."""
        mock_mcp_svc.get_provider_service_config.return_value = {"enabled": False}
        mock_user = MagicMock()
        mock_db = MagicMock()

        with pytest.raises(ValueError, match="not configured"):
            await DingTalkWikiSpaceService.sync_wikispace_nodes(mock_user, mock_db)

    @pytest.mark.asyncio
    @patch("app.services.dingtalk_wikispace_service.UserMCPService")
    async def test_uses_docs_mcp_url_for_list_nodes(
        self, mock_mcp_svc: MagicMock
    ) -> None:
        """Passes the docs MCP URL to _fetch_all_wikispace_nodes."""
        mock_mcp_svc.get_provider_service_config.return_value = {
            "enabled": True,
            "url": "https://ws.mcp.example.com",
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        captured: dict = {}

        async def fake_fetch(
            wikispace_mcp_url: str,
            docs_mcp_url: str | None = None,
        ) -> list:
            captured["wikispace_url"] = wikispace_mcp_url
            captured["docs_url"] = docs_mcp_url
            return []

        with (
            patch.object(
                DingTalkWikiSpaceService,
                "_fetch_all_wikispace_nodes",
                new=fake_fetch,
            ),
            patch(
                "app.services.dingtalk_wikispace_service.DingTalkDocService"
                ".get_user_dingtalk_mcp_url",
                return_value="https://docs.mcp.example.com",
            ),
            patch(
                "app.services.dingtalk_wikispace_service.DingTalkDocService"
                "._sync_nodes_to_db",
                return_value={
                    "added": 0,
                    "updated": 0,
                    "deleted": 0,
                    "total": 0,
                    "sync_time": datetime.now(),
                },
            ),
        ):
            await DingTalkWikiSpaceService.sync_wikispace_nodes(mock_user, mock_db)

        assert captured["wikispace_url"] == "https://ws.mcp.example.com"
        assert captured["docs_url"] == "https://docs.mcp.example.com"
