# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.core import security
from app.models.user import User
from app.schemas.model_runtime import (
    StatelessResponseCreateRequest,
    StatelessResponseCreateResult,
)
from app.services.model_runtime import stateless_runtime_service

router = APIRouter()


@router.post("/responses", response_model=StatelessResponseCreateResult)
async def create_stateless_response(
    request: StatelessResponseCreateRequest,
    current_user: User = Depends(security.get_current_user),
):
    del current_user

    if request.stream:
        stream = stateless_runtime_service.stream_response(
            model=request.model,
            input_data=request.input,
            instructions=request.instructions,
            model_config=request.runtime_model_config,
            metadata=request.metadata,
            tools=request.tools,
        )
        return StreamingResponse(stream, media_type="text/event-stream")

    output_text = await stateless_runtime_service.complete_text(
        model=request.model,
        input_data=request.input,
        instructions=request.instructions,
        model_config=request.runtime_model_config,
        metadata=request.metadata,
        tools=request.tools,
    )
    return StatelessResponseCreateResult(
        output_text=output_text,
        model=request.model,
        created_at=datetime.now(timezone.utc),
    )
