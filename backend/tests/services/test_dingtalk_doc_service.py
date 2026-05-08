# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk document sync service."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.services.dingtalk_doc_service import DingTalkDocService


class TestGetUserDingtalkMcpUrl:
    """Tests for get_user_dingtalk_mcp_url."""

    @patch("app.services.dingtalk_doc_service.UserMCPService")
    def test_returns_url_when_enabled(self, mock_mcp_service: MagicMock) -> None:
        """Returns decrypted URL when DingTalk Docs MCP is enabled."""
        mock_mcp_service.get_provider_service_config.return_value = {
            "enabled": True,
            "url": "https://mcp.example.com/dingtalk",
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.get_user_dingtalk_mcp_url(mock_user, mock_db)

        assert result == "https://mcp.example.com/dingtalk"
        mock_mcp_service.get_provider_service_config.assert_called_once_with(
            mock_user.preferences,
            provider_id="dingtalk",
            service_id="docs",
        )

    @patch("app.services.dingtalk_doc_service.UserMCPService")
    def test_returns_none_when_disabled(self, mock_mcp_service: MagicMock) -> None:
        """Returns None when DingTalk Docs MCP is disabled."""
        mock_mcp_service.get_provider_service_config.return_value = {
            "enabled": False,
            "url": "https://mcp.example.com/dingtalk",
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.get_user_dingtalk_mcp_url(mock_user, mock_db)

        assert result is None

    @patch("app.services.dingtalk_doc_service.UserMCPService")
    def test_returns_none_when_url_is_empty(self, mock_mcp_service: MagicMock) -> None:
        """Returns None when URL is empty string."""
        mock_mcp_service.get_provider_service_config.return_value = {
            "enabled": True,
            "url": "",
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.get_user_dingtalk_mcp_url(mock_user, mock_db)

        assert result is None

    @patch("app.services.dingtalk_doc_service.UserMCPService")
    def test_returns_none_when_url_is_whitespace(
        self, mock_mcp_service: MagicMock
    ) -> None:
        """Returns None when URL is only whitespace."""
        mock_mcp_service.get_provider_service_config.return_value = {
            "enabled": True,
            "url": "   ",
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.get_user_dingtalk_mcp_url(mock_user, mock_db)

        assert result is None

    @patch("app.services.dingtalk_doc_service.UserMCPService")
    def test_returns_none_when_config_missing(
        self, mock_mcp_service: MagicMock
    ) -> None:
        """Returns None when no config is returned (no URL key)."""
        mock_mcp_service.get_provider_service_config.return_value = {
            "enabled": True,
        }
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.get_user_dingtalk_mcp_url(mock_user, mock_db)

        assert result is None


class TestIsConfigured:
    """Tests for is_configured."""

    @patch.object(DingTalkDocService, "get_user_dingtalk_mcp_url")
    def test_returns_true_when_url_configured(self, mock_get_url: MagicMock) -> None:
        """Returns True when MCP URL is configured."""
        mock_get_url.return_value = "https://mcp.example.com/dingtalk"
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.is_configured(mock_user, mock_db)

        assert result is True

    @patch.object(DingTalkDocService, "get_user_dingtalk_mcp_url")
    def test_returns_false_when_url_not_configured(
        self, mock_get_url: MagicMock
    ) -> None:
        """Returns False when MCP URL is not configured."""
        mock_get_url.return_value = None
        mock_user = MagicMock()
        mock_db = MagicMock()

        result = DingTalkDocService.is_configured(mock_user, mock_db)

        assert result is False


class TestSyncNodesToDb:
    """Tests for _sync_nodes_to_db using real database session."""

    def test_adds_new_nodes(self, test_db: Session, test_user: User) -> None:
        """New nodes are added to the database."""
        now = datetime.now(timezone.utc)
        nodes = [
            {
                "nodeId": "abc123abc123abc123abc123abc12301",
                "name": "Test Doc",
                "nodeType": "doc",
                "url": "https://alidocs.dingtalk.com/i/nodes/abc123abc123abc123abc123abc12301",
                "parentId": None,
                "workspaceId": "ws001",
                "contentType": "ALIDOC",
                "extension": "adoc",
            },
            {
                "nodeId": "abc123abc123abc123abc123abc12302",
                "name": "Test Folder",
                "nodeType": "folder",
                "url": "https://alidocs.dingtalk.com/i/nodes/abc123abc123abc123abc123abc12302",
                "parentId": None,
                "workspaceId": "ws001",
                "contentType": None,
                "extension": None,
            },
        ]

        result = DingTalkDocService._sync_nodes_to_db(test_user.id, nodes, now, test_db)

        assert result["added"] == 2
        assert result["updated"] == 0
        assert result["deleted"] == 0
        assert result["total"] == 2

        # Verify records in database
        db_nodes = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.user_id == test_user.id)
            .all()
        )
        assert len(db_nodes) == 2

    def test_updates_existing_nodes(self, test_db: Session, test_user: User) -> None:
        """Existing nodes are updated when data changes."""
        now = datetime.now(timezone.utc)
        dingtalk_node_id = "abc123abc123abc123abc123abc12303"

        # Create an existing node
        existing = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id=dingtalk_node_id,
            name="Old Name",
            doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
            parent_node_id="",
            node_type="doc",
            workspace_id="ws001",
            content_type="ALIDOC",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(existing)
        test_db.commit()

        # Sync with updated name
        new_now = datetime.now(timezone.utc)
        nodes = [
            {
                "nodeId": dingtalk_node_id,
                "name": "New Name",
                "nodeType": "doc",
                "url": f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
                "parentId": None,
                "workspaceId": "ws001",
                "contentType": "ALIDOC",
                "extension": "adoc",
            },
        ]

        result = DingTalkDocService._sync_nodes_to_db(
            test_user.id, nodes, new_now, test_db
        )

        assert result["added"] == 0
        assert result["updated"] == 1
        assert result["deleted"] == 0
        assert result["total"] == 1

        # Verify name was updated
        test_db.refresh(existing)
        assert existing.name == "New Name"

    def test_marks_missing_nodes_as_inactive(
        self, test_db: Session, test_user: User
    ) -> None:
        """Nodes not in the sync list are marked as inactive."""
        # Use local time (no timezone) to match how _parse_update_time works
        now = datetime.now()

        # Create existing nodes with empty strings for parent_node_id
        # to match how sync processes nodes without parentId
        node1 = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="abc123abc123abc123abc123abc12304",
            name="Keep This",
            doc_url="https://alidocs.dingtalk.com/i/nodes/abc123abc123abc123abc123abc12304",
            parent_node_id="",
            node_type="doc",
            workspace_id="",
            content_type="",
            content_updated_at=now,
            is_active=True,
            last_synced_at=now,
        )
        node2 = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="abc123abc123abc123abc123abc12305",
            name="Remove This",
            doc_url="https://alidocs.dingtalk.com/i/nodes/abc123abc123abc123abc123abc12305",
            parent_node_id="",
            node_type="doc",
            workspace_id="",
            content_type="",
            content_updated_at=now,
            is_active=True,
            last_synced_at=now,
        )
        test_db.add_all([node1, node2])
        test_db.commit()

        # Sync with only node1 present - use updateTime to match content_updated_at
        new_now = datetime.now()
        nodes = [
            {
                "nodeId": "abc123abc123abc123abc123abc12304",
                "name": "Keep This",
                "nodeType": "doc",
                "updateTime": now.timestamp(),  # Match existing content_updated_at
            },
        ]

        result = DingTalkDocService._sync_nodes_to_db(
            test_user.id, nodes, new_now, test_db
        )

        assert result["added"] == 0
        assert result["updated"] == 0
        assert result["deleted"] == 1
        assert result["total"] == 1

        # Verify node2 is now inactive
        test_db.refresh(node2)
        assert node2.is_active is False

    def test_reactivates_inactive_node(self, test_db: Session, test_user: User) -> None:
        """Previously inactive nodes are reactivated when they reappear in sync."""
        now = datetime.now(timezone.utc)
        dingtalk_node_id = "abc123abc123abc123abc123abc12306"

        # Create an inactive node
        existing = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id=dingtalk_node_id,
            name="Reactivated Doc",
            doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
            parent_node_id="",
            node_type="doc",
            is_active=False,
            last_synced_at=now,
        )
        test_db.add(existing)
        test_db.commit()

        # Sync with the node reappearing
        new_now = datetime.now(timezone.utc)
        nodes = [
            {
                "nodeId": dingtalk_node_id,
                "name": "Reactivated Doc",
                "nodeType": "doc",
            },
        ]

        result = DingTalkDocService._sync_nodes_to_db(
            test_user.id, nodes, new_now, test_db
        )

        # Should be counted as updated because is_active changed
        assert result["updated"] == 1
        assert result["total"] == 1

        test_db.refresh(existing)
        assert existing.is_active is True

    def test_skips_nodes_without_node_id(
        self, test_db: Session, test_user: User
    ) -> None:
        """Nodes with missing nodeId are skipped."""
        now = datetime.now(timezone.utc)
        nodes = [
            {"name": "No Node ID", "nodeType": "doc"},
            {"nodeId": "", "name": "Empty Node ID", "nodeType": "doc"},
        ]

        result = DingTalkDocService._sync_nodes_to_db(test_user.id, nodes, now, test_db)

        assert result["added"] == 0
        assert result["total"] == 0

    def test_builds_default_url_when_missing(
        self, test_db: Session, test_user: User
    ) -> None:
        """Default doc URL is built when url field is missing."""
        now = datetime.now(timezone.utc)
        dingtalk_node_id = "abc123abc123abc123abc123abc12307"

        nodes = [
            {
                "nodeId": dingtalk_node_id,
                "name": "No URL Doc",
                "nodeType": "doc",
            },
        ]

        DingTalkDocService._sync_nodes_to_db(test_user.id, nodes, now, test_db)

        db_node = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.dingtalk_node_id == dingtalk_node_id)
            .first()
        )
        assert db_node is not None
        assert (
            db_node.doc_url
            == f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}"
        )

    def test_maps_node_types_correctly(self, test_db: Session, test_user: User) -> None:
        """Node types are mapped correctly from DingTalk data."""
        now = datetime.now(timezone.utc)
        nodes = [
            {"nodeId": "a" * 32, "name": "Folder", "nodeType": "folder"},
            {"nodeId": "b" * 32, "name": "File", "nodeType": "file"},
            {"nodeId": "c" * 32, "name": "Doc", "nodeType": "doc"},
            {"nodeId": "d" * 32, "name": "Other", "nodeType": "other"},
        ]

        DingTalkDocService._sync_nodes_to_db(test_user.id, nodes, now, test_db)

        folder = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.dingtalk_node_id == "a" * 32)
            .first()
        )
        assert folder.node_type == "folder"

        file = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.dingtalk_node_id == "b" * 32)
            .first()
        )
        assert file.node_type == "file"

        doc = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.dingtalk_node_id == "c" * 32)
            .first()
        )
        assert doc.node_type == "doc"

        other = (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.dingtalk_node_id == "d" * 32)
            .first()
        )
        # Unknown types default to "doc"
        assert other.node_type == "doc"

    def test_no_change_counts_as_neither_added_nor_updated(
        self, test_db: Session, test_user: User
    ) -> None:
        """Existing node with no field changes is counted as neither added nor updated."""
        # Use local time (no timezone) to match how _parse_update_time works
        now = datetime.now()
        dingtalk_node_id = "abc123abc123abc123abc123abc12308"

        existing = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id=dingtalk_node_id,
            name="Stable Doc",
            doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
            parent_node_id="",
            node_type="doc",
            workspace_id="",
            content_type="",
            content_updated_at=now,
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(existing)
        test_db.commit()

        # Sync same data with matching content_updated_at (via updateTime)
        new_now = datetime.now()
        nodes = [
            {
                "nodeId": dingtalk_node_id,
                "name": "Stable Doc",
                "nodeType": "doc",
                "updateTime": now.timestamp(),  # Match existing content_updated_at
            },
        ]

        result = DingTalkDocService._sync_nodes_to_db(
            test_user.id, nodes, new_now, test_db
        )

        assert result["added"] == 0
        assert result["updated"] == 0
        assert result["total"] == 1

        # last_synced_at should still be updated
        test_db.refresh(existing)
        assert existing.last_synced_at == new_now


class TestGetDingtalkDocs:
    """Tests for get_dingtalk_docs."""

    def test_returns_only_active_nodes(self, test_db: Session, test_user: User) -> None:
        """Only active nodes are returned."""
        now = datetime.now(timezone.utc)

        active = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Active Doc",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        inactive = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="b" * 32,
            name="Inactive Doc",
            doc_url="https://alidocs.dingtalk.com/i/nodes/bbb",
            parent_node_id="",
            node_type="doc",
            is_active=False,
            last_synced_at=now,
        )
        test_db.add_all([active, inactive])
        test_db.commit()

        result = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)

        assert len(result) == 1
        assert result[0].name == "Active Doc"

    def test_returns_empty_list_when_no_nodes(
        self, test_db: Session, test_user: User
    ) -> None:
        """Returns empty list when user has no synced nodes."""
        result = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)

        assert result == []

    def test_orders_by_node_type_and_name(
        self, test_db: Session, test_user: User
    ) -> None:
        """Results are ordered by node_type then name (alphabetical)."""
        now = datetime.now(timezone.utc)

        doc_node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Zebra Doc",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        folder_node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="b" * 32,
            name="Alpha Folder",
            doc_url="https://alidocs.dingtalk.com/i/nodes/bbb",
            parent_node_id="",
            node_type="folder",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add_all([doc_node, folder_node])
        test_db.commit()

        result = DingTalkDocService.get_dingtalk_docs(test_user.id, test_db)

        # Alphabetical sort: "doc" < "folder"
        assert result[0].node_type == "doc"
        assert result[0].name == "Zebra Doc"
        assert result[1].node_type == "folder"
        assert result[1].name == "Alpha Folder"

    def test_filters_by_user_id(self, test_db: Session, test_user: User) -> None:
        """Only nodes belonging to the specified user are returned."""
        now = datetime.now(timezone.utc)

        # Create node for test_user
        node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="User Doc",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(node)
        test_db.commit()

        # Query with different user_id
        other_user_id = test_user.id + 9999
        result = DingTalkDocService.get_dingtalk_docs(other_user_id, test_db)

        assert result == []


class TestGetSyncStatus:
    """Tests for get_sync_status."""

    @patch.object(DingTalkDocService, "is_configured", return_value=True)
    def test_returns_status_when_configured(
        self, mock_is_configured: MagicMock, test_db: Session, test_user: User
    ) -> None:
        """Returns correct status when DingTalk is configured with synced nodes."""
        now = datetime.now(timezone.utc)
        node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Synced Doc",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(node)
        test_db.commit()

        status = DingTalkDocService.get_sync_status(test_user, test_db)

        assert status["is_configured"] is True
        assert status["total_nodes"] == 1
        assert status["last_synced_at"] is not None

    @patch.object(DingTalkDocService, "is_configured", return_value=False)
    def test_returns_not_configured_when_no_mcp(
        self, mock_is_configured: MagicMock, test_db: Session, test_user: User
    ) -> None:
        """Returns is_configured=False when MCP URL is not set."""
        status = DingTalkDocService.get_sync_status(test_user, test_db)

        assert status["is_configured"] is False
        assert status["total_nodes"] == 0
        assert status["last_synced_at"] is None

    @patch.object(DingTalkDocService, "is_configured", return_value=True)
    def test_returns_zero_nodes_when_no_syncs(
        self, mock_is_configured: MagicMock, test_db: Session, test_user: User
    ) -> None:
        """Returns total_nodes=0 when user has configured but never synced."""
        status = DingTalkDocService.get_sync_status(test_user, test_db)

        assert status["is_configured"] is True
        assert status["total_nodes"] == 0
        assert status["last_synced_at"] is None

    @patch.object(DingTalkDocService, "is_configured", return_value=True)
    def test_excludes_inactive_nodes_from_count(
        self, mock_is_configured: MagicMock, test_db: Session, test_user: User
    ) -> None:
        """Inactive nodes are not counted in total_nodes."""
        now = datetime.now(timezone.utc)
        active = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Active",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        inactive = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="b" * 32,
            name="Inactive",
            doc_url="https://alidocs.dingtalk.com/i/nodes/bbb",
            parent_node_id="",
            node_type="doc",
            is_active=False,
            last_synced_at=now,
        )
        test_db.add_all([active, inactive])
        test_db.commit()

        status = DingTalkDocService.get_sync_status(test_user, test_db)

        assert status["total_nodes"] == 1


class TestListNodesRecursive:
    """Tests for _list_nodes_recursive - verifies folder traversal behavior."""

    @pytest.mark.asyncio
    async def test_recurses_into_folder_without_has_children_flag(self) -> None:
        """Folders are recursed into even when hasChildren is absent or False.

        This is the key regression test: previously the code required
        node.get("hasChildren") to be truthy, which caused child nodes to be
        missed when the DingTalk MCP API omitted or set hasChildren=False.
        """
        import json

        call_log: list[str | None] = []

        root_folder_node = {
            "nodeId": "folder001",
            "name": "Root Folder",
            "nodeType": "folder",
            # hasChildren intentionally omitted
        }

        async def mock_call_tool_with_data(tool_name: str, args: dict) -> MagicMock:
            folder_id = args.get("folderId")
            call_log.append(folder_id)
            result = MagicMock()
            result.meta = None
            if folder_id is None:
                # Root call: return a folder without hasChildren
                content_item = MagicMock()
                content_item.type = "text"
                content_item.text = json.dumps([root_folder_node])
                result.content = [content_item]
            else:
                # Folder call: return empty
                result.content = []
            return result

        mock_session = MagicMock()
        mock_session.call_tool = mock_call_tool_with_data

        all_nodes: list = []
        await DingTalkDocService._list_nodes_recursive(
            mock_session,
            folder_id=None,
            workspace_id=None,
            all_nodes=all_nodes,
            depth=0,
        )

        # Should have called list_nodes for root AND for the folder
        assert None in call_log, "Root call (folderId=None) should have been made"
        assert (
            "folder001" in call_log
        ), "Folder 'folder001' should have been recursed into even without hasChildren flag"
        assert len(all_nodes) == 1
        assert all_nodes[0]["nodeId"] == "folder001"

    @pytest.mark.asyncio
    async def test_recurses_into_folder_with_has_children_false(self) -> None:
        """Folders are recursed into even when hasChildren is explicitly False."""
        import json

        call_log: list[str | None] = []

        folder_node = {
            "nodeId": "folder002",
            "name": "Folder With False HasChildren",
            "nodeType": "folder",
            "hasChildren": False,  # Explicitly False - old code would skip this
        }

        async def mock_call_tool(tool_name: str, args: dict) -> MagicMock:
            folder_id = args.get("folderId")
            call_log.append(folder_id)
            result = MagicMock()
            result.meta = None
            if folder_id is None:
                content_item = MagicMock()
                content_item.type = "text"
                content_item.text = json.dumps([folder_node])
                result.content = [content_item]
            else:
                result.content = []
            return result

        mock_session = MagicMock()
        mock_session.call_tool = mock_call_tool

        all_nodes: list = []
        await DingTalkDocService._list_nodes_recursive(
            mock_session,
            folder_id=None,
            workspace_id=None,
            all_nodes=all_nodes,
            depth=0,
        )

        assert (
            "folder002" in call_log
        ), "Folder should be recursed into even when hasChildren=False"

    @pytest.mark.asyncio
    async def test_injects_parent_id_into_child_nodes(self) -> None:
        """Child nodes get parentId injected from the calling folder_id.

        The DingTalk MCP list_nodes API does NOT return parent node information.
        When we call list_nodes(folderId=X), the returned nodes are children of X,
        so we must inject parentId=X into each returned node to preserve the
        tree structure in the database.
        """
        import json

        folder_id = "folder_parent_001"
        child_doc = {
            "nodeId": "doc_child_001",
            "name": "Child Document",
            "nodeType": "doc",
            # No parentId in the MCP response
        }

        async def mock_call_tool(tool_name: str, args: dict) -> MagicMock:
            fid = args.get("folderId")
            result = MagicMock()
            result.meta = None
            if fid == folder_id:
                content_item = MagicMock()
                content_item.type = "text"
                content_item.text = json.dumps([child_doc])
                result.content = [content_item]
            else:
                result.content = []
            return result

        mock_session = MagicMock()
        mock_session.call_tool = mock_call_tool

        all_nodes: list = []
        await DingTalkDocService._list_nodes_recursive(
            mock_session,
            folder_id=folder_id,
            workspace_id=None,
            all_nodes=all_nodes,
            depth=0,
        )

        assert len(all_nodes) == 1
        assert all_nodes[0]["nodeId"] == "doc_child_001"
        assert all_nodes[0]["parentId"] == folder_id, (
            "parentId should be injected from the folder_id parameter "
            "since DingTalk MCP does not return parent info"
        )

    @pytest.mark.asyncio
    async def test_root_nodes_have_no_parent_id_injected(self) -> None:
        """Root-level nodes (folder_id=None) do not get a parentId injected."""
        import json

        root_doc = {
            "nodeId": "doc_root_001",
            "name": "Root Document",
            "nodeType": "doc",
        }

        async def mock_call_tool(tool_name: str, args: dict) -> MagicMock:
            result = MagicMock()
            result.meta = None
            if args.get("folderId") is None:
                content_item = MagicMock()
                content_item.type = "text"
                content_item.text = json.dumps([root_doc])
                result.content = [content_item]
            else:
                result.content = []
            return result

        mock_session = MagicMock()
        mock_session.call_tool = mock_call_tool

        all_nodes: list = []
        await DingTalkDocService._list_nodes_recursive(
            mock_session,
            folder_id=None,
            workspace_id=None,
            all_nodes=all_nodes,
            depth=0,
        )

        assert len(all_nodes) == 1
        # Root nodes should not have parentId injected (folder_id is None)
        assert (
            all_nodes[0].get("parentId") is None
        ), "Root-level nodes should not have parentId injected"


class TestDeleteSyncedNode:
    """Tests for delete_synced_node."""

    def test_deletes_existing_node(self, test_db: Session, test_user: User) -> None:
        """Deletes a node that belongs to the user."""
        now = datetime.now(timezone.utc)
        node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="To Delete",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(node)
        test_db.commit()

        result = DingTalkDocService.delete_synced_node(node.id, test_user.id, test_db)

        assert result is True
        # Verify node is gone
        assert (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.id == node.id)
            .first()
            is None
        )

    def test_returns_false_for_nonexistent_node(
        self, test_db: Session, test_user: User
    ) -> None:
        """Returns False when node does not exist."""
        result = DingTalkDocService.delete_synced_node(99999, test_user.id, test_db)

        assert result is False

    def test_returns_false_for_wrong_user(
        self, test_db: Session, test_user: User
    ) -> None:
        """Returns False when node belongs to a different user."""
        now = datetime.now(timezone.utc)
        node = DingtalkSyncedNode(
            user_id=test_user.id,
            dingtalk_node_id="a" * 32,
            name="Other User Node",
            doc_url="https://alidocs.dingtalk.com/i/nodes/aaa",
            parent_node_id="",
            node_type="doc",
            is_active=True,
            last_synced_at=now,
        )
        test_db.add(node)
        test_db.commit()

        # Try to delete with a different user_id
        result = DingTalkDocService.delete_synced_node(
            node.id, test_user.id + 9999, test_db
        )

        assert result is False
        # Verify node still exists
        assert (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.id == node.id)
            .first()
            is not None
        )
