# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deep Research API endpoints using Gemini Interaction API.

Provides endpoints for:
- Creating deep research tasks
- Polling task status
- Streaming task results
"""

import json
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from chat_shell.clients.gemini_interaction import (
    GeminiInteractionClient,
    GeminiInteractionError,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/deep-research", tags=["deep-research"])


# ============================================================
# Request/Response Schemas
# ============================================================


class DeepResearchModelConfig(BaseModel):
    """Model configuration for deep research."""

    api_key: str = Field("", description="API key for Gemini")
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
    """Map Gemini event types to Chat Shell event types."""
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
async def create_deep_research(request: DeepResearchCreateRequest):
    """Create a new deep research task.

    This initiates a long-running research task using the Gemini Interaction API.
    The task runs in the background and can be polled for status.
    """
    logger.info(
        "[DEEP_RESEARCH] Creating task: agent=%s, input_len=%d",
        request.agent,
        len(request.input),
    )

    client = GeminiInteractionClient(
        base_url=request.model_config_data.base_url,
        api_key=request.model_config_data.api_key,
        default_headers=request.model_config_data.default_headers,
    )

    try:
        result = await client.create_interaction(
            input_text=request.input,
            agent=request.agent,
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
async def get_deep_research_status(
    interaction_id: str,
    request: DeepResearchStatusRequest,
):
    """Get the status of a deep research task.

    Poll this endpoint to check if the task has completed.
    """
    logger.debug("[DEEP_RESEARCH] Getting status: id=%s", interaction_id)

    client = GeminiInteractionClient(
        base_url=request.model_config_data.base_url,
        api_key=request.model_config_data.api_key,
        default_headers=request.model_config_data.default_headers,
    )

    try:
        result = await client.get_interaction_status(interaction_id)

        # Parse timestamps if present
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
async def stream_deep_research_result(
    interaction_id: str,
    request: DeepResearchStreamRequest,
):
    """Stream the results of a completed deep research task.

    Returns an SSE stream with research results including thought summaries
    and the final research report.
    """
    logger.info("[DEEP_RESEARCH] Starting stream: id=%s", interaction_id)

    client = GeminiInteractionClient(
        base_url=request.model_config_data.base_url,
        api_key=request.model_config_data.api_key,
        default_headers=request.model_config_data.default_headers,
    )

    async def generate_sse():
        """Generate SSE events from Gemini stream."""
        try:
            async for event_type, event_data in client.stream_interaction_result(
                interaction_id
            ):
                # Map Gemini event type to Chat Shell event type
                mapped_type = _map_gemini_event_type(event_type)

                # Parse and re-emit the event data
                try:
                    data = json.loads(event_data)
                    yield _format_sse_event(mapped_type, data)
                except json.JSONDecodeError:
                    # If data is not JSON, wrap it
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
