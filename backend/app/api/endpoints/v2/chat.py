"""LangGraph Chat Service API endpoints (v2).

Provides OpenAI-compatible chat completion API with LangChain/LangGraph backend.
"""

import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.deps import get_current_user
from app.models import User
from app.services.langgraph_chat import LangGraphChatService

router = APIRouter()

# Service instance (will be initialized on app startup)
chat_service: Optional[LangGraphChatService] = None


class ChatMessage(BaseModel):
    """Chat message model."""

    role: str
    content: str | List[Dict[str, Any]]
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class WegentOptions(BaseModel):
    """Wegent-specific options."""

    task_id: Optional[int] = None
    deep_thinking: bool = False
    max_tool_iterations: int = 10
    mcp_servers: Optional[List[str]] = None
    skills: Optional[List[str]] = None
    user_id: Optional[int] = None
    namespace: str = "default"


class ChatCompletionRequest(BaseModel):
    """Chat completion request (OpenAI-compatible)."""

    model: str
    messages: List[ChatMessage]
    stream: bool = False
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: str = "auto"
    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: Optional[int] = None
    wegent_options: Optional[WegentOptions] = None


class ChatCompletionResponse(BaseModel):
    """Chat completion response (OpenAI-compatible)."""

    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[Dict[str, Any]]
    usage: Dict[str, int]


@router.post("/completions")
async def create_chat_completion(
    request: ChatCompletionRequest,
    current_user: User = Depends(get_current_user),
) -> ChatCompletionResponse | StreamingResponse:
    """Create chat completion (OpenAI-compatible endpoint).

    Args:
        request: Chat completion request
        current_user: Authenticated user

    Returns:
        Chat completion response or streaming response

    Raises:
        HTTPException: If service not initialized or error occurs
    """
    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    try:
        # Extract Wegent options
        wegent_opts = request.wegent_options or WegentOptions()
        user_id = wegent_opts.user_id or current_user.id

        # Convert messages to dict format
        messages_dict = [msg.model_dump() for msg in request.messages]

        # Execute completion
        result = await chat_service.chat_completion(
            model=request.model,
            messages=messages_dict,
            stream=request.stream,
            tools=request.tools,
            tool_choice=request.tool_choice,
            user_id=user_id,
            namespace=wegent_opts.namespace,
            deep_thinking=wegent_opts.deep_thinking,
            max_tool_iterations=wegent_opts.max_tool_iterations,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )

        if request.stream:
            # Return SSE stream
            return StreamingResponse(
                _stream_response(result),
                media_type="text/event-stream",
            )
        else:
            # Return standard response
            import time

            return ChatCompletionResponse(
                id=f"chatcmpl-{int(time.time())}",
                created=int(time.time()),
                model=request.model,
                choices=[
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": result.content,
                            "tool_calls": result.tool_calls,
                        },
                        "finish_reason": result.finish_reason,
                    }
                ],
                usage=result.usage,
            )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


async def _stream_response(stream_iterator):
    """Convert stream chunks to SSE format.

    Args:
        stream_iterator: AsyncIterator of StreamChunk

    Yields:
        SSE formatted data
    """
    async for chunk in stream_iterator:
        data = {
            "id": f"chatcmpl-{chunk.delta.get('id', '')}",
            "object": "chat.completion.chunk",
            "choices": [
                {
                    "index": 0,
                    "delta": chunk.delta,
                    "finish_reason": chunk.finish_reason,
                }
            ],
        }

        if chunk.usage:
            data["usage"] = chunk.usage

        yield f"data: {json.dumps(data)}\n\n"

    # Send done signal
    yield "data: [DONE]\n\n"


@router.get("/tools")
async def list_tools(
    current_user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """List available tools.

    Args:
        current_user: Authenticated user

    Returns:
        List of tool definitions

    Raises:
        HTTPException: If service not initialized
    """
    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    return chat_service.list_available_tools()


def get_chat_service() -> LangGraphChatService:
    """Get chat service instance.

    Returns:
        LangGraphChatService instance

    Raises:
        RuntimeError: If service not initialized
    """
    if not chat_service:
        raise RuntimeError("Chat service not initialized")
    return chat_service


async def initialize_chat_service(workspace_root: str = "/workspace") -> None:
    """Initialize chat service on app startup.

    Args:
        workspace_root: Root directory for file operations
    """
    global chat_service
    chat_service = LangGraphChatService(
        workspace_root=workspace_root,
        enable_mcp=True,
        enable_skills=True,
        enable_web_search=False,
    )
    await chat_service.initialize()


async def shutdown_chat_service() -> None:
    """Shutdown chat service on app shutdown."""
    global chat_service
    if chat_service:
        await chat_service.shutdown()
        chat_service = None
