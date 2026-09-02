# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Deep Research API endpoints.

Delegates Gemini Interaction API lifecycles to the local Stream worker.
"""

import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, TypeAdapter

from app.core import security
from app.core.payload_codec import dump_model, run_payload_codec
from app.core.rate_limit import get_limiter, nonblocking_limit
from app.core.request_body_limit import DEEP_RESEARCH_BODY_MAX_BYTES
from app.core.request_json import validate_json_request
from app.services.execution.stream_client import (
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
)
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import (
    DEEP_RESEARCH_CREATE_EXECUTE,
    DEEP_RESEARCH_STATUS_EXECUTE,
    DEEP_RESEARCH_STREAM,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/deep-research", tags=["deep-research"])

# Get rate limiter instance
limiter = get_limiter()


# ============================================================
# Request/Response Schemas
# ============================================================


class DeepResearchModelConfig(BaseModel):
    """Model configuration for deep research."""

    api_key: str = Field(..., description="API key for Gemini")
    base_url: str = Field(..., description="Base URL for Gemini Interaction API")
    default_headers: dict[str, str] = Field(
        default_factory=dict, description="Custom request headers for authentication"
    )


class DeepResearchMetadata(BaseModel):
    """Optional metadata for the request."""

    task_id: Optional[int] = Field(None, description="Task ID")
    subtask_id: Optional[int] = Field(None, description="Subtask ID")
    user_id: Optional[int] = Field(None, description="User ID")


class DeepResearchCreateRequest(BaseModel):
    """Request to create a deep research task."""

    model_config_data: DeepResearchModelConfig = Field(
        ..., alias="model_config", description="Model configuration"
    )
    input: str = Field(..., description="Research query")
    agent: str = Field(
        "deep-research-pro-preview-12-2025", description="Agent model to use"
    )
    metadata: Optional[DeepResearchMetadata] = Field(
        None, description="Optional metadata"
    )

    class Config:
        populate_by_name = True


class DeepResearchCreateResponse(BaseModel):
    """Response after creating a deep research task."""

    interaction_id: str = Field(..., description="Gemini interaction ID")
    status: str = Field(..., description="Task status")
    created_at: datetime = Field(..., description="Creation timestamp")


class DeepResearchStatusRequest(BaseModel):
    """Request to get status of a deep research task."""

    model_config_data: DeepResearchModelConfig = Field(
        ..., alias="model_config", description="Model configuration"
    )

    class Config:
        populate_by_name = True


class DeepResearchStatusResponse(BaseModel):
    """Response with task status."""

    interaction_id: str = Field(..., description="Gemini interaction ID")
    status: str = Field(..., description="Task status: in_progress, completed, failed")
    created_at: Optional[datetime] = Field(None, description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Last update timestamp")


class DeepResearchStreamRequest(BaseModel):
    """Request to stream deep research results."""

    model_config_data: DeepResearchModelConfig = Field(
        ..., alias="model_config", description="Model configuration"
    )

    class Config:
        populate_by_name = True


_DEEP_RESEARCH_CREATE_VALIDATOR = TypeAdapter(DeepResearchCreateRequest)
_DEEP_RESEARCH_STATUS_VALIDATOR = TypeAdapter(DeepResearchStatusRequest)
_DEEP_RESEARCH_STREAM_VALIDATOR = TypeAdapter(DeepResearchStreamRequest)


async def _decode_deep_research_create_request(
    request: Request,
) -> DeepResearchCreateRequest:
    return await validate_json_request(
        request,
        _DEEP_RESEARCH_CREATE_VALIDATOR,
        max_bytes=DEEP_RESEARCH_BODY_MAX_BYTES,
    )


async def _decode_deep_research_status_request(
    request: Request,
) -> DeepResearchStatusRequest:
    return await validate_json_request(
        request,
        _DEEP_RESEARCH_STATUS_VALIDATOR,
        max_bytes=DEEP_RESEARCH_BODY_MAX_BYTES,
    )


async def _decode_deep_research_stream_request(
    request: Request,
) -> DeepResearchStreamRequest:
    return await validate_json_request(
        request,
        _DEEP_RESEARCH_STREAM_VALIDATOR,
        max_bytes=DEEP_RESEARCH_BODY_MAX_BYTES,
    )


def _deep_research_stream_payload(
    interaction_id: str,
    model_config: DeepResearchModelConfig,
) -> dict[str, Any]:
    return {
        "interaction_id": interaction_id,
        "model_config": model_config.model_dump(mode="json"),
    }


async def _execute_deep_research(
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    try:
        return await web_stream_worker_client.execute(operation, payload)
    except StreamWorkerUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail="Deep research worker is unavailable",
        ) from error
    except StreamWorkerExecutionError as error:
        raise HTTPException(
            status_code=error.status_code or 502,
            detail=str(error),
        ) from error


# ============================================================
# API Endpoints
# ============================================================


@router.post(
    "",
    response_model=DeepResearchCreateResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": DeepResearchCreateRequest.model_json_schema(by_alias=True)
                }
            },
        }
    },
)
@nonblocking_limit(limiter, "10/minute")
async def create_deep_research(
    request: Request,
    request_body: DeepResearchCreateRequest = Depends(
        _decode_deep_research_create_request
    ),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """Create a new deep research task.

    This initiates a long-running research task using the Gemini Interaction API.
    The task runs in the background and can be polled for status.
    """
    current_user = auth_context.user
    user_id = current_user.id

    logger.info(
        "[DEEP_RESEARCH] Create request: user=%s, agent=%s, input_len=%d",
        user_id,
        request_body.agent,
        len(request_body.input),
    )

    del auth_context, current_user
    model_config = await dump_model(request_body.model_config_data, mode="json")
    result = await _execute_deep_research(
        DEEP_RESEARCH_CREATE_EXECUTE,
        {
            "model_config": model_config,
            "input": request_body.input,
            "agent": request_body.agent,
        },
    )
    interaction_id = result.get("id")
    if not isinstance(interaction_id, str) or not interaction_id:
        raise HTTPException(
            status_code=502,
            detail="Deep research worker returned an invalid create result",
        )
    return DeepResearchCreateResponse(
        interaction_id=interaction_id,
        status=result.get("status", "in_progress"),
        created_at=datetime.utcnow(),
    )


@router.post(
    "/{interaction_id}/status",
    response_model=DeepResearchStatusResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": DeepResearchStatusRequest.model_json_schema(by_alias=True)
                }
            },
        }
    },
)
@nonblocking_limit(limiter, "60/minute")
async def get_deep_research_status(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStatusRequest = Depends(
        _decode_deep_research_status_request
    ),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """Get the status of a deep research task.

    Poll this endpoint to check if the task has completed.
    """
    current_user = auth_context.user
    user_id = current_user.id

    logger.debug(
        "[DEEP_RESEARCH] Status request: user=%s, interaction_id=%s",
        user_id,
        interaction_id,
    )

    del auth_context, current_user
    model_config = await dump_model(request_body.model_config_data, mode="json")
    result = await _execute_deep_research(
        DEEP_RESEARCH_STATUS_EXECUTE,
        {
            "interaction_id": interaction_id,
            "model_config": model_config,
        },
    )

    created_at = None
    updated_at = None
    if result.get("created"):
        try:
            created_at = datetime.fromisoformat(
                result["created"].replace("Z", "+00:00")
            )
        except ValueError:
            pass
    if result.get("updated"):
        try:
            updated_at = datetime.fromisoformat(
                result["updated"].replace("Z", "+00:00")
            )
        except ValueError:
            pass

    returned_id = result.get("id")
    if not isinstance(returned_id, str) or not returned_id:
        raise HTTPException(
            status_code=502,
            detail="Deep research worker returned an invalid status result",
        )
    return DeepResearchStatusResponse(
        interaction_id=returned_id,
        status=result.get("status", "unknown"),
        created_at=created_at,
        updated_at=updated_at,
    )


@router.post(
    "/{interaction_id}/stream",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": DeepResearchStreamRequest.model_json_schema(by_alias=True)
                }
            },
        }
    },
)
@nonblocking_limit(limiter, "10/minute")
async def stream_deep_research_result(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStreamRequest = Depends(
        _decode_deep_research_stream_request
    ),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """Stream the results of a completed deep research task.

    Returns an SSE stream with research results including thought summaries
    and the final research report.
    """
    current_user = auth_context.user

    logger.info(
        "[DEEP_RESEARCH] Stream request: user=%s, interaction_id=%s",
        current_user.id,
        interaction_id,
    )

    payload = await run_payload_codec(
        _deep_research_stream_payload,
        interaction_id,
        request_body.model_config_data,
        payload_hint=request_body,
        force_offload=True,
    )
    del auth_context, current_user

    return StreamingResponse(
        web_stream_worker_client.stream(DEEP_RESEARCH_STREAM, payload),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
