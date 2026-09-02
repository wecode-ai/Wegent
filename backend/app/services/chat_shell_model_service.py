# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stateless chat_shell model runtime service."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import partial
from typing import Any, AsyncIterator

import httpx

from app.core.config import settings
from app.core.payload_codec import run_payload_codec

DEFAULT_METADATA: dict[str, Any] = {
    "history_limit": 0,
    "stateless": True,
}
CHAT_SHELL_RESPONSE_MAX_BYTES = 32 * 1024 * 1024
CHAT_SHELL_SSE_EVENT_MAX_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class _PreparedChatShellRequest:
    url: str
    headers: tuple[tuple[str, str], ...]
    body: bytes


def _build_client(timeout: float = 300.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout))


def _encode_chat_shell_request(
    *,
    model: str,
    input_messages: list[dict[str, Any]],
    instructions: str | None,
    model_config: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    tools: list[dict[str, Any]] | None,
    stream: bool,
) -> _PreparedChatShellRequest:
    payload: dict[str, Any] = {
        "model": model,
        "input": input_messages,
        "stream": stream,
        "metadata": _merge_metadata(metadata),
        "model_config": model_config or {},
    }
    if instructions is not None:
        payload["instructions"] = instructions
    if tools:
        payload["tools"] = tools

    token = settings.CHAT_SHELL_TOKEN or "dummy"
    return _PreparedChatShellRequest(
        url=f"{settings.CHAT_SHELL_URL.rstrip('/')}/v1/responses",
        headers=(
            ("Authorization", f"Bearer {token}"),
            ("Content-Type", "application/json"),
            (
                "Accept",
                "text/event-stream" if stream else "application/json",
            ),
        ),
        body=json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )


def _join_response_chunks(chunks: list[bytes]) -> bytes:
    body = b"".join(chunks)
    if len(body) > CHAT_SHELL_RESPONSE_MAX_BYTES:
        raise RuntimeError("Chat Shell response exceeds the configured limit")
    return body


def _decode_response_body(body: bytes, content_type: str) -> Any:
    if "json" in content_type.lower():
        return json.loads(body)
    return body.decode("utf-8")


def _decode_sse_records(
    pending: bytes,
    chunk: bytes,
    final: bool = False,
) -> tuple[bytes, list[dict[str, Any]]]:
    normalized = (pending + chunk).replace(b"\r\n", b"\n")
    records = normalized.split(b"\n\n")
    remainder = b"" if final else records.pop()
    if final and records and not records[-1]:
        records.pop()
    if len(remainder) > CHAT_SHELL_SSE_EVENT_MAX_BYTES:
        raise RuntimeError("Chat Shell SSE event exceeds the configured limit")

    events: list[dict[str, Any]] = []
    for record in records:
        if not record:
            continue
        if len(record) > CHAT_SHELL_SSE_EVENT_MAX_BYTES:
            raise RuntimeError("Chat Shell SSE event exceeds the configured limit")
        data_lines = [
            line[5:].lstrip(b" ")
            for line in record.split(b"\n")
            if line.startswith(b"data:")
        ]
        if not data_lines:
            continue
        data = b"\n".join(data_lines)
        if data.strip() == b"[DONE]":
            continue
        event = json.loads(data)
        if isinstance(event, dict):
            events.append(event)
    return remainder, events


async def _iter_sse_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    pending = b""
    async for chunk in response.aiter_bytes():
        pending, events = await run_payload_codec(
            _decode_sse_records,
            pending,
            chunk,
            False,
            payload_hint=(pending, chunk),
            force_offload=True,
        )
        for event in events:
            yield event

    if pending.strip():
        _, events = await run_payload_codec(
            _decode_sse_records,
            pending,
            b"",
            True,
            payload_hint=pending,
            force_offload=True,
        )
        for event in events:
            yield event


def _merge_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(DEFAULT_METADATA)
    if metadata:
        merged.update(metadata)
    merged["history_limit"] = 0
    merged["stateless"] = True
    return merged


def extract_response_text(response: Any) -> str:
    """Extract plain text from OpenAI Responses API response payload."""
    import logging

    logger = logging.getLogger(__name__)

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
            logger.info(
                f"[extract_response_text] from output_text: {output_text[:100]}"
            )
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
    result = "\n".join(texts).strip()
    logger.info(
        f"[extract_response_text] from output array: {result[:100]}, texts count: {len(texts)}"
    )
    return result


def _extract_text_from_sse_blob(raw: str) -> str:
    """Best-effort parser for SSE payload accidentally returned as plain text."""
    events: list[dict[str, Any]] = []
    # 只使用一种解析方式，避免重复
    parsed = _parse_sse_events_from_data_lines(raw)
    if parsed:
        events.extend(parsed)
    else:
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
    """Call chat_shell /v1/responses in stateless mode (non-streaming).

    For streaming, use :func:`create_streaming_response` instead which
    returns an async context manager that ensures the underlying httpx
    connection is properly closed.
    """
    prepared = await run_payload_codec(
        partial(
            _encode_chat_shell_request,
            model=model,
            input_messages=input_messages,
            instructions=instructions,
            model_config=model_config,
            metadata=metadata,
            tools=tools,
            stream=stream,
        ),
        payload_hint=(input_messages, instructions, model_config, metadata, tools),
        force_offload=True,
    )
    client = await run_payload_codec(
        _build_client,
        payload_hint=prepared.url,
        force_offload=True,
    )
    async with client:
        async with client.stream(
            "POST",
            prepared.url,
            headers=prepared.headers,
            content=prepared.body,
        ) as response:
            response.raise_for_status()
            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > CHAT_SHELL_RESPONSE_MAX_BYTES:
                    raise RuntimeError(
                        "Chat Shell response exceeds the configured limit"
                    )
                chunks.append(chunk)
            body = await run_payload_codec(
                _join_response_chunks,
                chunks,
                payload_hint=chunks,
                force_offload=True,
            )
            return await run_payload_codec(
                _decode_response_body,
                body,
                response.headers.get("content-type", ""),
                payload_hint=body,
                force_offload=True,
            )


@asynccontextmanager
async def create_streaming_response(
    *,
    model: str,
    input_messages: list[dict[str, Any]],
    instructions: str | None = None,
    model_config: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> AsyncIterator[Any]:
    """Call chat_shell /v1/responses in streaming mode.

    Returns an async context manager that ensures the underlying httpx
    connection is properly closed when the caller is done iterating,
    preventing orphan CancelScope corruption in anyio.
    """
    prepared = await run_payload_codec(
        partial(
            _encode_chat_shell_request,
            model=model,
            input_messages=input_messages,
            instructions=instructions,
            model_config=model_config,
            metadata=metadata,
            tools=tools,
            stream=True,
        ),
        payload_hint=(input_messages, instructions, model_config, metadata, tools),
        force_offload=True,
    )
    client = await run_payload_codec(
        _build_client,
        payload_hint=prepared.url,
        force_offload=True,
    )
    async with client:
        async with client.stream(
            "POST",
            prepared.url,
            headers=prepared.headers,
            content=prepared.body,
        ) as response:
            response.raise_for_status()
            yield _iter_sse_events(response)


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
    return await run_payload_codec(
        extract_response_text,
        response,
        payload_hint=response,
        force_offload=True,
    )
