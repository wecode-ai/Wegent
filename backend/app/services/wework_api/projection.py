# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project native runtime events into the public Responses text/item protocol."""

from copy import deepcopy
from typing import Any

from pydantic import TypeAdapter, ValidationError

from app.schemas.openapi_response import ResponseOutputItem
from app.services.project_chat.service import project_chat_service

TERMINAL = {"completed", "failed", "cancelled", "incomplete"}
OUTPUT_ADAPTER = TypeAdapter(ResponseOutputItem)


def _message(
    snapshot: dict, item_id: str | None, events: list[dict]
) -> tuple[int, dict]:
    # Native transcript and live events use different item IDs. Expose one
    # stable assistant text item per response across snapshots and live output.
    item_id = f"msg_{snapshot['id']}"
    for index, item in enumerate(snapshot["output"]):
        if item["id"] == item_id and item["type"] == "message":
            return index, item
    item = {
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": "in_progress",
        "content": [{"type": "output_text", "text": "", "annotations": []}],
    }
    index = len(snapshot["output"])
    snapshot["output"].append(item)
    events.extend(
        [
            {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {**item, "content": []},
            },
            {
                "type": "response.content_part.added",
                "item_id": item_id,
                "output_index": index,
                "content_index": 0,
                "part": deepcopy(item["content"][0]),
            },
        ]
    )
    return index, item


def _finish_messages(snapshot: dict, events: list[dict]) -> None:
    for index, item in enumerate(snapshot["output"]):
        if item["type"] != "message" or item["status"] != "in_progress":
            continue
        item["status"] = (
            "completed" if snapshot["status"] == "completed" else "incomplete"
        )
        for content_index, part in enumerate(item["content"]):
            if part["type"] != "output_text":
                continue
            base = {
                "item_id": item["id"],
                "output_index": index,
                "content_index": content_index,
            }
            events.extend(
                [
                    {"type": "response.output_text.done", **base, "text": part["text"]},
                    {
                        "type": "response.content_part.done",
                        **base,
                        "part": deepcopy(part),
                    },
                ]
            )
        events.append(
            {
                "type": "response.output_item.done",
                "output_index": index,
                "item": deepcopy(item),
            }
        )


def terminal(snapshot: dict, status: str, error: dict | None = None) -> list[dict]:
    snapshot["status"] = status
    snapshot["error"] = error
    events: list[dict] = []
    _finish_messages(snapshot, events)
    # Responses uses incomplete for an interrupted stream; status retains cancelled.
    event_status = "incomplete" if status == "cancelled" else status
    events.append({"type": f"response.{event_status}", "response": deepcopy(snapshot)})
    return events


def project(snapshot: dict, name: str, data: dict[str, Any]) -> list[dict]:
    events: list[dict] = []
    if snapshot["status"] in TERMINAL:
        return events
    native_terminal = project_chat_service._project_chat_terminal_status(name, {}, data)
    if native_terminal and (
        name != "response.incomplete" or native_terminal == "cancelled"
    ):
        name = {
            "completed": "response.completed",
            "failed": "response.failed",
            "cancelled": "response.incomplete",
        }[native_terminal]
    elif name not in {
        "response.created",
        "response.in_progress",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_item.added",
        "response.output_item.done",
        "response.incomplete",
    }:
        return events
    if snapshot["status"] == "queued":
        snapshot["status"] = "in_progress"
        events.append({"type": "response.in_progress", "response": deepcopy(snapshot)})
    if name == "response.output_text.delta":
        index, item = _message(
            snapshot, data.get("item_id") or data.get("itemId"), events
        )
        delta = data.get("delta", "")
        if isinstance(delta, str) and delta:
            item["content"][0]["text"] += delta
            events.append(
                {
                    "type": name,
                    "item_id": item["id"],
                    "output_index": index,
                    "content_index": 0,
                    "delta": delta,
                }
            )
    elif name == "response.output_text.done":
        text = data.get("text") or data.get("value") or data.get("output_text")
        if isinstance(text, str):
            _, item = _message(
                snapshot, data.get("item_id") or data.get("itemId"), events
            )
            item["content"][0]["text"] = text
    elif name in {"response.output_item.added", "response.output_item.done"}:
        _project_output_item(snapshot, name, data, events)
    elif name in {
        "response.completed",
        "response.failed",
        "response.incomplete",
        "error",
    }:
        final = data.get("response") or {}
        value = data.get("value")
        if isinstance(value, str):
            _, item = _message(snapshot, None, events)
            item["content"][0]["text"] = value
        if not snapshot["output"] and isinstance(final.get("output"), list):
            for item in final["output"]:
                _project_output_item(
                    snapshot, "response.output_item.done", {"item": item}, events
                )
        status = {
            "response.completed": "completed",
            "response.incomplete": "incomplete",
        }.get(name, "failed")
        if name == "response.incomplete" and (
            native_terminal == "cancelled"
            or snapshot.get("cancellation_requested")
            or str(data.get("status") or final.get("status") or "").lower()
            in {"cancelled", "canceled"}
        ):
            status = "cancelled"
        error = data.get("error") or final.get("error")
        if error:
            error = (
                {
                    "code": str(error.get("code") or "runtime_error"),
                    "message": str(error.get("message") or "Runtime execution failed"),
                }
                if isinstance(error, dict)
                else {"code": "runtime_error", "message": str(error)}
            )
        events.extend(terminal(snapshot, status, error))
    return events


def _project_output_item(
    snapshot: dict, name: str, data: dict, events: list[dict]
) -> None:
    try:
        item = OUTPUT_ADAPTER.validate_python(data.get("item")).model_dump(
            exclude_none=True
        )
    except ValidationError:
        return
    # Text item lifecycles are generated from deltas to guarantee valid indices.
    if item["type"] == "message":
        if name.endswith(".done"):
            index, current = _message(snapshot, item["id"], events)
            current["content"] = item["content"]
        return
    index = next(
        (
            i
            for i, existing in enumerate(snapshot["output"])
            if existing["id"] == item["id"]
        ),
        len(snapshot["output"]),
    )
    if index == len(snapshot["output"]):
        snapshot["output"].append(item)
        if name.endswith(".done"):
            events.append(
                {
                    "type": "response.output_item.added",
                    "output_index": index,
                    "item": deepcopy(item),
                }
            )
    else:
        snapshot["output"][index] = item
    events.append({"type": name, "output_index": index, "item": deepcopy(item)})
