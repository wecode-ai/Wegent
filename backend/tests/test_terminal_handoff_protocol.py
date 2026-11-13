# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit coverage for the gateway scenario's shared-channel observation."""

import json
from collections import deque
from typing import Any

import pytest

from tests.e2e import terminal_handoff_gateway


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
            "data": [{"task_id": 13, "status": "PENDING"}],
        },
        {
            "method": "emit",
            "event": "chat:done",
            "room": "task:13",
            "data": [{"task_id": 13, "subtask_id": 17}],
        },
        {
            "method": "emit",
            "event": "task:status",
            "room": "user:7",
            "data": [{"task_id": 13, "status": "RUNNING"}],
        },
    ]
    subscription = FrameSubscription(frames)
    observer._assert_intermediate_frames(subscription, 13, 17)
    assert not subscription.frames


def test_intermediate_observation_still_rejects_malformed_business_events() -> None:
    observer = terminal_handoff_gateway.TerminalHandoffGateway()
    observer.user_id = 7
    with pytest.raises(KeyError, match="data"):
        observer._assert_intermediate_frames(
            FrameSubscription([{"method": "emit", "event": "task:status"}]), 13, 17
        )
