# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device interactive sessions."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import quote

import pytest


def _local_session(session_id, session_type):
    from executor.modes.local.session_handler import LocalSession

    return LocalSession(
        session_id=session_id,
        session_type=session_type,
        access_token="secret",
        project_id=123,
        path="/workspace",
        port=45678,
        process=AsyncMock(pid=1234),
        expires_at=9999999999,
    )


def test_session_gateway_forwards_websocket_protocols_without_duplicate_header():
    """WebSocket subprotocols should be negotiated through the proxy."""
    from executor.modes.local.session_handler import SessionGateway

    request = SimpleNamespace(
        headers={
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-WebSocket-Protocol": "tty, other",
            "User-Agent": "pytest",
        }
    )
    gateway = SessionGateway({})

    assert gateway._websocket_protocols(request) == ["tty", "other"]
    assert gateway._proxy_headers(request) == {
        "Accept-Encoding": "identity",
        "User-Agent": "pytest",
    }


def test_session_gateway_rewrites_code_server_origin_for_upstream():
    """Code-server upstream WebSockets should pass origin checks."""
    from executor.modes.local.session_handler import SessionGateway

    request = SimpleNamespace(
        headers={
            "Accept-Encoding": "gzip, deflate, br",
            "Origin": "http://localhost:17888",
            "User-Agent": "pytest",
        }
    )
    gateway = SessionGateway({})
    session = _local_session("code-1", "code_server")

    assert gateway._proxy_headers(request, session) == {
        "Accept-Encoding": "identity",
        "Origin": "http://127.0.0.1:45678",
        "User-Agent": "pytest",
    }


def test_session_gateway_strips_code_server_prefix_per_session():
    """Code-server sessions should be isolated by URL path prefix."""
    from executor.modes.local.session_handler import SessionGateway

    gateway = SessionGateway({})
    request = SimpleNamespace(
        path="/s/code-1/stable/static/out/workbench.js",
        query_string="token=secret&folder=/workspace",
    )
    session = _local_session("code-1", "code_server")

    assert (
        gateway._build_upstream_url(request, session, "http")
        == "http://127.0.0.1:45678/stable/static/out/workbench.js?folder=%2Fworkspace"
    )


def test_session_gateway_keeps_terminal_prefix_for_ttyd():
    """Terminal sessions keep the ttyd base path when proxying."""
    from executor.modes.local.session_handler import SessionGateway

    gateway = SessionGateway({})
    request = SimpleNamespace(path="/s/terminal-1/ws", query_string="token=secret")
    session = _local_session("terminal-1", "terminal")

    assert (
        gateway._build_upstream_url(request, session, "ws")
        == "ws://127.0.0.1:45678/s/terminal-1/ws"
    )


@pytest.mark.asyncio
async def test_session_gateway_logs_in_to_code_server_with_configured_password(
    monkeypatch,
):
    """Gateway should authenticate to code-server without exposing the password."""
    from executor.modes.local.session_handler import SessionGateway

    class FakeResponse:
        status = 302

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def read(self):
            return b""

    class FakeClient:
        def __init__(self):
            self.posts = []

        def post(self, url, **kwargs):
            self.posts.append((url, kwargs))
            return FakeResponse()

    monkeypatch.setenv("CODE_SERVER_PASSWORD", "configured-secret")
    gateway = SessionGateway({})
    fake_client = FakeClient()
    gateway._client_session = fake_client
    session = _local_session("code-1", "code_server")

    await gateway._ensure_code_server_login(session)
    await gateway._ensure_code_server_login(session)

    assert session.code_server_authenticated is True
    assert len(fake_client.posts) == 1
    url, kwargs = fake_client.posts[0]
    assert url == "http://127.0.0.1:45678/login"
    assert kwargs["data"] == {"password": "configured-secret"}
    assert kwargs["allow_redirects"] is False


@pytest.mark.asyncio
async def test_start_terminal_session_uses_writable_once_ttyd(tmp_path, monkeypatch):
    """Terminal sessions should start a writable ttyd that exits on disconnect."""
    from executor.modes.local.session_handler import LocalSessionHandler

    created = []

    async def fake_create_process(*argv, **kwargs):
        created.append((argv, kwargs))
        return AsyncMock(pid=1234)

    monkeypatch.setattr(
        "executor.modes.local.session_handler.asyncio.create_subprocess_exec",
        fake_create_process,
    )
    handler = LocalSessionHandler(public_base_url="http://localhost:17888")

    result = await handler.handle_start_session(
        {
            "type": "terminal",
            "session_id": "terminal-1",
            "project_id": 123,
            "path": str(tmp_path),
            "access_token": "secret",
        }
    )

    assert result["success"] is True
    assert result["url"] == "http://localhost:17888/s/terminal-1/?token=secret"
    argv = created[0][0]
    assert argv[:2] == ("ttyd", "-i")
    assert "-o" in argv
    assert "-m" in argv
    assert "-R" not in argv
    assert str(tmp_path) in argv


@pytest.mark.asyncio
async def test_start_code_server_session_returns_gateway_url(tmp_path):
    """Code server sessions should go through the authenticated gateway."""
    from executor.modes.local.session_handler import LocalSessionHandler

    handler = LocalSessionHandler(public_base_url="http://localhost:17888")

    result = await handler.handle_start_session(
        {
            "type": "code_server",
            "session_id": "code-1",
            "project_id": 123,
            "path": str(tmp_path),
            "access_token": "secret",
        }
    )

    assert result["success"] is True
    assert result["url"].startswith("http://localhost:17888/s/code-1/?")
    assert "token=secret" in result["url"]
    assert f"folder={quote(str(tmp_path), safe='')}" in result["url"]
    assert handler.sessions["code-1"].session_type == "code_server"
    assert handler.sessions["code-1"].process is None
    assert handler.sessions["code-1"].port == 18080


@pytest.mark.asyncio
async def test_start_session_rejects_missing_project_path(tmp_path):
    """Session startup should fail when the project path does not exist."""
    from executor.modes.local.session_handler import LocalSessionHandler

    handler = LocalSessionHandler(public_base_url="http://localhost:17888")

    result = await handler.handle_start_session(
        {
            "type": "terminal",
            "session_id": "terminal-1",
            "project_id": 123,
            "path": str(tmp_path / "missing"),
            "access_token": "secret",
        }
    )

    assert result["success"] is False
    assert "does not exist" in result["error"]


@pytest.mark.asyncio
async def test_start_session_resolves_relative_default_path(
    tmp_path,
    monkeypatch,
):
    """Relative default project paths should resolve under LOCAL_WORKSPACE_ROOT."""
    from executor.modes.local.session_handler import LocalSessionHandler

    created = []
    monkeypatch.setattr(
        "executor.modes.local.session_handler.config.get_workspace_root",
        lambda: str(tmp_path),
    )

    async def fake_create_process(*argv, **kwargs):
        created.append((argv, kwargs))
        return AsyncMock(pid=1234)

    monkeypatch.setattr(
        "executor.modes.local.session_handler.asyncio.create_subprocess_exec",
        fake_create_process,
    )
    handler = LocalSessionHandler(public_base_url="http://localhost:17888")

    result = await handler.handle_start_session(
        {
            "type": "terminal",
            "session_id": "terminal-17",
            "project_id": 17,
            "path": "project17",
            "create_if_missing": True,
            "access_token": "secret",
        }
    )

    expected_path = str(tmp_path / "project17")
    assert result["success"] is True
    assert (tmp_path / "project17").is_dir()
    assert expected_path in created[0][0]
