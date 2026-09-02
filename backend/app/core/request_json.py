# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bounded JSON and Pydantic request decoding outside the event loop."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from pydantic import TypeAdapter, ValidationError

from app.core.payload_codec import run_payload_codec
from app.core.request_body_limit import release_request_body_admission


def _validate_request_body_sync(
    validator: TypeAdapter[Any],
    body: bytes,
    parse_json: bool,
) -> Any:
    if parse_json:
        return validator.validate_json(body)
    return validator.validate_python(body)


def _body_validation_errors(exc: ValidationError) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    for error in exc.errors():
        prefixed = dict(error)
        prefixed["loc"] = ("body", *error.get("loc", ()))
        errors.append(prefixed)
    return errors


def _request_uses_json(request: Request) -> bool:
    content_type = request.headers.get("content-type")
    if not content_type:
        return True
    media_type = content_type.split(";", 1)[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


async def _read_bounded_request_body(request: Request, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"Request body exceeds {max_bytes} bytes",
            )
        if chunk:
            chunks.append(chunk)
    if not chunks:
        return b""
    if len(chunks) == 1:
        return chunks[0]
    return await run_payload_codec(
        b"".join,
        chunks,
        payload_hint=chunks,
        force_offload=True,
    )


async def validate_json_request(
    request: Request,
    validator: TypeAdapter[Any],
    *,
    max_bytes: int,
) -> Any:
    """Read a bounded body and perform JSON/Pydantic validation in codec workers."""
    try:
        body = await _read_bounded_request_body(request, max_bytes)
        try:
            return await run_payload_codec(
                _validate_request_body_sync,
                validator,
                body,
                _request_uses_json(request),
                payload_hint=body,
                force_offload=True,
            )
        except ValidationError as exc:
            errors = await run_payload_codec(
                _body_validation_errors,
                exc,
                payload_hint=body,
                force_offload=True,
            )
            raise RequestValidationError(errors) from exc
    finally:
        release_request_body_admission(request.scope)
