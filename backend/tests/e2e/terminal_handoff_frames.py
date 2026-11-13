# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read target chat emits from the shared Socket.IO Redis manager protocol."""

import json
from typing import Any

CONTROL_METHODS = {"callback", "disconnect", "enter_room", "leave_room", "close_room"}


def intermediate_frame(
    frame: object, *, task_id: int, user_id: int
) -> tuple[str, dict[str, Any]] | None:
    """Ignore unrelated manager packets while rejecting malformed target emits."""

    diagnostic = f"Invalid intermediate Socket.IO frame: {frame!r}"
    assert isinstance(frame, dict), diagnostic
    targets = {"task:status": f"user:{user_id}", "chat:done": f"task:{task_id}"}
    event = frame.get("event")
    target = event in targets and frame.get("room") == targets[event]
    if not target:
        assert frame.get("method") in CONTROL_METHODS | {"emit"}, diagnostic
        return None

    assert frame.get("method") == "emit", diagnostic
    assert frame.get("namespace") == "/chat", diagnostic
    data = frame.get("data")
    assert isinstance(data, list) and len(data) == 1, diagnostic
    payload = data[0]
    assert isinstance(payload, dict), diagnostic
    assert type(payload.get("task_id")) is int, diagnostic
    if payload["task_id"] != task_id:
        return None
    if event == "task:status":
        assert isinstance(payload.get("status"), str), diagnostic
    else:
        assert type(payload.get("subtask_id")) is int, diagnostic
    return event, payload


def assert_intermediate_frames(
    case: Any, subscription: Any, task_id: int, subtask_id: int
) -> None:
    statuses: list[str] = []
    stage_done: list[int] = []

    def received() -> bool:
        message = subscription.get_message(timeout=0.1)
        if message and message["type"] == "message":
            frame = json.loads(message["data"])
            parsed = intermediate_frame(frame, task_id=task_id, user_id=case.user_id)
            if parsed is not None:
                event, data = parsed
                if event == "task:status":
                    statuses.append(data["status"])
                else:
                    stage_done.append(data["subtask_id"])
        return bool(stage_done and statuses and statuses[-1] == "RUNNING")

    case._wait_for(received)
    case.assertEqual(statuses, ["PENDING", "RUNNING"])
    case.assertEqual(stage_done, [subtask_id])


def assert_recovered_terminal_frames(
    case: Any,
    subscription: Any,
    task_id: int,
    assistant_id: int,
    marker: str,
    expected_value: str,
) -> None:
    frames: dict[str, list[dict]] = {"done": [], "chat:done": [], "task:status": []}

    def recovered() -> bool:
        message = subscription.get_message(timeout=0.1)
        if message and message["type"] == "message":
            data = json.loads(message["data"])
            if data.get("type") == "done":
                frames["done"].append(data)
            elif data.get("event") in {"chat:done", "task:status"}:
                frame = data["data"][0]
                if frame.get("subtask_id") == assistant_id or (
                    frame.get("task_id") == task_id
                    and frame.get("status") == "COMPLETED"
                ):
                    frames[data["event"]].append(frame)
        return (
            all(frames.values())
            and marker not in case._snapshot(task_id)[0]["metadata"]["labels"]
        )

    case._wait_for(recovered)
    case.assertEqual(
        {name: len(events) for name, events in frames.items()},
        {
            "done": 1,
            "chat:done": 1,
            "task:status": 1,
        },
    )
    case.assertEqual(frames["done"][0]["result"]["value"], expected_value)
    case.assertEqual(len(case._model_requests()), 1)
