# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell API endpoints.

Provides streaming chat API for Chat Shell type, bypassing Docker Executor.

Business logic has been extracted to services/chat/ modules:
- config/: Chat configuration and model resolution
- storage/: Task and subtask creation
- trigger/: AI response triggering
- correction/: AI correction functionality
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.config import (
    get_team_first_bot_shell_type,
    should_use_direct_chat,
)
from app.services.chat.correction import (
    apply_correction_to_subtask,
    build_chat_history,
    delete_correction_from_subtask,
    evaluate_and_save_correction,
    get_existing_correction,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class StreamChatRequest(BaseModel):
    """Request body for streaming chat."""

    message: str
    team_id: int
    task_id: Optional[int] = None  # Optional for multi-turn conversations
    title: Optional[str] = None  # Optional custom title for new tasks
    model_id: Optional[str] = None  # Optional model override
    force_override_bot_model: bool = False
    attachment_id: Optional[int] = None  # Optional attachment ID for file upload
    # Web search toggle
    enable_web_search: bool = False  # Enable web search for this message
    search_engine: Optional[str] = None  # Search engine to use
    # Clarification mode toggle
    enable_clarification: bool = False  # Enable clarification mode for this message
    # Git info (optional, for record keeping)
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    # Resume/reconnect parameters for offset-based streaming
    subtask_id: Optional[int] = None  # For resuming an existing stream
    offset: Optional[int] = None  # Character offset for resuming (0 = new stream)
    # Group chat flag
    is_group_chat: bool = False  # Whether this is a group chat


@router.get("/check-direct-chat/{team_id}")
async def check_direct_chat(
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Check if a team supports direct chat mode.

    Returns:
        {"supports_direct_chat": bool, "shell_type": str}
    """
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    supports_direct_chat = should_use_direct_chat(db, team, current_user.id)

    # Get shell type of first bot
    shell_type = get_team_first_bot_shell_type(db, team)

    return {
        "supports_direct_chat": supports_direct_chat,
        "shell_type": shell_type,
    }


@router.get("/search-engines")
async def get_search_engines(
    current_user: User = Depends(security.get_current_user),
):
    """
    Get available search engines from configuration.

    Returns:
        {
            "enabled": bool,
            "engines": [{"name": str, "display_name": str}]
        }
    """
    from app.core.config import settings
    from app.services.search.factory import get_available_engines

    if not settings.WEB_SEARCH_ENABLED:
        return {"enabled": False, "engines": []}

    # Get available engines from factory
    engines = get_available_engines()

    return {
        "enabled": True,
        "engines": engines,
    }


# AI Correction Feature
class CorrectionRequest(BaseModel):
    """Request body for AI correction."""

    task_id: int
    message_id: int
    original_question: str
    original_answer: str
    correction_model_id: str
    force_retry: bool = False  # Force re-evaluation even if correction exists
    enable_web_search: bool = False  # Enable web search tool for fact verification
    search_engine: Optional[str] = None  # Search engine name to use


@router.post("/correct")
async def correct_response(
    request: CorrectionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Evaluate and correct an AI response using a specified correction model.

    This endpoint:
    1. Validates the correction model exists and is accessible
    2. Checks if correction already exists in subtask.result (returns cached)
    3. If not cached, sends the original Q&A to the correction model for evaluation
    4. Broadcasts real-time progress updates via WebSocket
    5. Saves correction result to subtask.result.correction for persistence
    6. Returns scores, corrections, summary, and improved answer

    Returns:
        {
            "message_id": int,
            "scores": {"accuracy": int, "logic": int, "completeness": int},
            "corrections": [{"issue": str, "suggestion": str}],
            "summary": str,
            "improved_answer": str,
            "is_correct": bool
        }
    """
    from app.services.chat.ws_emitter import get_ws_emitter

    # Get WebSocket emitter for progress broadcasting
    ws_emitter = get_ws_emitter()

    # Validate that the task belongs to the current user
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == request.task_id,
            TaskResource.user_id == current_user.id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == request.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Task not found")

    # Get the subtask (AI message) to check for existing correction
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == request.message_id,
            Subtask.task_id == request.task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="AI message not found")

    # Check for existing correction using service module
    existing_correction = get_existing_correction(subtask)

    # Return cached result only if not forcing retry
    if existing_correction and not request.force_retry:
        # Return cached result including applied status
        return {
            "message_id": subtask.id,
            "scores": existing_correction.get("scores", {}),
            "corrections": existing_correction.get("corrections", []),
            "summary": existing_correction.get("summary", ""),
            "improved_answer": existing_correction.get("improved_answer", ""),
            "is_correct": existing_correction.get("is_correct", False),
            "applied": existing_correction.get("applied", False),
        }

    # Get the correction model config using chat's unified model resolver
    # This handles: env var placeholders, decryption, default_headers, etc.
    from app.services.chat.config.model_resolver import (
        _find_model,
        extract_and_process_model_config,
    )

    model_spec = _find_model(db, request.correction_model_id, current_user.id)
    if not model_spec:
        raise HTTPException(
            status_code=400,
            detail=f"Correction model '{request.correction_model_id}' not found",
        )

    # Extract and process model config with all placeholder handling
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=current_user.id,
        user_name=current_user.user_name or "",
    )

    # Build chat history from previous subtasks using service module
    history = build_chat_history(db, request.task_id, subtask.message_id)

    # Get search tool if enabled (use LangChain-compatible WebSearchTool for LangGraph)
    tools = None
    if request.enable_web_search:
        from chat_shell.tools import WebSearchTool

        # Use a reasonable default for correction (API limit is 50)
        search_tool = WebSearchTool(
            engine_name=request.search_engine,
            default_max_results=10,  # Correction only needs a few results for fact-checking
        )
        tools = [search_tool]
        logger.info(
            f"Enabled web search tool for correction (engine: {request.search_engine or 'default'})"
        )

    # Emit correction:start event
    if ws_emitter:
        await ws_emitter.emit_correction_start(
            task_id=request.task_id,
            subtask_id=request.message_id,
            correction_model=request.correction_model_id,
        )

    # Define progress callback for WebSocket broadcasting
    async def on_progress(stage: str, tool_name: str | None) -> None:
        """Broadcast correction progress via WebSocket."""
        if ws_emitter:
            await ws_emitter.emit_correction_progress(
                task_id=request.task_id,
                subtask_id=request.message_id,
                stage=stage,
                tool_name=tool_name,
            )

    # Define chunk callback for streaming content (future use)
    async def on_chunk(field: str, content: str, offset: int) -> None:
        """Broadcast correction content chunks via WebSocket."""
        if ws_emitter:
            await ws_emitter.emit_correction_chunk(
                task_id=request.task_id,
                subtask_id=request.message_id,
                field=field,
                content=content,
                offset=offset,
            )

    try:
        # Call correction service with progress callbacks using service module
        llm_result = await evaluate_and_save_correction(
            db=db,
            subtask=subtask,
            original_question=request.original_question,
            original_answer=request.original_answer,
            model_config=model_config,
            correction_model_id=request.correction_model_id,
            history=history if history else None,
            tools=tools,
            on_progress=on_progress,
            on_chunk=on_chunk,
        )

        # Emit correction:done event
        if ws_emitter:
            await ws_emitter.emit_correction_done(
                task_id=request.task_id,
                subtask_id=request.message_id,
                result=llm_result,
            )

        return {
            "message_id": request.message_id,
            "scores": llm_result["scores"],
            "corrections": llm_result["corrections"],
            "summary": llm_result["summary"],
            "improved_answer": llm_result["improved_answer"],
            "is_correct": llm_result["is_correct"],
        }

    except Exception as e:
        logger.error(f"Correction evaluation failed: {e}", exc_info=True)

        # Emit correction:error event
        if ws_emitter:
            await ws_emitter.emit_correction_error(
                task_id=request.task_id,
                subtask_id=request.message_id,
                error=str(e),
            )

        raise HTTPException(
            status_code=500,
            detail=f"Correction evaluation failed: {str(e)}",
        )


@router.delete("/subtasks/{subtask_id}/correction")
async def delete_correction(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete correction data from a subtask.

    This allows users to re-run correction with a different model.
    The correction data is stored in subtask.result.correction.
    """
    # Get the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Verify user has access to the task
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == subtask.task_id,
            TaskResource.user_id == current_user.id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == subtask.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=403, detail="Access denied")

    # Remove correction from result using service module
    delete_correction_from_subtask(db, subtask)

    return {"message": "Correction deleted"}


class ApplyCorrectionRequest(BaseModel):
    """Request body for applying correction to replace AI message."""

    improved_answer: str


@router.post("/subtasks/{subtask_id}/apply-correction")
async def apply_correction(
    subtask_id: int,
    request: ApplyCorrectionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Apply the improved answer from correction to replace the AI message content.

    This endpoint:
    1. Validates the subtask exists and user has access
    2. Updates subtask.result.value with the improved answer
    3. Marks the correction as applied in subtask.result.correction

    Returns:
        {"message": "Correction applied", "subtask_id": int}
    """
    # Get the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Verify user has access to the task
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == subtask.task_id,
            TaskResource.user_id == current_user.id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == subtask.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=403, detail="Access denied")

    # Apply correction using service module
    apply_correction_to_subtask(db, subtask, request.improved_answer)

    return {"message": "Correction applied", "subtask_id": subtask_id}


# Mermaid Diagram Fix Feature
class FixMermaidRequest(BaseModel):
    """Request body for fixing Mermaid diagram code."""

    code: str  # The original Mermaid code that failed to render
    error: str  # The error message from the Mermaid renderer
    model_id: Optional[str] = None  # Optional model ID (uses default if not provided)


class FixMermaidResponse(BaseModel):
    """Response body for Mermaid diagram fix."""

    success: bool
    fixed_code: Optional[str] = None
    error: Optional[str] = None


@router.post("/fix-mermaid")
async def fix_mermaid_code(
    request: FixMermaidRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Fix Mermaid diagram code that failed to render.

    This endpoint:
    1. Takes the original Mermaid code and error message
    2. Sends to LLM to fix the syntax/semantic errors
    3. Returns the fixed Mermaid code

    Returns:
        {"success": bool, "fixed_code": str, "error": str}
    """
    from app.services.chat.config.model_resolver import (
        _find_model,
        extract_and_process_model_config,
    )

    # Use provided model_id or default to a sensible default model
    model_id = request.model_id
    if not model_id:
        # Try to find a default model - prefer GPT-4o or Claude
        for default_name in ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "gpt-4"]:
            model_spec = _find_model(db, default_name, current_user.id)
            if model_spec:
                model_id = default_name
                break

    if not model_id:
        return FixMermaidResponse(
            success=False,
            error="No model available for Mermaid fix. Please configure a model.",
        )

    # Find the model
    model_spec = _find_model(db, model_id, current_user.id)
    if not model_spec:
        return FixMermaidResponse(
            success=False, error=f"Model '{model_id}' not found"
        )

    # Extract and process model config
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=current_user.id,
        user_name=current_user.user_name or "",
    )

    # Build the fix prompt
    fix_prompt = f"""Please fix the following Mermaid diagram code that has a render error.

Error message: {request.error}

Original Mermaid code:
```mermaid
{request.code}
```

Please analyze the error and fix the Mermaid code. Output ONLY the corrected Mermaid code in a mermaid code block, without any explanation or additional text. The output must be a valid Mermaid diagram that will render correctly.

Important rules:
1. Preserve the original diagram structure and intent
2. Fix only the syntax/semantic errors that caused the render failure
3. Use proper Mermaid syntax for the diagram type (flowchart, sequence, etc.)
4. Do not add any explanations, just output the fixed code in a mermaid code block"""

    try:
        # Call LLM to fix the code
        fixed_code = await _call_llm_for_mermaid_fix(model_config, fix_prompt)

        if fixed_code:
            return FixMermaidResponse(success=True, fixed_code=fixed_code)
        else:
            return FixMermaidResponse(
                success=False,
                error="Failed to extract fixed Mermaid code from LLM response",
            )

    except Exception as e:
        logger.error(f"Mermaid fix failed: {e}", exc_info=True)
        return FixMermaidResponse(success=False, error=str(e))


async def _call_llm_for_mermaid_fix(model_config: dict, prompt: str) -> Optional[str]:
    """
    Call LLM to fix Mermaid code.

    Args:
        model_config: Model configuration dict
        prompt: The fix prompt

    Returns:
        Fixed Mermaid code or None
    """
    import re

    from langchain_anthropic import ChatAnthropic
    from langchain_core.messages import HumanMessage
    from langchain_openai import ChatOpenAI

    model_type = model_config.get("model", "openai")
    api_key = model_config.get("api_key", "")
    base_url = model_config.get("base_url", "")
    model_id = model_config.get("model_id", "gpt-4o-mini")
    default_headers = model_config.get("default_headers", {})

    # Create LLM client based on model type
    if model_type == "claude":
        llm = ChatAnthropic(
            model=model_id,
            api_key=api_key,
            base_url=base_url if base_url else None,
            max_tokens=4096,
            timeout=60,
            default_headers=default_headers if default_headers else None,
        )
    else:
        # Default to OpenAI-compatible
        llm = ChatOpenAI(
            model=model_id,
            api_key=api_key,
            base_url=base_url if base_url else None,
            max_tokens=4096,
            timeout=60,
            default_headers=default_headers if default_headers else None,
        )

    # Call LLM
    messages = [HumanMessage(content=prompt)]
    response = await llm.ainvoke(messages)

    # Extract Mermaid code from response
    content = response.content
    if isinstance(content, str):
        # Try to extract code from mermaid code block
        mermaid_match = re.search(r"```mermaid\s*([\s\S]*?)```", content, re.IGNORECASE)
        if mermaid_match:
            return mermaid_match.group(1).strip()

        # Fallback: try to extract from any code block
        code_match = re.search(r"```\s*([\s\S]*?)```", content)
        if code_match:
            return code_match.group(1).strip()

        # Last resort: return the entire content if it looks like Mermaid code
        if any(
            keyword in content.lower()
            for keyword in ["graph", "flowchart", "sequencediagram", "classdiagram"]
        ):
            return content.strip()

    return None
