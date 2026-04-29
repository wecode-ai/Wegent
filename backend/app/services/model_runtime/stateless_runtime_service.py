# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from app.services import chat_shell_model_service


def normalize_input_messages(input_data: str | list[Any]) -> list[dict[str, Any]]:
    if isinstance(input_data, str):
        return [{"role": "user", "content": input_data}]

    normalized_messages: list[dict[str, Any]] = []
    for message in input_data:
        if hasattr(message, "model_dump"):
            normalized_messages.append(message.model_dump())
        elif isinstance(message, dict):
            normalized_messages.append(message)
        else:
            normalized_messages.append(
                {
                    "role": getattr(message, "role", "user"),
                    "content": getattr(message, "content", ""),
                }
            )
    return normalized_messages


def serialize_stream_event(event: Any) -> str:
    if hasattr(event, "model_dump"):
        payload: dict[str, Any] = event.model_dump()
    elif isinstance(event, dict):
        payload = event
    else:
        payload = {"type": getattr(event, "type", "unknown")}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def complete_text(
    *,
    model: str,
    input_data: str | list[Any],
    instructions: str | None = None,
    model_config: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> str:
    return await chat_shell_model_service.complete_text(
        model=model,
        input_messages=normalize_input_messages(input_data),
        instructions=instructions,
        model_config=model_config,
        metadata=metadata,
        tools=tools,
    )


async def stream_response(
    *,
    model: str,
    input_data: str | list[Any],
    instructions: str | None = None,
    model_config: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> AsyncIterator[str]:
    async with chat_shell_model_service.create_streaming_response(
        model=model,
        input_messages=normalize_input_messages(input_data),
        instructions=instructions,
        model_config=model_config,
        metadata=metadata,
        tools=tools,
    ) as stream:
        async for event in stream:
            yield serialize_stream_event(event)
