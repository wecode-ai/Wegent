# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for DingTalk WikiSpace sync endpoints."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.dingtalk_wikispace import router
from app.core import security
from app.models.user import User
from app.services.dingtalk_doc_service import DingTalkMCPToolError


@pytest.fixture
def dingtalk_wikispace_client(test_db: Session, test_user: User) -> TestClient:
    """Create a focused test client for DingTalk WikiSpace endpoints."""
    app = FastAPI()
    app.include_router(router, prefix="/dingtalk-wikispace")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user
    return TestClient(app)


@pytest.mark.api
class TestSyncDingtalkWikispace:
    """Tests for POST /dingtalk-wikispace/sync."""

    @patch(
        "app.api.endpoints.dingtalk_wikispace.DingTalkWikiSpaceService"
        ".get_user_wikispace_mcp_url",
        return_value="https://wikispace.mcp.example.com",
    )
    @patch(
        "app.api.endpoints.dingtalk_wikispace.DingTalkWikiSpaceService"
        ".sync_wikispace_nodes",
        side_effect=DingTalkMCPToolError(
            "DingTalk MCP tool returned an unsuccessful result"
        ),
    )
    def test_mcp_fetch_failure_returns_failure_response(
        self,
        mock_sync: MagicMock,
        mock_get_url: MagicMock,
        dingtalk_wikispace_client: TestClient,
    ) -> None:
        """An MCP fetch failure is never reported as a successful sync."""
        response = dingtalk_wikispace_client.post("/dingtalk-wikispace/sync")

        assert response.status_code == 500
        assert response.json()["detail"] == "Failed to sync DingTalk wikispace nodes"
