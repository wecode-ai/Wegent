# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Assist API endpoints for document editing assistance.

This module provides APIs for AI-powered text processing in the document editor,
including rewrite, expand, summarize, and custom prompts.
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.services.chat.config import extract_and_process_model_config
from app.services.simple_chat import simple_chat_service

logger = logging.getLogger(__name__)

router = APIRouter()


# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}


def _sse_data(data: dict) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class AIAssistSource(BaseModel):
    """Source citation for AI-generated content."""

    index: int = Field(..., description="Source index for footnote reference")
    title: str = Field(..., description="Source title")
    url: Optional[str] = Field(None, description="Source URL")
    kb_id: Optional[int] = Field(None, description="Knowledge base ID if from KB")
    document_id: Optional[int] = Field(None, description="Document ID if from KB")


class AIAssistRequest(BaseModel):
    """Request schema for AI assist processing."""

    action: str = Field(
        ...,
        description="Action type: rewrite, expand, summarize, fix_grammar, custom, continue, outline, search",
    )
    content: str = Field(..., description="The content to process")
    context: Optional[str] = Field(None, description="Surrounding context")
    custom_prompt: Optional[str] = Field(
        None, description="Custom prompt for 'custom' action"
    )
    knowledge_base_id: Optional[int] = Field(
        None, description="Knowledge base ID for search"
    )
    enable_web_search: bool = Field(False, description="Enable web search")
    system_prompt: Optional[str] = Field(None, description="System prompt override")
    user_message: Optional[str] = Field(None, description="User message override")


class AIAssistResponse(BaseModel):
    """Response schema for AI assist processing (non-streaming)."""

    content: str = Field(..., description="Generated content")
    sources: Optional[list[AIAssistSource]] = Field(
        None, description="Source citations"
    )


# System prompts for different actions
ACTION_PROMPTS = {
    "rewrite": """You are a professional editor. Rewrite the following text to make it clearer, more concise, and professional.
Maintain the original meaning and tone. Return ONLY the rewritten text without any explanation or commentary.""",
    "expand": """You are a professional writer. Expand the following text with more details, examples, or explanations.
Keep the original content and add relevant information. Return ONLY the expanded text without any explanation.""",
    "summarize": """You are a professional summarizer. Summarize the following text into a concise version that captures the key points.
Return ONLY the summary without any explanation.""",
    "fix_grammar": """You are a professional proofreader. Fix any grammar, spelling, and punctuation errors in the following text.
Maintain the original meaning and style. Return ONLY the corrected text without any explanation.""",
    "continue": """You are a professional writer. Based on the context provided, continue writing naturally.
Match the style and tone of the existing content. Return ONLY the continuation without any explanation.""",
    "outline": """You are a professional document planner. Generate an outline for a document based on the context provided.
Use markdown format with headers and bullet points. Return ONLY the outline without any explanation.""",
    "search": """You are a research assistant. Search for relevant information and expand the content with properly cited sources.
Include footnote references [^1], [^2], etc. for any facts or information you include.
Return the expanded content with a "References" section at the end.""",
}


def _get_system_prompt(action: str, custom_prompt: Optional[str] = None) -> str:
    """Get the system prompt for the given action."""
    if action == "custom" and custom_prompt:
        return f"""You are a helpful AI assistant. Process the following text according to this instruction: {custom_prompt}
Return ONLY the result without any explanation or commentary."""

    return ACTION_PROMPTS.get(
        action,
        "You are a helpful AI assistant. Process the following text as requested.",
    )


async def _get_model_config(db: Session, user: User) -> dict[str, Any]:
    """
    Get model configuration for AI assist.

    Model selection priority:
    1. If WIZARD_MODEL_NAME is configured, use that public model
    2. Otherwise, try user's models first
    3. Fall back to any available public model
    """
    model_kind = None

    # Priority 1: Use configured wizard model if specified
    if settings.WIZARD_MODEL_NAME:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,  # Public model
                Kind.kind == "Model",
                Kind.name == settings.WIZARD_MODEL_NAME,
                Kind.is_active == True,
            )
            .first()
        )

    # Priority 2: Try user's models
    if not model_kind:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == user.id,
                Kind.kind == "Model",
                Kind.is_active == True,
            )
            .first()
        )

    # Priority 3: Fall back to any public model
    if not model_kind:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.is_active == True,
            )
            .first()
        )

    if not model_kind:
        raise HTTPException(
            status_code=503,
            detail="No model available. Please configure a model in settings.",
        )

    # Extract model config
    model_spec = model_kind.spec
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=user.id,
        user_name=user.user_name or "",
    )

    return model_config


@router.post("/process")
async def process_ai_assist(
    request: AIAssistRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Process AI assist request with streaming response.

    Returns SSE events:
    - {"type": "chunk", "content": "..."} - Content chunks
    - {"type": "done", "sources": [...]} - Completion with optional sources
    - {"type": "error", "error": "..."} - Error message
    """

    async def generate() -> AsyncGenerator[str, None]:
        try:
            # Get model configuration
            model_config = await _get_model_config(db, current_user)

            # Build system prompt
            system_prompt = request.system_prompt or _get_system_prompt(
                request.action, request.custom_prompt
            )

            # Build user message
            if request.user_message:
                user_message = request.user_message
            elif request.context:
                user_message = f"Context:\n{request.context}\n\nContent to process:\n{request.content}"
            else:
                user_message = request.content

            # Stream response from LLM
            cancel_event = asyncio.Event()
            accumulated_content = ""

            from app.services.simple_chat.http_client import get_http_client
            from app.services.simple_chat.message_builder import MessageBuilder
            from app.services.simple_chat.providers import get_provider
            from app.services.simple_chat.providers.base import ChunkType

            # Build messages
            message_builder = MessageBuilder()
            messages = message_builder.build_messages(
                history=[],
                current_message=user_message,
                system_prompt=system_prompt,
            )

            # Get provider
            client = await get_http_client()
            provider = get_provider(model_config, client)
            if not provider:
                yield _sse_data({"type": "error", "error": "Failed to initialize AI model"})
                return

            # Stream response
            async for chunk in provider.stream_chat(messages, cancel_event):
                if chunk.type == ChunkType.CONTENT and chunk.content:
                    accumulated_content += chunk.content
                    yield _sse_data({"type": "chunk", "content": chunk.content})
                elif chunk.type == ChunkType.ERROR:
                    yield _sse_data({"type": "error", "error": chunk.error or "Unknown error"})
                    return

            # Send completion
            yield _sse_data({"type": "done", "sources": None})

        except HTTPException as e:
            yield _sse_data({"type": "error", "error": e.detail})
        except Exception as e:
            logger.error(f"AI assist error: {e}", exc_info=True)
            yield _sse_data({"type": "error", "error": str(e)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/process-sync", response_model=AIAssistResponse)
async def process_ai_assist_sync(
    request: AIAssistRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Process AI assist request synchronously (non-streaming).

    Returns the complete response at once.
    """
    try:
        # Get model configuration
        model_config = await _get_model_config(db, current_user)

        # Build system prompt
        system_prompt = request.system_prompt or _get_system_prompt(
            request.action, request.custom_prompt
        )

        # Build user message
        if request.user_message:
            user_message = request.user_message
        elif request.context:
            user_message = f"Context:\n{request.context}\n\nContent to process:\n{request.content}"
        else:
            user_message = request.content

        # Get response from LLM
        response = await simple_chat_service.chat_completion(
            message=user_message,
            model_config=model_config,
            system_prompt=system_prompt,
        )

        return AIAssistResponse(content=response, sources=None)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"AI assist error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
