# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor.modes.local.websocket_client import (
    WebSocketClient,
    build_runtime_auth_file_report,
    redact_registration_response,
)


def test_build_runtime_auth_file_report_reports_codex_auth_presence(tmp_path):
    report = build_runtime_auth_file_report(home=tmp_path)

    assert report == {
        "codex": {
            "target_path": "~/.codex/auth.json",
            "exists": False,
        }
    }

    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    (codex_dir / "auth.json").write_text('{"token":"secret"}', encoding="utf-8")

    assert build_runtime_auth_file_report(home=tmp_path)["codex"]["exists"] is True


def test_redact_registration_response_hides_direct_chat_secret():
    assert redact_registration_response(
        {
            "success": True,
            "direct_chat_secret": "secret-token",
            "direct_chat_allowed_origins": ["http://127.0.0.1:1420"],
        }
    ) == {
        "success": True,
        "direct_chat_secret": "***",
        "direct_chat_allowed_origins": ["http://127.0.0.1:1420"],
    }


@pytest.mark.asyncio
async def test_register_device_rejects_missing_direct_secret_without_stale_state(
    monkeypatch,
):
    class FakeSocketClient:
        async def call(self, *args, **kwargs):
            return {
                "success": True,
                "direct_chat_allowed_origins": ["http://127.0.0.1:1420"],
            }

    monkeypatch.setattr(WebSocketClient, "_generate_device_id", lambda self: "dev-1")
    monkeypatch.setattr(WebSocketClient, "_get_device_name", lambda self: "device")
    monkeypatch.setattr(WebSocketClient, "_get_client_ip", lambda self: "127.0.0.1")

    client = WebSocketClient(backend_url="http://backend", auth_token="token")
    client.sio = FakeSocketClient()
    client._connected = True
    client.direct_chat_endpoint = {"url": "http://127.0.0.1:17888"}
    client.direct_chat_secret = "old-secret"
    client.direct_chat_allowed_origins = ["http://old-origin"]

    result = await client.register_device()

    assert result.success is False
    assert result.error == "Direct chat secret missing from registration response"
    assert client.direct_chat_secret is None
    assert client.direct_chat_allowed_origins == []
