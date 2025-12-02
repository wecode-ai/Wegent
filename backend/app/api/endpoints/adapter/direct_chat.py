# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Direct Chat API Endpoints.

Provides SSE streaming endpoints for direct chat with Chat and Dify shell types.
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Model, Shell, Task, Team
from app.services.adapters.shell_utils import get_shell_info_by_name
from app.services.direct_chat.base import DIRECT_CHAT_SHELL_TYPES
from app.services.direct_chat.chat_service import ChatDirectService
from app.services.direct_chat.dify_service import DifyDirectService
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted

router = APIRouter()
logger = logging.getLogger(__name__)

# Thread pool for database operations in async context
_db_executor = ThreadPoolExecutor(max_workers=10)

# Concurrency control semaphore
_chat_semaphore: Optional[asyncio.Semaphore] = None


def get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the concurrency limiting semaphore."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_DIRECT_CHATS)
    return _chat_semaphore


class DirectChatRequest(BaseModel):
    """Request model for direct chat."""
    prompt: str
    bot_prompt: Optional[str] = None


def _get_bot_shell_config(
    db: Session,
    bot_id: int,
    user_id: int,
) -> Dict[str, Any]:
    """
    Get bot configuration including shell type and model config.

    Args:
        db: Database session
        bot_id: Bot ID
        user_id: User ID

    Returns:
        Dictionary with shell_type, model_config, etc.
    """
    bot = (
        db.query(Kind)
        .filter(Kind.id == bot_id, Kind.kind == "Bot", Kind.is_active == True)
        .first()
    )

    if not bot:
        raise HTTPException(status_code=404, detail=f"Bot {bot_id} not found")

    bot_crd = Bot.model_validate(bot.json)

    # Get shell info
    shell_info = get_shell_info_by_name(
        db, bot_crd.spec.shellRef.name, bot.user_id, bot_crd.spec.shellRef.namespace
    )
    shell_type = shell_info["shell_type"]

    # Get model config (either from bind_model in agent_config or modelRef)
    model_config = {}
    agent_config = bot_crd.spec.agentConfig or {}

    # Check bind_model first (new way)
    bind_model = agent_config.get("bind_model")
    if bind_model:
        # Find model by name
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == bot.user_id,
                Kind.kind == "Model",
                Kind.name == bind_model,
                Kind.is_active == True,
            )
            .first()
        )
        if model:
            model_crd = Model.model_validate(model.json)
            model_config = model_crd.spec.modelConfig or {}
    elif bot_crd.spec.modelRef:
        # Fallback to modelRef (legacy way)
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == bot.user_id,
                Kind.kind == "Model",
                Kind.name == bot_crd.spec.modelRef.name,
                Kind.namespace == bot_crd.spec.modelRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if model:
            model_crd = Model.model_validate(model.json)
            model_config = model_crd.spec.modelConfig or {}

    # Extract env vars from agent_config
    env_config = agent_config.get("env", {})

    return {
        "shell_type": shell_type,
        "model_config": model_config,
        "env_config": env_config,
        "agent_config": agent_config,
    }


def _build_chat_config(env_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build configuration for Chat service from environment variables.

    Args:
        env_config: Environment configuration dictionary

    Returns:
        Configuration dictionary for Chat service
    """
    api_key = env_config.get("API_KEY", "") or env_config.get("ANTHROPIC_API_KEY", "") or env_config.get("OPENAI_API_KEY", "")
    if api_key and is_data_encrypted(api_key):
        api_key = decrypt_sensitive_data(api_key) or ""

    return {
        "api_key": api_key,
        "base_url": env_config.get("BASE_URL", "") or env_config.get("API_BASE_URL", ""),
        "model_id": env_config.get("MODEL_ID", "") or env_config.get("MODEL", ""),
        "model": env_config.get("MODEL_TYPE", "openai"),  # 'claude' or 'openai'
    }


def _build_dify_config(env_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build configuration for Dify service from environment variables.

    Args:
        env_config: Environment configuration dictionary

    Returns:
        Configuration dictionary for Dify service
    """
    api_key = env_config.get("DIFY_API_KEY", "")
    if api_key and is_data_encrypted(api_key):
        api_key = decrypt_sensitive_data(api_key) or ""

    # Parse params if present
    params = {}
    params_str = env_config.get("DIFY_PARAMS", "")
    if params_str:
        try:
            params = json.loads(params_str) if isinstance(params_str, str) else params_str
        except json.JSONDecodeError:
            pass

    return {
        "api_key": api_key,
        "base_url": env_config.get("DIFY_BASE_URL", "https://api.dify.ai"),
        "app_id": env_config.get("DIFY_APP_ID", ""),
        "params": params,
    }


async def _update_subtask_status_async(
    db: Session,
    subtask_id: int,
    status: SubtaskStatus,
    result: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    """
    Update subtask status asynchronously using thread pool.

    Args:
        db: Database session
        subtask_id: Subtask ID
        status: New status
        result: Optional result content
        error_message: Optional error message
    """
    loop = asyncio.get_event_loop()

    def _update():
        subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
        if subtask:
            subtask.status = status
            subtask.updated_at = datetime.now()
            if result is not None:
                subtask.result = result
            if error_message is not None:
                subtask.error_message = error_message
            if status in [SubtaskStatus.COMPLETED, SubtaskStatus.FAILED]:
                subtask.completed_at = datetime.now()
            db.commit()

    await loop.run_in_executor(_db_executor, _update)


async def _update_task_status_async(
    db: Session,
    task_id: int,
    status: str,
    error_message: Optional[str] = None,
) -> None:
    """
    Update task status asynchronously using thread pool.

    Args:
        db: Database session
        task_id: Task ID
        status: New status string
        error_message: Optional error message
    """
    loop = asyncio.get_event_loop()

    def _update():
        task = db.query(Kind).filter(Kind.id == task_id, Kind.kind == "Task").first()
        if task:
            task_crd = Task.model_validate(task.json)
            if task_crd.status:
                task_crd.status.status = status
                task_crd.status.updatedAt = datetime.now()
                if error_message:
                    task_crd.status.errorMessage = error_message
                if status in ["COMPLETED", "FAILED", "CANCELLED"]:
                    task_crd.status.completedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            task.updated_at = datetime.now()
            db.commit()

    await loop.run_in_executor(_db_executor, _update)


@router.post("/{task_id}/stream")
async def direct_chat_stream(
    task_id: int,
    request: DirectChatRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Stream direct chat response for a task.

    This endpoint handles direct chat for Chat and Dify shell types,
    returning an SSE stream with the response.

    Args:
        task_id: The task ID
        request: Direct chat request with prompt
        current_user: Authenticated user
        db: Database session

    Returns:
        StreamingResponse with SSE-formatted chunks
    """
    # Verify task exists and belongs to user
    task = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    task_crd = Task.model_validate(task.json)

    # Get team and bot info
    team = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Team",
            Kind.name == task_crd.spec.teamRef.name,
            Kind.namespace == task_crd.spec.teamRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    team_crd = Team.model_validate(team.json)

    if not team_crd.spec.members:
        raise HTTPException(status_code=400, detail="No bots configured in team")

    # Get the first bot (for direct chat, we use the first bot)
    first_member = team_crd.spec.members[0]
    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.name == first_member.botRef.name,
            Kind.namespace == first_member.botRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")

    # Get bot shell configuration
    try:
        bot_config = _get_bot_shell_config(db, bot.id, current_user.id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get bot config: {e}")

    shell_type = bot_config["shell_type"]

    # Verify this is a direct chat shell type
    if shell_type not in DIRECT_CHAT_SHELL_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Shell type '{shell_type}' does not support direct chat. "
            f"Supported types: {DIRECT_CHAT_SHELL_TYPES}",
        )

    # Get or create the pending subtask for this task
    pending_subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.user_id == current_user.id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status == SubtaskStatus.PENDING,
        )
        .order_by(Subtask.message_id.desc())
        .first()
    )

    if not pending_subtask:
        raise HTTPException(status_code=400, detail="No pending subtask found")

    subtask_id = pending_subtask.id

    # Build configuration based on shell type
    env_config = bot_config["env_config"]
    if shell_type == "Chat":
        config = _build_chat_config(env_config)
        service = ChatDirectService(task_id, subtask_id, current_user.id)
    else:  # Dify
        config = _build_dify_config(env_config)
        service = DifyDirectService(task_id, subtask_id, current_user.id)

    async def generate():
        """Generator function for SSE streaming."""
        semaphore = get_chat_semaphore()

        try:
            async with semaphore:
                # Update statuses to RUNNING
                await _update_subtask_status_async(db, subtask_id, SubtaskStatus.RUNNING)
                await _update_task_status_async(db, task_id, "RUNNING")

                full_response = ""
                error_occurred = False
                error_msg = ""

                async for chunk in service.chat_stream(request.prompt, config):
                    yield chunk

                    # Parse chunk to accumulate response
                    if chunk.startswith("data: "):
                        try:
                            data = json.loads(chunk[6:])
                            if "content" in data:
                                full_response += data["content"]
                            elif "error" in data:
                                error_occurred = True
                                error_msg = data["error"]
                            elif data.get("cancelled"):
                                error_occurred = True
                                error_msg = "Cancelled by user"
                        except json.JSONDecodeError:
                            pass

                # Update final status
                if error_occurred:
                    await _update_subtask_status_async(
                        db, subtask_id, SubtaskStatus.FAILED, error_message=error_msg
                    )
                    await _update_task_status_async(db, task_id, "FAILED", error_msg)
                else:
                    await _update_subtask_status_async(
                        db, subtask_id, SubtaskStatus.COMPLETED, result=full_response
                    )
                    await _update_task_status_async(db, task_id, "COMPLETED")

        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'error': 'Request timeout'})}\n\n"
            await _update_subtask_status_async(
                db, subtask_id, SubtaskStatus.FAILED, error_message="Request timeout"
            )
            await _update_task_status_async(db, task_id, "FAILED", "Request timeout")

        except Exception as e:
            error_msg = str(e)
            logger.exception(f"Error in direct chat stream: {error_msg}")
            yield f"data: {json.dumps({'error': error_msg})}\n\n"
            await _update_subtask_status_async(
                db, subtask_id, SubtaskStatus.FAILED, error_message=error_msg
            )
            await _update_task_status_async(db, task_id, "FAILED", error_msg)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{task_id}/cancel")
async def cancel_direct_chat(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Cancel a running direct chat.

    Args:
        task_id: The task ID to cancel
        current_user: Authenticated user
        db: Database session

    Returns:
        Success message
    """
    # Verify task exists and belongs to user
    task = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Update task status to CANCELLED
    await _update_task_status_async(db, task_id, "CANCELLED")

    # Update any running subtasks
    running_subtasks = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.user_id == current_user.id,
            Subtask.status == SubtaskStatus.RUNNING,
        )
        .all()
    )

    for subtask in running_subtasks:
        await _update_subtask_status_async(
            db, subtask.id, SubtaskStatus.CANCELLED, error_message="Cancelled by user"
        )

    logger.info(f"Direct chat task {task_id} cancelled by user {current_user.id}")

    return {"message": "Direct chat cancelled", "task_id": task_id}


def check_all_bots_support_direct_chat(
    db: Session, team: Kind, user_id: int
) -> bool:
    """
    Check if all bots in a team support direct chat mode.

    Args:
        db: Database session
        team: Team Kind object
        user_id: User ID

    Returns:
        bool: True if all bots support direct chat
    """
    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        bot_crd = Bot.model_validate(bot.json)

        # Get shell type
        try:
            shell_info = get_shell_info_by_name(
                db, bot_crd.spec.shellRef.name, bot.user_id, bot_crd.spec.shellRef.namespace
            )
            shell_type = shell_info["shell_type"]

            if shell_type not in DIRECT_CHAT_SHELL_TYPES:
                return False
        except Exception:
            return False

    return True
