# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stateless chat_shell model runtime service."""

from __future__ import annotations

import json
from typing import Any

from openai import AsyncOpenAI

from app.core.config import settings

DEFAULT_METADATA: dict[str, Any] = {
    "history_limit": 0,
    "stateless": True,
}


def _build_client(timeout: float = 300.0) -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url=f"{settings.CHAT_SHELL_URL.rstrip('/')}/v1",
        api_key=settings.CHAT_SHELL_TOKEN or "dummy",
        timeout=timeout,
    )


def _merge_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(DEFAULT_METADATA)
    if metadata:
        merged.update(metadata)
    merged["history_limit"] = 0
    merged["stateless"] = True
    return merged


def extract_response_text(response: Any) -> str:
    """Extract plain text from OpenAI Responses API response payload."""
    if response is None:
        return ""

    if isinstance(response, str):
        text = response.strip()
        if not text:
            return ""
        if "event:" in text and "response.output_text.delta" in text:
            parsed = _extract_text_from_sse_blob(text)
            if parsed:
                return parsed
        return text

    if hasattr(response, "output_text"):
        output_text = getattr(response, "output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()

    if hasattr(response, "model_dump"):
        response_data = response.model_dump()
    elif isinstance(response, dict):
        response_data = response
    else:
        return ""

    texts: list[str] = []
    for output_item in response_data.get("output", []):
        if not isinstance(output_item, dict):
            continue
        for content_block in output_item.get("content", []):
            if not isinstance(content_block, dict):
                continue
            text = content_block.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
    return "\n".join(texts).strip()


def _extract_text_from_sse_blob(raw: str) -> str:
    """Best-effort parser for SSE payload accidentally returned as plain text."""
    events: list[dict[str, Any]] = []
    events.extend(_parse_sse_events_from_data_lines(raw))
    events.extend(_parse_sse_events_from_blob(raw))

    deltas: list[str] = []
    completed_text: str = ""
    for event in events:
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str):
                deltas.append(delta)
        elif event_type == "response.completed":
            response = event.get("response")
            if isinstance(response, dict):
                for output_item in response.get("output", []):
                    if not isinstance(output_item, dict):
                        continue
                    for content_block in output_item.get("content", []):
                        if not isinstance(content_block, dict):
                            continue
                        text = content_block.get("text")
                        if isinstance(text, str) and text.strip():
                            completed_text = text.strip()
    if deltas:
        return "".join(deltas).strip()
    return completed_text


def _parse_sse_events_from_data_lines(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line.removeprefix("data:").strip()
        if not payload:
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _parse_sse_events_from_blob(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    marker = "data:"
    decoder = json.JSONDecoder()
    index = 0
    raw_len = len(raw)

    while index < raw_len:
        data_pos = raw.find(marker, index)
        if data_pos < 0:
            break
        payload_start = data_pos + len(marker)
        while payload_start < raw_len and raw[payload_start].isspace():
            payload_start += 1
        if payload_start >= raw_len or raw[payload_start] != "{":
            index = payload_start
            continue
        try:
            parsed, end_offset = decoder.raw_decode(raw[payload_start:])
        except json.JSONDecodeError:
            index = payload_start + 1
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
        index = payload_start + end_offset

    return events


async def create_response(
    *,
    model: str,
    input_messages: list[dict[str, Any]],
    instructions: str | None = None,
    model_config: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    stream: bool = False,
) -> Any:
    """Call chat_shell /v1/responses in stateless mode."""
    client = _build_client()
    return await client.responses.create(
        model=model,
        input=input_messages,
        instructions=instructions,
        tools=tools if tools else None,
        stream=stream,
        extra_body={
            "metadata": _merge_metadata(metadata),
            "model_config": model_config or {},
        },
    )


async def complete_text(
    *,
    model: str,
    input_messages: list[dict[str, Any]],
    instructions: str | None = None,
    model_config: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> str:
    """Execute a non-streaming stateless call and return extracted text."""
    response = await create_response(
        model=model,
        input_messages=input_messages,
        instructions=instructions,
        model_config=model_config,
        metadata=metadata,
        tools=tools,
        stream=False,
    )
    return extract_response_text(response)
