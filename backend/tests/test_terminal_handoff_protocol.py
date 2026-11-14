# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit coverage for the gateway scenario's shared-channel observation."""

import json
from collections import deque
from typing import Any

import pytest

from tests.e2e import terminal_handoff_gateway
from tests.e2e.terminal_handoff_frames import assert_intermediate_frames


class FrameSubscription:
    def __init__(self, frames: list[dict[str, Any]]) -> None:
        self.frames = deque(frames)

    def get_message(self, *, timeout: float) -> dict[str, str]:
        return {"type": "message", "data": json.dumps(self.frames.popleft())}


def test_intermediate_observation_ignores_ack_control_frames() -> None:
    observer = terminal_handoff_gateway.TerminalHandoffGateway()
    observer.user_id = 7
    frames = [
        {"method": "callback", "sid": "ack-probe", "id": 1, "args": []},
        {
            "method": "emit",
            "event": "task:status",
            "room": "user:7",
            "namespace": "/chat",
            "data": [{"task_id": 13, "status": "PENDING"}],
        },
        {
            "method": "emit",
            "event": "chat:done",
            "room": "task:13",
            "namespace": "/chat",
            "data": [{"task_id": 13, "subtask_id": 17}],
        },
        {
            "method": "emit",
            "event": "task:status",
            "room": "user:7",
            "namespace": "/chat",
            "data": [{"task_id": 13, "status": "RUNNING"}],
        },
    ]
    subscription = FrameSubscription(frames)
    assert_intermediate_frames(observer, subscription, 13, 17)
    assert not subscription.frames


def test_intermediate_observation_still_rejects_malformed_business_events() -> None:
    observer = terminal_handoff_gateway.TerminalHandoffGateway()
    observer.user_id = 7
    frame = {
        "method": "emit",
        "event": "task:status",
        "room": "user:7",
        "namespace": "/chat",
    }
    with pytest.raises(
        AssertionError, match="Invalid intermediate Socket.IO frame"
    ) as error:
        assert_intermediate_frames(observer, FrameSubscription([frame]), 13, 17)
    assert repr(frame) in str(error.value)
