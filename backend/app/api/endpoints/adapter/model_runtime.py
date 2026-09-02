# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter

from app.core import security
from app.core.payload_codec import run_payload_codec
from app.core.request_body_limit import MODEL_RUNTIME_BODY_MAX_BYTES
from app.core.request_json import validate_json_request
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.model_runtime import (
    StatelessModelReference,
    StatelessResponseCreateRequest,
    StatelessResponseCreateResult,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.stream_client import (
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
)
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import (
    MODEL_RUNTIME_EXECUTE,
    MODEL_RUNTIME_STREAM,
)
from app.services.llm_proxy_service import (
    resolve_llm_proxy_model_config_for_user,
)

router = APIRouter()
_STATELESS_RESPONSE_VALIDATOR = TypeAdapter(StatelessResponseCreateRequest)


def _model_runtime_stream_payload(
    request: StatelessResponseCreateRequest,
    model: str,
    model_config: dict[str, Any] | None,
) -> dict[str, Any]:
    payload = request.model_dump(mode="json", by_alias=True)
    payload["model"] = model
    payload["model_config"] = model_config
    payload.pop("model_ref", None)
    payload.pop("stream", None)
    return payload


async def _decode_stateless_response_request(
    request: Request,
) -> StatelessResponseCreateRequest:
    return await validate_json_request(
        request,
        _STATELESS_RESPONSE_VALIDATOR,
        max_bytes=MODEL_RUNTIME_BODY_MAX_BYTES,
    )


def _resolve_model_reference_sync(
    reference: StatelessModelReference,
    user_id: int,
    user_name: str,
) -> dict[str, Any]:
    with SessionLocal() as db:
        return resolve_llm_proxy_model_config_for_user(
            db,
            user_id=user_id,
            user_name=user_name,
            model_name=reference.name,
            model_type=reference.type,
            namespace=reference.namespace,
            resource_user_id=reference.resource_user_id,
        )


@router.post(
    "/responses",
    response_model=StatelessResponseCreateResult,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "$ref": "#/components/schemas/StatelessResponseCreateRequest"
                    }
                }
            },
        }
    },
)
async def create_stateless_response(
    request: StatelessResponseCreateRequest = Depends(
        _decode_stateless_response_request
    ),
    current_user: User = Depends(security.get_current_user),
):
    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user

    model = request.model
    model_config = request.runtime_model_config
    if request.model_ref is not None:
        model_config = await run_sync_in_executor(
            _resolve_model_reference_sync,
            request.model_ref,
            user_id,
            user_name,
        )
        model = str(model_config.get("model_id") or "").strip()
        if not model:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Resolved model configuration has no model_id",
            )

    payload = await run_payload_codec(
        _model_runtime_stream_payload,
        request,
        model,
        model_config,
        payload_hint=request,
        force_offload=True,
    )
    if request.stream:
        return StreamingResponse(
            web_stream_worker_client.stream(MODEL_RUNTIME_STREAM, payload),
            media_type="text/event-stream",
        )

    try:
        result = await web_stream_worker_client.execute(
            MODEL_RUNTIME_EXECUTE,
            payload,
        )
    except StreamWorkerUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model runtime worker is unavailable",
        ) from error
    except StreamWorkerExecutionError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error
    output_text = result.get("output_text")
    if not isinstance(output_text, str):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Model runtime worker returned an invalid result",
        )
    return StatelessResponseCreateResult(
        output_text=output_text,
        model=model,
        created_at=datetime.now(timezone.utc),
    )
