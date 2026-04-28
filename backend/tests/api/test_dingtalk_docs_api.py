# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for DingTalk synced document endpoints."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints.dingtalk_docs import router
from app.core import security
from app.api.dependencies import get_db
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User


@pytest.fixture
def dingtalk_client(test_db: Session, test_user: User) -> TestClient:
    """Create a focused test client for DingTalk docs endpoints."""

    app = FastAPI()
    app.include_router(router, prefix="/dingtalk-docs")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


def _create_synced_node(
    test_db: Session,
    user_id: int,
    dingtalk_node_id: str,
    name: str = "Test Doc",
    node_type: str = "doc",
    parent_node_id: str | None = None,
    workspace_id: str | None = None,
    is_active: bool = True,
) -> DingtalkSyncedNode:
    """Helper to create a DingtalkSyncedNode in the test database."""
    now = datetime.now(timezone.utc)
    node = DingtalkSyncedNode(
        user_id=user_id,
        dingtalk_node_id=dingtalk_node_id,
        name=name,
        doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
        parent_node_id=parent_node_id,
        node_type=node_type,
        workspace_id=workspace_id,
        is_active=is_active,
        last_synced_at=now,
    )
    test_db.add(node)
    test_db.commit()
    test_db.refresh(node)
    return node


@pytest.mark.api
class TestGetDingtalkDocs:
    """Tests for GET /dingtalk-docs."""

    def test_returns_empty_tree_when_no_nodes(
        self, dingtalk_client: TestClient
    ) -> None:
        """Returns empty tree when user has no synced nodes."""
        response = dingtalk_client.get("/dingtalk-docs")

        assert response.status_code == 200
        data = response.json()
        assert data["nodes"] == []
        assert data["total_count"] == 0

    def test_returns_tree_with_flat_nodes(
        self, dingtalk_client: TestClient, test_db: Session, test_user: User
    ) -> None:
        """Returns flat node list as root-level tree items when no parent-child relationships."""
        _create_synced_node(
            test_db, test_user.id, "a" * 32, name="Doc A", node_type="doc"
        )
        _create_synced_node(
            test_db, test_user.id, "b" * 32, name="Folder B", node_type="folder"
        )

        response = dingtalk_client.get("/dingtalk-docs")

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] == 2
        # Folders sorted first
        assert data["nodes"][0]["name"] == "Folder B"
        assert data["nodes"][0]["node_type"] == "folder"
        assert data["nodes"][1]["name"] == "Doc A"

    def test_returns_nested_tree_structure(
        self, dingtalk_client: TestClient, test_db: Session, test_user: User
    ) -> None:
        """Returns tree structure with children nested under parent folders."""
        parent_id = "a" * 32
        child_dingtalk_id = "b" * 32

        _create_synced_node(
            test_db,
            test_user.id,
            parent_id,
            name="Parent Folder",
            node_type="folder",
        )
        _create_synced_node(
            test_db,
            test_user.id,
            child_dingtalk_id,
            name="Child Doc",
            node_type="doc",
            parent_node_id=parent_id,
        )

        response = dingtalk_client.get("/dingtalk-docs")

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] == 2

        # Root should have only the folder
        assert len(data["nodes"]) == 1
        root = data["nodes"][0]
        assert root["name"] == "Parent Folder"
        assert root["node_type"] == "folder"
        # Child should be nested under the folder
        assert len(root["children"]) == 1
        assert root["children"][0]["name"] == "Child Doc"

    def test_excludes_inactive_nodes(
        self, dingtalk_client: TestClient, test_db: Session, test_user: User
    ) -> None:
        """Inactive nodes are excluded from the tree."""
        _create_synced_node(
            test_db,
            test_user.id,
            "a" * 32,
            name="Active Doc",
            node_type="doc",
            is_active=True,
        )
        _create_synced_node(
            test_db,
            test_user.id,
            "b" * 32,
            name="Inactive Doc",
            node_type="doc",
            is_active=False,
        )

        response = dingtalk_client.get("/dingtalk-docs")

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] == 1
        assert data["nodes"][0]["name"] == "Active Doc"


@pytest.mark.api
class TestSyncDingtalkDocs:
    """Tests for POST /dingtalk-docs/sync."""

    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.is_configured",
        return_value=False,
    )
    def test_returns_400_when_not_configured(
        self, mock_is_configured: MagicMock, dingtalk_client: TestClient
    ) -> None:
        """Returns 400 when DingTalk MCP is not configured."""
        response = dingtalk_client.post("/dingtalk-docs/sync")

        assert response.status_code == 400
        assert "not configured" in response.json()["detail"].lower()

    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.is_configured",
        return_value=True,
    )
    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.sync_dingtalk_docs"
    )
    def test_returns_sync_result_on_success(
        self,
        mock_sync: MagicMock,
        mock_is_configured: MagicMock,
        dingtalk_client: TestClient,
        test_user: User,
    ) -> None:
        """Returns sync result when sync succeeds."""
        now = datetime.now(timezone.utc)
        mock_sync.return_value = {
            "added": 5,
            "updated": 2,
            "deleted": 1,
            "total": 7,
            "sync_time": now,
        }

        response = dingtalk_client.post("/dingtalk-docs/sync")

        assert response.status_code == 200
        data = response.json()
        assert data["added"] == 5
        assert data["updated"] == 2
        assert data["deleted"] == 1
        assert data["total"] == 7

    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.is_configured",
        return_value=True,
    )
    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.sync_dingtalk_docs",
        side_effect=ValueError("MCP URL is not configured"),
    )
    def test_returns_400_on_value_error(
        self,
        mock_sync: MagicMock,
        mock_is_configured: MagicMock,
        dingtalk_client: TestClient,
    ) -> None:
        """Returns 400 when sync raises ValueError."""
        response = dingtalk_client.post("/dingtalk-docs/sync")

        assert response.status_code == 400
        assert "MCP URL is not configured" in response.json()["detail"]

    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.is_configured",
        return_value=True,
    )
    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.sync_dingtalk_docs",
        side_effect=Exception("Connection failed"),
    )
    def test_returns_500_on_unexpected_error(
        self,
        mock_sync: MagicMock,
        mock_is_configured: MagicMock,
        dingtalk_client: TestClient,
    ) -> None:
        """Returns 500 when sync raises an unexpected exception."""
        response = dingtalk_client.post("/dingtalk-docs/sync")

        assert response.status_code == 500
        assert "Failed to sync" in response.json()["detail"]


@pytest.mark.api
class TestGetSyncStatus:
    """Tests for GET /dingtalk-docs/sync-status."""

    @patch(
        "app.api.endpoints.dingtalk_docs.DingTalkDocService.get_sync_status",
    )
    def test_returns_sync_status(
        self, mock_get_status: MagicMock, dingtalk_client: TestClient
    ) -> None:
        """Returns sync status from the service."""
        now = datetime.now(timezone.utc)
        mock_get_status.return_value = {
            "last_synced_at": now,
            "total_nodes": 10,
            "is_configured": True,
        }

        response = dingtalk_client.get("/dingtalk-docs/sync-status")

        assert response.status_code == 200
        data = response.json()
        assert data["total_nodes"] == 10
        assert data["is_configured"] is True

    def test_returns_default_status_when_no_nodes(
        self, dingtalk_client: TestClient
    ) -> None:
        """Returns default status when user has no synced nodes."""
        response = dingtalk_client.get("/dingtalk-docs/sync-status")

        assert response.status_code == 200
        data = response.json()
        assert data["total_nodes"] == 0
        assert data["last_synced_at"] is None

    def test_returns_status_with_real_data(
        self,
        dingtalk_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        """Returns sync status based on actual synced nodes."""
        _create_synced_node(
            test_db, test_user.id, "a" * 32, name="Synced Doc", node_type="doc"
        )

        response = dingtalk_client.get("/dingtalk-docs/sync-status")

        assert response.status_code == 200
        data = response.json()
        assert data["total_nodes"] == 1
        assert data["last_synced_at"] is not None


@pytest.mark.api
class TestDeleteSyncedNode:
    """Tests for DELETE /dingtalk-docs/{node_id}."""

    def test_deletes_existing_node(
        self,
        dingtalk_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        """Successfully deletes a synced node that belongs to the user."""
        node = _create_synced_node(
            test_db, test_user.id, "a" * 32, name="Delete Me", node_type="doc"
        )

        response = dingtalk_client.delete(f"/dingtalk-docs/{node.id}")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        # Verify node is deleted
        assert (
            test_db.query(DingtalkSyncedNode)
            .filter(DingtalkSyncedNode.id == node.id)
            .first()
            is None
        )

    def test_returns_404_for_nonexistent_node(
        self, dingtalk_client: TestClient
    ) -> None:
        """Returns 404 when node does not exist."""
        response = dingtalk_client.delete("/dingtalk-docs/99999")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_returns_404_for_other_users_node(
        self,
        dingtalk_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        """Returns 404 when node belongs to a different user."""
        # Create node with a different user_id (not the test_user)
        node = _create_synced_node(
            test_db,
            test_user.id + 9999,
            "a" * 32,
            name="Other User Doc",
            node_type="doc",
        )

        response = dingtalk_client.delete(f"/dingtalk-docs/{node.id}")

        assert response.status_code == 404
