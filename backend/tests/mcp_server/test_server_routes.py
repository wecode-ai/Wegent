# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP server routing and URL configuration."""

from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app.core.config import settings
from app.main import create_app
from app.mcp_server.server import (
    _create_knowledge_mcp_app,
    get_mcp_knowledge_config,
    knowledge_mcp_server,
)


def test_knowledge_mcp_root_returns_metadata_json():
    app = _create_knowledge_mcp_app()
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "service": "wegent-knowledge-mcp",
        "transport": "streamable-http",
        "endpoints": {
            "mcp": "/mcp/knowledge/sse",
            "health": "/mcp/knowledge/health",
        },
    }


def test_get_mcp_knowledge_config_uses_sse_endpoint():
    config = get_mcp_knowledge_config(
        backend_url="http://localhost:8000",
        task_token="test-token",
    )

    assert (
        config["wegent-knowledge"]["url"] == "http://localhost:8000/mcp/knowledge/sse"
    )


def test_knowledge_mcp_sse_without_trailing_slash_does_not_redirect():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with patch.object(
        knowledge_mcp_server,
        "streamable_http_app",
        return_value=fake_streamable_app,
    ):
        app = _create_knowledge_mcp_app()

    client = TestClient(app)
    response = client.get("/sse", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"


def test_main_app_system_route_without_trailing_slash_does_not_redirect():
    fake_streamable_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )
    fake_system_app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse("ok"), methods=["GET"])]
    )

    with (
        patch.object(settings, "API_PREFIX", ""),
        patch(
            "app.mcp_server.server._build_mcp_app",
            side_effect=[fake_system_app, fake_streamable_app],
        ),
    ):
        app = create_app()

    client = TestClient(app)
    response = client.get("/mcp/system", follow_redirects=False)

    assert response.status_code == 200
    assert response.text == "ok"
