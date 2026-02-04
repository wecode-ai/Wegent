# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Deep Research API endpoints.

Proxies requests to Chat Shell's deep research API for long-running
research tasks using Gemini Interaction API.
"""

import logging
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.core.rate_limit import get_limiter

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
# Helper Functions
# ============================================================


def _get_chat_shell_url() -> str:
    """Get chat shell URL from settings."""
    return settings.CHAT_SHELL_URL.rstrip("/")


async def _proxy_post_request(
    path: str,
    data: dict[str, Any],
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Proxy a POST request to chat shell."""
    url = f"{_get_chat_shell_url()}{path}"
    logger.debug("[DEEP_RESEARCH] Proxying POST to %s", url)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(url, json=data)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            logger.error(
                "[DEEP_RESEARCH] HTTP error: %d - %s", e.response.status_code, e
            )
            # Try to parse error details from response
            try:
                detail = e.response.json().get("detail", str(e))
            except Exception:
                detail = str(e)
            raise HTTPException(
                status_code=e.response.status_code,
                detail=detail,
            )
        except httpx.RequestError as e:
            logger.error("[DEEP_RESEARCH] Request error: %s", e)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to connect to chat shell service: {e}",
            )


async def _proxy_stream_request(
    path: str,
    data: dict[str, Any],
    timeout: float = 600.0,  # 10 minutes for streaming
):
    """Proxy a streaming POST request to chat shell."""
    url = f"{_get_chat_shell_url()}{path}"
    logger.debug("[DEEP_RESEARCH] Proxying stream POST to %s", url)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream("POST", url, json=data) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line:
                        yield line + "\n"
        except httpx.HTTPStatusError as e:
            logger.error(
                "[DEEP_RESEARCH] Stream HTTP error: %d - %s",
                e.response.status_code,
                e,
            )
            yield f"event: error\ndata: {{'error': 'HTTP {e.response.status_code}'}}\n\n"
        except httpx.RequestError as e:
            logger.error("[DEEP_RESEARCH] Stream request error: %s", e)
            yield f"event: error\ndata: {{'error': 'Connection error: {e}'}}\n\n"


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
    """
    Create a new deep research task.

    This initiates a long-running research task using the Gemini Interaction API.
    The task runs in the background and can be polled for status.

    Args:
        request_body: DeepResearchCreateRequest containing:
        - model_config: API key and base URL for Gemini
        - input: The research query
        - agent: Optional agent model to use (default: deep-research-pro-preview-12-2025)
        - metadata: Optional metadata for tracking

    Returns:
        DeepResearchCreateResponse with interaction_id for polling
    """
    current_user = auth_context.user

    logger.info(
        "[DEEP_RESEARCH] Create request: user=%s, agent=%s, input_len=%d",
        current_user.id,
        request_body.agent,
        len(request_body.input),
    )

    # Prepare request data for chat shell
    data = request_body.model_dump()

    # Pass through to chat shell
    result = await _proxy_post_request("/v1/deep-research", data)

    return DeepResearchCreateResponse(**result)


@router.post("/{interaction_id}/status", response_model=DeepResearchStatusResponse)
@limiter.limit("60/minute")
async def get_deep_research_status(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStatusRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """
    Get the status of a deep research task.

    Poll this endpoint to check if the task has completed.

    Args:
        interaction_id: The interaction ID returned from create
        request_body: DeepResearchStatusRequest with model_config

    Returns:
        DeepResearchStatusResponse with current status
    """
    current_user = auth_context.user

    logger.debug(
        "[DEEP_RESEARCH] Status request: user=%s, interaction_id=%s",
        current_user.id,
        interaction_id,
    )

    # Prepare request data for chat shell
    data = request_body.model_dump()

    # Pass through to chat shell
    result = await _proxy_post_request(
        f"/v1/deep-research/{interaction_id}/status", data
    )

    return DeepResearchStatusResponse(**result)


@router.post("/{interaction_id}/stream")
@limiter.limit("10/minute")
async def stream_deep_research_result(
    request: Request,
    interaction_id: str,
    request_body: DeepResearchStreamRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """
    Stream the results of a completed deep research task.

    Returns an SSE stream with research results including thought summaries
    and the final research report.

    Args:
        interaction_id: The interaction ID returned from create
        request_body: DeepResearchStreamRequest with model_config

    Returns:
        Server-Sent Events stream with research results
    """
    current_user = auth_context.user

    logger.info(
        "[DEEP_RESEARCH] Stream request: user=%s, interaction_id=%s",
        current_user.id,
        interaction_id,
    )

    # Prepare request data for chat shell
    data = request_body.model_dump()

    return StreamingResponse(
        _proxy_stream_request(f"/v1/deep-research/{interaction_id}/stream", data),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
