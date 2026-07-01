# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.core.config import settings
from app.services.execution.router import CommunicationMode, ExecutionRouter
from shared.models import ExecutionRequest


def test_standalone_executor_shell_routes_to_rust_local_executor(monkeypatch):
    monkeypatch.setattr(
        settings,
        "STANDALONE_EXECUTOR_DEVICE_ID",
        "standalone-admin-device",
        raising=False,
    )
    router = ExecutionRouter()
    router.standalone_mode = True
    router.standalone_executor_enabled = True

    target = router.route(
        ExecutionRequest(
            user={"id": 1},
            bot=[{"shell_type": "ClaudeCode"}],
        )
    )

    assert target.mode == CommunicationMode.WEBSOCKET
    assert target.namespace == "/local-executor"
    assert target.event == "task:execute"
    assert target.room == "device:1:standalone-admin-device"


def test_standalone_chat_package_mode_still_uses_chat_shell_inprocess():
    router = ExecutionRouter()
    router.standalone_mode = True
    router.standalone_executor_enabled = True
    router.chat_shell_mode = "package"

    target = router.route(
        ExecutionRequest(
            user={"id": 1},
            bot=[{"shell_type": "Chat"}],
        )
    )

    assert target.mode == CommunicationMode.INPROCESS
