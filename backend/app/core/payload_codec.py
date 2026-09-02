# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bound CPU-heavy payload projection and codec work outside async loops."""

from __future__ import annotations

import json
from functools import partial
from typing import Any, Callable, Protocol, TypeVar

from aiohttp import ContentTypeError, hdrs

from app.core.bounded_executor import BoundedExecutor

T = TypeVar("T")


class SyncJSONResponse(Protocol):
    """Response whose buffered JSON decoder is synchronous."""

    @property
    def content(self) -> bytes: ...

    def json(self) -> Any: ...


class AsyncJSONResponse(Protocol):
    """Response whose body is read asynchronously before CPU decoding."""

    async def read(self) -> bytes: ...

    def get_encoding(self) -> str: ...


class SyncTextResponse(Protocol):
    """Response whose buffered text decoder is synchronous."""

    @property
    def content(self) -> bytes: ...

    @property
    def text(self) -> str: ...


class AsyncTextResponse(Protocol):
    """Response whose body is read asynchronously before text decoding."""

    async def read(self) -> bytes: ...

    def get_encoding(self) -> str: ...


PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES = 64 * 1024
_PAYLOAD_CODEC_MAX_WORKERS = 2
_PAYLOAD_CODEC_MAX_IN_FLIGHT = 8

_payload_codec_executor = BoundedExecutor(
    max_workers=_PAYLOAD_CODEC_MAX_WORKERS,
    max_in_flight=_PAYLOAD_CODEC_MAX_IN_FLIGHT,
    thread_name_prefix="wegent-payload-codec",
)


def payload_requires_codec_offload(payload: Any) -> bool:
    """Return whether inspecting or encoding a payload can exceed loop budget.

    The walk itself is bounded by the offload threshold. Large strings and
    bytes are detected in O(1), while deeply nested or wide containers stop as
    soon as their bounded node/size budget is exhausted.
    """
    remaining = PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES
    pending = [payload]
    visited_containers: set[int] = set()

    while pending:
        value = pending.pop()
        value_type = type(value)
        remaining -= 1
        if remaining <= 0:
            return True

        if value_type in (str, bytes, bytearray):
            remaining -= len(value)
        elif value_type is dict:
            identity = id(value)
            if identity in visited_containers:
                return True
            visited_containers.add(identity)
            if len(value) * 2 >= remaining:
                return True
            pending.extend(value.keys())
            pending.extend(value.values())
        elif value_type in (list, tuple):
            identity = id(value)
            if identity in visited_containers:
                return True
            visited_containers.add(identity)
            if len(value) >= remaining:
                return True
            pending.extend(value)
        elif value is None or value_type in (bool, int, float):
            remaining -= 8
        else:
            # Custom codec hooks can perform arbitrary synchronous work.
            return True

        if remaining <= 0:
            return True

    return False


async def run_payload_codec(
    func: Callable[..., T],
    *args: Any,
    payload_hint: Any,
    force_offload: bool = False,
) -> T:
    """Run a codec inline only when its payload has a strict bounded cost."""
    if force_offload or payload_requires_codec_offload(payload_hint):
        return await _payload_codec_executor.run(func, *args)
    return func(*args)


def _encode_http_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


async def encode_http_json(payload: Any) -> bytes:
    """Encode an HTTP JSON request with bounded event-loop work."""
    return await run_payload_codec(
        _encode_http_json_bytes,
        payload,
        payload_hint=payload,
    )


async def dump_model(model: Any, **kwargs: Any) -> dict[str, Any]:
    """Project a Pydantic model outside the serving event loop."""
    return await run_payload_codec(
        partial(model.model_dump, **kwargs),
        payload_hint=model,
        force_offload=True,
    )


def _dump_models(models: list[Any] | tuple[Any, ...], kwargs: dict[str, Any]) -> list:
    return [model.model_dump(**kwargs) for model in models]


async def dump_models(
    models: list[Any] | tuple[Any, ...],
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """Project a model collection in one bounded worker admission."""
    return await run_payload_codec(
        _dump_models,
        models,
        kwargs,
        payload_hint=models,
        force_offload=True,
    )


def _project_model(
    model_type: Any,
    payload: Any,
    dump_kwargs: dict[str, Any],
) -> dict[str, Any]:
    return model_type.model_validate(payload).model_dump(**dump_kwargs)


async def project_model(
    model_type: Any,
    payload: Any,
    **dump_kwargs: Any,
) -> dict[str, Any]:
    """Validate and project a model in one bounded worker admission."""
    return await run_payload_codec(
        _project_model,
        model_type,
        payload,
        dump_kwargs,
        payload_hint=payload,
        force_offload=True,
    )


async def dump_model_json(model: Any, **kwargs: Any) -> str:
    """Serialize a Pydantic model outside the serving event loop."""
    return await run_payload_codec(
        partial(model.model_dump_json, **kwargs),
        payload_hint=model,
        force_offload=True,
    )


async def validate_model(
    model_type: Any,
    payload: Any,
    **kwargs: Any,
) -> Any:
    """Validate an untrusted model payload outside the serving event loop."""
    return await run_payload_codec(
        partial(model_type.model_validate, payload, **kwargs),
        payload_hint=payload,
        force_offload=True,
    )


async def decode_sync_response_json(response: SyncJSONResponse) -> Any:
    """Decode a buffered HTTP response without using the serving event loop."""
    return await run_payload_codec(
        response.json,
        payload_hint=response.content,
        force_offload=True,
    )


def _read_sync_response_text(response: SyncTextResponse) -> str:
    return response.text


async def decode_sync_response_text(response: SyncTextResponse) -> str:
    """Decode a buffered HTTP response as text outside the serving loop."""
    body = response.content
    if not body:
        return ""
    return await run_payload_codec(
        _read_sync_response_text,
        response,
        payload_hint=body,
        force_offload=True,
    )


def _decode_json_bytes(body: bytes, encoding: str) -> Any:
    return json.loads(body.decode(encoding))


def _is_json_content_type(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


async def decode_async_response_json(response: AsyncJSONResponse) -> Any:
    """Read an async response, then decode its body in the codec executor."""
    body = await response.read()
    headers = getattr(response, "headers", None)
    if headers is not None:
        content_type = headers.get(hdrs.CONTENT_TYPE, "").lower()
        if not _is_json_content_type(content_type):
            raise ContentTypeError(
                response.request_info,
                response.history,
                status=response.status,
                message=(
                    "Attempt to decode JSON with unexpected mimetype: "
                    f"{content_type}"
                ),
                headers=headers,
            )

    body = body.strip()
    if not body:
        return None
    encoding = response.get_encoding()
    return await run_payload_codec(
        _decode_json_bytes,
        body,
        encoding,
        payload_hint=body,
        force_offload=True,
    )


def _decode_async_response_text_bytes(
    response: AsyncTextResponse,
    body: bytes,
) -> str:
    return body.decode(response.get_encoding())


async def decode_async_response_text(response: AsyncTextResponse) -> str:
    """Read and decode an async response as text outside the serving loop."""
    body = await response.read()
    return await run_payload_codec(
        _decode_async_response_text_bytes,
        response,
        body,
        payload_hint=body,
        force_offload=True,
    )
