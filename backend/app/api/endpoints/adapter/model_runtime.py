# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.model_runtime import (
    StatelessResponseCreateRequest,
    StatelessResponseCreateResult,
)
from app.services.llm_proxy_service import resolve_llm_proxy_model_config
from app.services.model_runtime import stateless_runtime_service

router = APIRouter()


@router.post("/responses", response_model=StatelessResponseCreateResult)
async def create_stateless_response(
    request: StatelessResponseCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    model = request.model
    model_config = request.runtime_model_config
    if request.model_ref is not None:
        model_config = resolve_llm_proxy_model_config(
            db,
            current_user,
            model_name=request.model_ref.name,
            model_type=request.model_ref.type,
            namespace=request.model_ref.namespace,
            resource_user_id=request.model_ref.resource_user_id,
        )
        model = str(model_config.get("model_id") or "").strip()
        if not model:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Resolved model configuration has no model_id",
            )

    if request.stream:
        stream = stateless_runtime_service.stream_response(
            model=model,
            input_data=request.input,
            instructions=request.instructions,
            model_config=model_config,
            metadata=request.metadata,
            tools=request.tools,
        )
        return StreamingResponse(stream, media_type="text/event-stream")

    output_text = await stateless_runtime_service.complete_text(
        model=model,
        input_data=request.input,
        instructions=request.instructions,
        model_config=model_config,
        metadata=request.metadata,
        tools=request.tools,
    )
    return StatelessResponseCreateResult(
        output_text=output_text,
        model=model,
        created_at=datetime.now(timezone.utc),
    )
