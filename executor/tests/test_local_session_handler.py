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


def test_session_gateway_does_not_redirect_embedded_code_server_requests():
    """Embedded code-server iframes must keep token auth in the URL."""
    from executor.modes.local.session_handler import SessionGateway

    gateway = SessionGateway({})
    code_session = _local_session("code-1", "code_server")
    request = SimpleNamespace(
        query={"token": "secret"},
        headers={},
    )
    embedded_code_request = SimpleNamespace(
        query={"token": "secret", "embed": "1"},
        headers={},
    )

    assert (
        gateway._should_redirect_authenticated_request(
            embedded_code_request,
            code_session,
        )
        is False
    )
    assert (
        gateway._should_redirect_authenticated_request(
            request,
            code_session,
        )
        is True
    )


def test_session_gateway_rejects_code_server_session_path_without_cookies():
    """Code-server iframe resources require token or cookie authentication."""
    from executor.modes.local.session_handler import SessionGateway

    gateway = SessionGateway({})
    code_session = _local_session("code-1", "code_server")
    code_request = SimpleNamespace(
        path="/s/code-1/",
        query={},
        cookies={},
    )

    assert gateway._is_authorized(code_request, code_session) is False


@pytest.mark.asyncio
async def test_session_gateway_returns_actionable_message_for_missing_session():
    """Missing session pages should tell users how to recover."""
    from executor.modes.local.session_handler import SessionGateway

    gateway = SessionGateway({})
    request = SimpleNamespace(
        path="/s/missing-session/",
        query={},
        query_string="",
        cookies={},
        headers={},
    )

    response = await gateway._handle_request(request)

    assert response.status == 404
    assert b"session is no longer available" in response.body
    assert b"Return to Wegent" in response.body
    assert b"open it again from the workspace tools" in response.body


@pytest.mark.asyncio
async def test_session_gateway_probe_returns_no_content_for_valid_session():
    """Session URL probes should validate a session without proxying upstream."""
    from executor.modes.local.session_handler import SessionGateway

    session = _local_session("code-1", "code_server")
    gateway = SessionGateway({session.session_id: session})
    request = SimpleNamespace(
        path="/s/code-1/",
        query={"token": "secret", "__wegent_probe": "1"},
        query_string="token=secret&__wegent_probe=1",
        cookies={},
        headers={},
    )

    response = await gateway._handle_request(request)

    assert response.status == 204
    assert response.headers["Access-Control-Allow-Origin"] == "*"


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
async def test_start_terminal_session_uses_embedded_pty(tmp_path, monkeypatch):
    """Terminal sessions should start an embedded PTY instead of ttyd."""
    from executor.modes.local import session_handler

    class FakePtyProcess:
        pid = 1234
        returncode = None
        fd = -1

        def __init__(self):
            self.writes = []
            self.resizes = []
            self.closed = False
            self.terminated = False

        def read(self, size=4096):
            return b""

        def write(self, data):
            self.writes.append(data)
            return len(data)

        def resize(self, rows, cols):
            self.resizes.append((rows, cols))

        def poll(self):
            return 0 if self.closed else None

        def terminate(self, force=False):
            self.terminated = True
            self.closed = True

        def wait(self, timeout=None):
            self.closed = True
            return 0

        def close(self):
            self.closed = True

    class FakePtyManager:
        def __init__(self):
            self.spawned = []
            self.process = FakePtyProcess()

        def is_available(self):
            return True

        def spawn(self, cmd, cwd=None, env=None, rows=24, cols=80):
            self.spawned.append(
                {
                    "cmd": cmd,
                    "cwd": cwd,
                    "env": env,
                    "rows": rows,
                    "cols": cols,
                }
            )
            return self.process

        def read_available(self, fd, timeout=0.5):
            return None

    fake_pty_manager = FakePtyManager()
    monkeypatch.setenv("SHELL", "/bin/bash")

    async def fake_create_process(*argv, **kwargs):
        raise AssertionError(f"terminal should not spawn ttyd: {argv}")

    monkeypatch.setattr(
        "executor.modes.local.session_handler.asyncio.create_subprocess_exec",
        fake_create_process,
    )
    monkeypatch.setattr(
        "executor.modes.local.session_handler.get_pty_manager",
        lambda: fake_pty_manager,
    )
    handler = session_handler.LocalSessionHandler(
        public_base_url="http://localhost:17888"
    )

    result = await handler.handle_start_session(
        {
            "type": "terminal",
            "session_id": "terminal-1",
            "project_id": 123,
            "path": str(tmp_path),
            "access_token": "secret",
            "rows": 40,
            "cols": 120,
        }
    )

    assert result["success"] is True
    assert result["url"] == ""
    assert result["transport"] == "socketio"
    assert len(fake_pty_manager.spawned) == 1
    assert fake_pty_manager.spawned[0]["cmd"] == ["/bin/bash"]
    assert fake_pty_manager.spawned[0]["cwd"] == str(tmp_path)
    assert isinstance(fake_pty_manager.spawned[0]["env"], dict)
    assert fake_pty_manager.spawned[0]["rows"] == 40
    assert fake_pty_manager.spawned[0]["cols"] == 120

    await handler.handle_terminal_input({"session_id": "terminal-1", "data": "pwd\r"})
    await handler.handle_terminal_resize(
        {"session_id": "terminal-1", "rows": 30, "cols": 100}
    )
    await handler.handle_terminal_close({"session_id": "terminal-1"})

    assert fake_pty_manager.process.writes == [b"pwd\r"]
    assert fake_pty_manager.process.resizes == [(30, 100)]
    assert fake_pty_manager.process.terminated is True


@pytest.mark.asyncio
async def test_terminal_input_returns_error_when_pty_write_fails():
    """Input handling should survive PTY teardown races."""
    from executor.modes.local.session_handler import LocalSession, LocalSessionHandler

    class FailingTerminal:
        def write(self, data):
            raise OSError("pty closed")

    handler = LocalSessionHandler(public_base_url="http://localhost:17888")
    handler.sessions["terminal-1"] = LocalSession(
        session_id="terminal-1",
        session_type="terminal",
        access_token="secret",
        project_id=123,
        path="/workspace",
        port=0,
        process=None,
        terminal=FailingTerminal(),
        expires_at=9999999999,
    )

    result = await handler.handle_terminal_input(
        {"session_id": "terminal-1", "data": "pwd\r"}
    )

    assert result == {"success": False, "error": "Terminal session is not writable"}


@pytest.mark.asyncio
async def test_terminal_resize_returns_error_when_pty_resize_fails():
    """Resize handling should survive PTY teardown races."""
    from executor.modes.local.session_handler import LocalSession, LocalSessionHandler

    class FailingTerminal:
        def resize(self, rows, cols):
            raise OSError("pty closed")

    handler = LocalSessionHandler(public_base_url="http://localhost:17888")
    handler.sessions["terminal-1"] = LocalSession(
        session_id="terminal-1",
        session_type="terminal",
        access_token="secret",
        project_id=123,
        path="/workspace",
        port=0,
        process=None,
        terminal=FailingTerminal(),
        expires_at=9999999999,
    )

    result = await handler.handle_terminal_resize(
        {"session_id": "terminal-1", "rows": 30, "cols": 100}
    )

    assert result == {"success": False, "error": "Terminal session is not resizable"}


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
async def test_disabled_session_gateway_rejects_code_server_session(
    tmp_path, monkeypatch
):
    """Terminal-only deployments should not return dead code-server gateway URLs."""
    from executor.modes.local.session_handler import LocalSessionHandler

    monkeypatch.setenv("DEVICE_SESSION_GATEWAY_ENABLED", "false")
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

    assert result["success"] is False
    assert "Session gateway is disabled" in result["error"]
    assert "code-1" not in handler.sessions


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

    spawned = []
    monkeypatch.setenv("SHELL", "/bin/bash")
    monkeypatch.setattr(
        "executor.modes.local.session_handler.config.get_workspace_root",
        lambda: str(tmp_path),
    )

    class FakePtyProcess:
        fd = -1

        def read(self, size=4096):
            return b""

        def write(self, data):
            return len(data)

        def resize(self, rows, cols):
            pass

        def poll(self):
            return 0

        def terminate(self, force=False):
            pass

        def wait(self, timeout=None):
            return 0

        def close(self):
            pass

    class FakePtyManager:
        def is_available(self):
            return True

        def spawn(self, cmd, cwd=None, env=None, rows=24, cols=80):
            spawned.append({"cmd": cmd, "cwd": cwd})
            return FakePtyProcess()

    monkeypatch.setattr(
        "executor.modes.local.session_handler.get_pty_manager",
        lambda: FakePtyManager(),
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
    assert spawned == [{"cmd": ["/bin/bash"], "cwd": expected_path}]
