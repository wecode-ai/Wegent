# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The terminal checkpoint consumes emits, not every Redis manager packet."""

import json
from copy import deepcopy
from typing import Any

import pytest
from socketio.async_pubsub_manager import AsyncPubSubManager

from tests.e2e.terminal_handoff_frames import intermediate_frame

# Match backend-rs/crates/socket-events/src/socketio_emit.rs::emit_message.
RUST_STATUS = json.loads(
    '{"method":"emit","event":"task:status","data":[{"task_id":42,'
    '"status":"RUNNING"}],"binary":false,"namespace":"/chat",'
    '"room":"user:7","skip_sid":null,"callback":null,'
    '"host_id":"0123456789abcdef0123456789abcdef"}'
)


class CapturingManager(AsyncPubSubManager):
    def __init__(self) -> None:
        super().__init__()
        self.frames: list[dict[str, Any]] = []

    async def _publish(self, data: dict[str, Any]) -> None:
        self.frames.append(data)


@pytest.mark.asyncio
async def test_real_python_socketio_emits_keep_the_expected_stage_order() -> None:
    manager = CapturingManager()
    for status in ("PENDING", "RUNNING"):
        await manager.emit(
            "task:status", {"task_id": 42, "status": status}, "/chat", room="user:7"
        )
    await manager.emit(
        "chat:done", {"task_id": 42, "subtask_id": 81}, "/chat", room="task:42"
    )

    parsed = [
        intermediate_frame(frame, task_id=42, user_id=7) for frame in manager.frames
    ]

    assert parsed == [
        ("task:status", {"task_id": 42, "status": "PENDING"}),
        ("task:status", {"task_id": 42, "status": "RUNNING"}),
        ("chat:done", {"task_id": 42, "subtask_id": 81}),
    ]
    assert intermediate_frame(RUST_STATUS, task_id=42, user_id=7) == parsed[1]


@pytest.mark.asyncio
async def test_real_python_manager_controls_have_no_emit_data_and_are_unrelated() -> (
    None
):
    manager = CapturingManager()
    await manager.enter_room("remote", "/chat", "task:42")
    await manager.leave_room("remote", "/chat", "task:42")
    await manager.close_room("task:42", "/chat")
    await manager.can_disconnect("remote", "/chat")
    await manager._return_callback("remote-host", "remote", "/chat", 3, {"ok": True})

    assert {frame["method"] for frame in manager.frames} == {
        "enter_room",
        "leave_room",
        "close_room",
        "disconnect",
        "callback",
    }
    for frame in manager.frames:
        assert "data" not in frame
        assert intermediate_frame(frame, task_id=42, user_id=7) is None


@pytest.mark.parametrize(
    "changes",
    [
        {"data": [{"task_id": 43, "status": "RUNNING"}]},
        {"room": "user:8"},
        {"event": "chat:chunk"},
    ],
)
def test_emits_for_other_tasks_rooms_and_events_are_not_stage_evidence(changes) -> None:
    assert intermediate_frame({**RUST_STATUS, **changes}, task_id=42, user_id=7) is None


@pytest.mark.parametrize(
    "changes,removed",
    [
        ({}, "data"),
        ({}, "method"),
        ({"method": "callback"}, None),
        ({"namespace": "/other"}, None),
        ({"data": None}, None),
        ({"data": {}}, None),
        ({"data": []}, None),
        ({"data": [{}, {}]}, None),
        ({"data": ["not an object"]}, None),
        ({"data": [{"status": "RUNNING"}]}, None),
        ({"data": [{"task_id": "42", "status": "RUNNING"}]}, None),
        ({"data": [{"task_id": 42}]}, None),
        ({"data": [{"task_id": 42, "status": 1}]}, None),
        (
            {"event": "chat:done", "room": "task:42", "data": [{"task_id": 42}]},
            None,
        ),
        (
            {
                "event": "chat:done",
                "room": "task:42",
                "data": [{"task_id": 42, "subtask_id": True}],
            },
            None,
        ),
    ],
)
def test_malformed_target_emit_fails_with_its_full_frame(changes, removed) -> None:
    frame = {**deepcopy(RUST_STATUS), **changes}
    if removed is not None:
        del frame[removed]

    with pytest.raises(
        AssertionError, match="Invalid intermediate Socket.IO frame"
    ) as error:
        intermediate_frame(frame, task_id=42, user_id=7)

    assert repr(frame) in str(error.value)
