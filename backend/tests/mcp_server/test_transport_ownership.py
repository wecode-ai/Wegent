# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep Python MCP aliases available when only API-prefixed methods migrate."""

import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.mcp_server.server import (
    MCP_APP_SPECS,
    MCP_TRANSPORT_METHODS,
    _apply_mount_prefix,
    register_mcp_apps,
)


@pytest.mark.parametrize("prefix", ["", "/api", "/custom"])
def test_registered_transport_methods_follow_effective_mount(
    prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", False)
    app = FastAPI()
    register_mcp_apps(app, prefix)
    mounts = {route.path: route.app for route in app.routes if hasattr(route, "app")}

    for spec in MCP_APP_SPECS:
        effective = _apply_mount_prefix(spec, prefix)
        if prefix and spec.rust_owned_public_path:
            # The public transport belongs to backend-rs; only the internal
            # unprefixed alias stays mounted in Python.
            assert effective.mount_path not in mounts
            continue
        assert effective.mount_path == f"{prefix}{spec.mount_path}"
        assert effective.server is spec.server
        assert effective.token_context is spec.token_context
        expected = set(MCP_TRANSPORT_METHODS)
        if effective.mount_path == "/api/mcp/interactive-form-question":
            expected.remove("POST")
        elif effective.mount_path == "/api/mcp/subscription":
            expected.difference_update({"GET", "POST"})
        assert set(effective.transport_methods) == expected
        transport = next(
            route
            for route in mounts[effective.mount_path].routes
            if route.path == effective.transport_path
        )
        assert transport.methods == expected | (
            {"HEAD"} if "GET" in expected else set()
        )
        assert set(spec.transport_methods) == set(MCP_TRANSPORT_METHODS)


def test_rust_owned_public_transport_keeps_only_its_internal_alias() -> None:
    """`/api/mcp/connectors/sse` is Rust-owned; the executor alias stays."""
    from app.mcp_server.server import CONNECTORS_MCP_MOUNT_PATH

    app = FastAPI()
    register_mcp_apps(app, "/api")
    assert f"/api{CONNECTORS_MCP_MOUNT_PATH}" not in {
        route.path for route in app.routes if hasattr(route, "app")
    }

    internal = FastAPI()
    register_mcp_apps(internal)
    assert CONNECTORS_MCP_MOUNT_PATH in {
        route.path for route in internal.routes if hasattr(route, "app")
    }
