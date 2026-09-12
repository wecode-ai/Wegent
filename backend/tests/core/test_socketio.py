# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Socket.IO server configuration."""

from app.core import socketio as socketio_config
from app.core.config import settings
from app.core.socketio import _safe_redis_endpoint
from app.core.terminal_socketio_manager import TerminalDiagnosticAsyncRedisManager


def test_socketio_server_uses_terminal_diagnostic_manager(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://localhost:6379/0")

    server = socketio_config.create_socketio_server()

    assert isinstance(server.manager, TerminalDiagnosticAsyncRedisManager)


def test_safe_redis_endpoint_removes_credentials_and_query():
    endpoint = _safe_redis_endpoint(
        "rediss://user:secret@redis.internal:6381/4?ssl_cert_reqs=required"
    )

    assert endpoint == "rediss://redis.internal:6381/4"
    assert "user" not in endpoint
    assert "secret" not in endpoint
    assert "ssl_cert_reqs" not in endpoint


def test_safe_redis_endpoint_does_not_echo_malformed_url():
    assert _safe_redis_endpoint("redis://user:secret@host:not-a-port/0") == (
        "unparseable"
    )


def test_safe_redis_endpoint_does_not_echo_non_database_path():
    endpoint = _safe_redis_endpoint("redis://host/secret-path")

    assert endpoint == "redis://host:6379/unknown"
    assert "secret-path" not in endpoint
