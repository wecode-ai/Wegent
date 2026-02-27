# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Deep Research API endpoints.

Calls the Gemini Interaction API directly via GeminiInteractionClient
for long-running research tasks.
"""

import json
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.rate_limit import get_limiter
from shared.clients.gemini_interaction import (
    GeminiInteractionClient,
    GeminiInteractionError,
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


# ============================================================
# SSE Event Formatting
# ============================================================


def _format_sse_event(event_type: str, data: dict[str, Any]) -> str:
    """Format data as SSE event."""
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _map_gemini_event_type(gemini_event: str) -> str:
    """Map Gemini event types to frontend-expected event types."""
    mapping = {
        "interaction.start": "response.start",
        "interaction.status_update": "response.status_update",
        "content.start": "content.start",
        "content.delta": "content.delta",
        "content.stop": "content.stop",
        "interaction.complete": "response.done",
        "done": "done",
    }
    return mapping.get(gemini_event, gemini_event)


# ============================================================
# API Endpoints
# ============================================================


@router.post("", response_model=DeepResearchCreateResponse)
@limiter.limit("10/minute")
async def create_deep_research(
    request: Request,
    request_body: DeepResearchCreateRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """Create a new deep research task.

    This initiates a long-running research task using the Gemini Interaction API.
    The task runs in the background and can be polled for status.
    """
    current_user = auth_context.user

    logger.info(
        "[DEEP_RESEARCH] Create request: user=%s, agent=%s, input_len=%d",
        current_user.id,
        request_body.agent,
        len(request_body.input),
    )

    client = GeminiInteractionClient(
        base_url=request_body.model_config_data.base_url,
        api_key=request_body.model_config_data.api_key,
        default_headers=request_body.model_config_data.default_headers,
    )

    try:
        result = await client.create_interaction(
            input_text=request_body.input,
            agent=request_body.agent,
        )

        return DeepResearchCreateResponse(
            interaction_id=result["id"],
            status=result.get("status", "in_progress"),
            created_at=datetime.utcnow(),
        )

    except GeminiInteractionError as e:
        logger.error("[DEEP_RESEARCH] Create failed: %s", e)
        raise HTTPException(
            status_code=e.status_code or 500,
            detail=str(e),
        )


@router.post("/{interaction_id}/status", response_model=DeepResearchStatusResponse)
@limiter.limit("60/minute")
async def get_deep_research_status(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStatusRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """Get the status of a deep research task.

    Poll this endpoint to check if the task has completed.
    """
    current_user = auth_context.user

    logger.debug(
        "[DEEP_RESEARCH] Status request: user=%s, interaction_id=%s",
        current_user.id,
        interaction_id,
    )

    client = GeminiInteractionClient(
        base_url=request_body.model_config_data.base_url,
        api_key=request_body.model_config_data.api_key,
        default_headers=request_body.model_config_data.default_headers,
    )

    try:
        result = await client.get_interaction_status(interaction_id)

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

        return DeepResearchStatusResponse(
            interaction_id=result["id"],
            status=result.get("status", "unknown"),
            created_at=created_at,
            updated_at=updated_at,
        )

    except GeminiInteractionError as e:
        logger.error("[DEEP_RESEARCH] Get status failed: %s", e)
        raise HTTPException(
            status_code=e.status_code or 500,
            detail=str(e),
        )


@router.post("/{interaction_id}/stream")
@limiter.limit("10/minute")
async def stream_deep_research_result(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStreamRequest,
    db: Session = Depends(get_db),
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

    client = GeminiInteractionClient(
        base_url=request_body.model_config_data.base_url,
        api_key=request_body.model_config_data.api_key,
        default_headers=request_body.model_config_data.default_headers,
    )

    async def generate_sse():
        """Generate SSE events from Gemini stream."""
        try:
            async for event_type, event_data in client.stream_interaction_result(
                interaction_id
            ):
                mapped_type = _map_gemini_event_type(event_type)

                try:
                    data = json.loads(event_data)
                    yield _format_sse_event(mapped_type, data)
                except json.JSONDecodeError:
                    yield _format_sse_event(mapped_type, {"raw": event_data})

        except GeminiInteractionError as e:
            logger.error("[DEEP_RESEARCH] Stream error: %s", e)
            yield _format_sse_event(
                "response.error",
                {
                    "code": "stream_error",
                    "message": str(e),
                    "status_code": e.status_code,
                },
            )

        except Exception as e:
            logger.exception("[DEEP_RESEARCH] Unexpected stream error: %s", e)
            yield _format_sse_event(
                "response.error",
                {
                    "code": "internal_error",
                    "message": str(e),
                },
            )

    return StreamingResponse(
        generate_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
