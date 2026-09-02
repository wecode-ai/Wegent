# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded HTTP transport for worker-owned execution-event projection."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError

from app.core.payload_codec import run_payload_codec
from app.core.request_body_limit import (
    CALLBACK_BATCH_BODY_MAX_BYTES,
    CALLBACK_EVENT_BODY_MAX_BYTES,
    get_buffered_request_body,
    release_request_body_admission,
)
from app.services.execution.point_projection import (
    CallbackBatch,
    CallbackRequest,
    CallbackResponse,
)
from app.services.execution.stream_client import (
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
    stream_execution_client,
)

router = APIRouter(prefix="/callback", tags=["execution-callback"])
_CALLBACK_REQUEST_OPENAPI_SCHEMA = CallbackRequest.model_json_schema()


async def _read_callback_body(request: Request, *, max_bytes: int) -> bytes:
    """Take the middleware-bounded body and release its lease exactly once."""
    try:
        buffered = get_buffered_request_body(request.scope)
        if buffered is not None:
            if len(buffered) > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Request body exceeds {max_bytes} bytes",
                )
            return buffered

        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(
                    status_code=413,
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
    finally:
        release_request_body_admission(request.scope)


def _validation_errors(
    details: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    for detail in details:
        error = dict(detail)
        error["loc"] = ("body", *detail.get("loc", ()))
        errors.append(error)
    return errors


async def _dispatch_callback_body(body: bytes, *, batch: bool) -> CallbackResponse:
    try:
        result = await stream_execution_client.dispatch_callback_body(
            body,
            batch=batch,
        )
    except StreamWorkerUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail=str(error),
            headers={"Retry-After": "1"},
        ) from error
    except StreamWorkerExecutionError as error:
        if error.error_code == "point_projection_validation" and error.details:
            raise RequestValidationError(_validation_errors(error.details)) from error
        if error.error_code == "point_projection_frame_too_large":
            raise HTTPException(status_code=413, detail=str(error)) from error
        if error.error_code in {
            "point_projection_overloaded",
            "point_projection_session_overloaded",
        }:
            raise HTTPException(
                status_code=503,
                detail=str(error),
                headers={"Retry-After": "1"},
            ) from error
        raise HTTPException(status_code=500, detail=str(error)) from error
    return await run_payload_codec(
        CallbackResponse.model_validate,
        result,
        payload_hint=result,
        force_offload=True,
    )


@router.post(
    "",
    response_model=CallbackResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": _CALLBACK_REQUEST_OPENAPI_SCHEMA,
                }
            },
        }
    },
)
async def handle_callback(request: Request) -> CallbackResponse:
    """Forward one raw bounded callback frame to the Stream worker."""
    body = await _read_callback_body(
        request,
        max_bytes=CALLBACK_EVENT_BODY_MAX_BYTES,
    )
    return await _dispatch_callback_body(body, batch=False)


@router.post(
    "/batch",
    response_model=CallbackResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "items": _CALLBACK_REQUEST_OPENAPI_SCHEMA,
                    }
                }
            },
        }
    },
)
async def handle_batch_callback(request: Request) -> CallbackResponse:
    """Forward one raw bounded callback batch to the Stream worker."""
    body = await _read_callback_body(
        request,
        max_bytes=CALLBACK_BATCH_BODY_MAX_BYTES,
    )
    return await _dispatch_callback_body(body, batch=True)


__all__ = [
    "CallbackBatch",
    "CallbackRequest",
    "CallbackResponse",
    "handle_batch_callback",
    "handle_callback",
    "router",
]
