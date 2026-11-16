# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""System MCP configuration must advertise the mounted API path exactly once."""

import pytest

from app.core.config import settings
from app.mcp_server.server import get_mcp_system_config


@pytest.mark.parametrize(
    ("backend_url", "api_prefix", "expected_url"),
    [
        ("https://backend.example", "/api", "https://backend.example/api/mcp/system"),
        ("https://backend.example/", "/api", "https://backend.example/api/mcp/system"),
        (
            "https://backend.example/api",
            "/api",
            "https://backend.example/api/mcp/system",
        ),
        (
            "https://backend.example/api/",
            "/api",
            "https://backend.example/api/mcp/system",
        ),
        ("https://api", "/api", "https://api/api/mcp/system"),
        (
            "https://backend.example/apiary",
            "/api",
            "https://backend.example/apiary/api/mcp/system",
        ),
        (
            "https://backend.example/proxy/api/",
            "/api",
            "https://backend.example/proxy/api/mcp/system",
        ),
        (
            "https://backend.example/proxy/",
            "/api",
            "https://backend.example/proxy/api/mcp/system",
        ),
        (
            "https://backend.example/v1/",
            "/v1/",
            "https://backend.example/v1/mcp/system",
        ),
        ("https://backend.example", "api/", "https://backend.example/api/mcp/system"),
        ("https://backend.example/", "", "https://backend.example/mcp/system"),
        ("https://backend.example/api/", "", "https://backend.example/api/mcp/system"),
    ],
)
def test_system_mcp_url_uses_one_api_prefix(
    monkeypatch, backend_url: str, api_prefix: str, expected_url: str
) -> None:
    monkeypatch.setattr(settings, "API_PREFIX", api_prefix)

    config = get_mcp_system_config(backend_url, "test-task-token")["wegent-system"]

    assert config["url"] == expected_url
    assert config["headers"] == {"Authorization": "Bearer test-task-token"}
    assert config["type"] == "streamable-http"
    assert config["timeout"] == 60
