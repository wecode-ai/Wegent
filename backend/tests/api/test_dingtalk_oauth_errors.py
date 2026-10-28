"""Directory refresh must preserve actionable OAuth concurrency errors."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.dingtalk_docs import router as docs_router
from app.api.endpoints.dingtalk_wikispace import router as wiki_router
from app.core.security import get_current_user
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService
from app.services.user_mcp_oauth import UserMcpOAuthService
from app.services.user_mcp_service import MCPPreferencesError


@pytest.mark.parametrize("source", ["docs", "wiki"])
def test_directory_refresh_preserves_busy_retry_response(
    test_db, test_user, monkeypatch, source
):
    app = FastAPI()
    app.include_router(docs_router, prefix="/docs")
    app.include_router(wiki_router, prefix="/wiki")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: test_user
    monkeypatch.setattr(DingTalkDocService, "is_configured", lambda user: True)
    monkeypatch.setattr(
        DingTalkDocService,
        "get_user_dingtalk_mcp_url",
        lambda user: "https://mcp.test/docs",
    )
    monkeypatch.setattr(
        DingTalkWikiSpaceService,
        "get_user_wikispace_mcp_url",
        lambda user: "https://mcp.test/wiki",
    )
    monkeypatch.setattr(
        UserMcpOAuthService,
        "provider_service_headers",
        AsyncMock(
            side_effect=MCPPreferencesError("MCP authorization is busy; retry", 503)
        ),
    )

    with TestClient(app) as client:
        response = client.post(f"/{source}/sync")

    assert response.status_code == 503
    assert "retry" in response.json()["detail"]
