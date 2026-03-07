# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for WebSocket dispatch loop handling."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget


@pytest.mark.asyncio
async def test_dispatch_websocket_schedules_socket_emit_in_main_loop():
    """WebSocket dispatch should schedule Socket.IO emit in the main loop."""
    dispatcher = ExecutionDispatcher()
    request = MagicMock()
    request.task_id = 1
    request.subtask_id = 2
    request.message_id = 3
    request.user = {"id": 9}
    request.to_dict.return_value = {"task_id": 1}

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    emitter = AsyncMock()
    sio = MagicMock()

    with (
        patch(
            "app.core.socketio.get_sio",
            return_value=sio,
        ),
        patch.object(
            dispatcher,
            "_set_subtask_executor",
            AsyncMock(),
        ),
        patch(
            "app.services.execution.dispatcher.run_in_main_loop",
            AsyncMock(return_value=None),
        ) as run_in_main_loop_mock,
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    emitter.emit_start.assert_awaited_once()
    run_in_main_loop_mock.assert_awaited_once()
    sio.emit.assert_not_called()
