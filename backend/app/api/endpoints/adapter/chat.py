# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Direct Chat API Endpoints

Provides SSE streaming endpoints for Chat and Dify shell types.
These endpoints bypass the Executor container for lightweight chat scenarios.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Team
from app.services.adapters.team_kinds import team_kinds_service
from app.services.chat.base import ChatShellTypes
from app.services.chat.chat_service import chat_service
from app.services.chat.dify_service import dify_service
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)

router = APIRouter()


class DirectChatRequest(BaseModel):
    """Request model for direct chat"""
    task_id: int
    subtask_id: int
    prompt: str


class CancelChatRequest(BaseModel):
    """Request model for cancelling chat"""
    task_id: int


@router.post("/stream")
async def direct_chat_stream(
    request: DirectChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Execute direct chat with streaming response.

    This endpoint handles Chat and Dify shell types directly in Backend,
    bypassing the Executor container.

    Returns:
        StreamingResponse: SSE stream of chat responses
    """
    from app.models.kind import Kind

    # Verify subtask belongs to user and get configuration
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == request.subtask_id,
            Subtask.task_id == request.task_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    if subtask.status not in [SubtaskStatus.PENDING, SubtaskStatus.COMPLETED, SubtaskStatus.FAILED]:
        raise HTTPException(
            status_code=400,
            detail=f"Subtask is in {subtask.status} state, cannot start new chat"
        )

    # Get bot configuration
    if not subtask.bot_ids:
        raise HTTPException(status_code=400, detail="No bot configured for this subtask")

    bot_id = subtask.bot_ids[0]  # Use first bot
    bot_kind = (
        db.query(Kind)
        .filter(
            Kind.id == bot_id,
            Kind.kind == "Bot",
            Kind.is_active == True,
        )
        .first()
    )

    if not bot_kind:
        raise HTTPException(status_code=404, detail="Bot not found")

    bot_crd = Bot.model_validate(bot_kind.json)

    # Get shell type
    shell_kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == bot_kind.user_id,
            Kind.kind == "Shell",
            Kind.name == bot_crd.spec.shellRef.name,
            Kind.namespace == bot_crd.spec.shellRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    # If not found in user's shells, check public shells
    if not shell_kind:
        from app.models.public_shell import PublicShell
        public_shell = (
            db.query(PublicShell)
            .filter(PublicShell.name == bot_crd.spec.shellRef.name)
            .first()
        )
        if public_shell:
            shell_crd = Shell.model_validate(public_shell.json)
        else:
            raise HTTPException(status_code=404, detail="Shell not found")
    else:
        shell_crd = Shell.model_validate(shell_kind.json)

    shell_type = shell_crd.spec.shellType

    if not ChatShellTypes.is_direct_chat_shell(shell_type):
        raise HTTPException(
            status_code=400,
            detail=f"Shell type {shell_type} does not support direct chat"
        )

    # Build configuration for chat service
    config = await _build_chat_config(db, bot_kind, bot_crd, current_user.id)

    # Update subtask status to RUNNING
    subtask.status = SubtaskStatus.RUNNING
    subtask.prompt = request.prompt
    subtask.updated_at = datetime.now()
    db.commit()

    # Select appropriate service
    if shell_type == ChatShellTypes.CHAT:
        service = chat_service
    else:
        service = dify_service

    async def generate():
        """Generate SSE stream with status updates"""
        full_response = ""
        error_occurred = False

        try:
            async for chunk in service.chat_stream(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                prompt=request.prompt,
                config=config,
            ):
                yield chunk

                # Track response for result storage
                if '"event": "message"' in chunk or '"event":"message"' in chunk:
                    import json
                    try:
                        # Parse the SSE data line
                        if chunk.startswith("data: "):
                            data = json.loads(chunk[6:].strip())
                            if data.get("content"):
                                full_response += data["content"]
                    except:
                        pass
                elif '"event": "error"' in chunk or '"event":"error"' in chunk:
                    error_occurred = True

        except asyncio.CancelledError:
            error_occurred = True
            yield service._format_error_event("Request cancelled")
        except Exception as e:
            error_occurred = True
            logger.exception(f"Error in chat stream: {e}")
            yield service._format_error_event(str(e))
        finally:
            # Update subtask status in a new session (async context)
            await _update_subtask_status_async(
                request.subtask_id,
                full_response,
                error_occurred
            )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.post("/cancel")
async def cancel_chat(
    request: CancelChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Cancel an ongoing direct chat request.

    Args:
        request: Cancel request with task_id

    Returns:
        dict: Cancellation result
    """
    # Verify task belongs to user
    from app.models.kind import Kind

    task = (
        db.query(Kind)
        .filter(
            Kind.id == request.task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Cancel both services (they share the same cancellation mechanism)
    await session_manager.set_cancelled(request.task_id)

    return {"success": True, "message": "Cancellation requested"}


async def _build_chat_config(
    db: Session,
    bot_kind: Any,
    bot_crd: Bot,
    user_id: int,
) -> Dict[str, Any]:
    """
    Build configuration dictionary for chat service.

    Args:
        db: Database session
        bot_kind: Bot Kind object
        bot_crd: Bot CRD
        user_id: Current user ID

    Returns:
        Configuration dictionary
    """
    from app.models.kind import Kind
    from app.models.public_model import PublicModel
    from app.services.model_aggregation_service import model_aggregation_service
    from app.models.user import User
    from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted

    config = {
        "api_key": "",
        "base_url": "",
        "model_id": "",
        "model": "",
        "system_prompt": "",
        "params": {},
        "bot_prompt": "",
    }

    # Get system prompt from Ghost
    ghost_kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == bot_kind.user_id,
            Kind.kind == "Ghost",
            Kind.name == bot_crd.spec.ghostRef.name,
            Kind.namespace == bot_crd.spec.ghostRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if ghost_kind:
        ghost_crd = Ghost.model_validate(ghost_kind.json)
        config["system_prompt"] = ghost_crd.spec.systemPrompt or ""

    # Get model configuration
    # Priority: agent_config.bind_model > modelRef
    model_config = {}
    bind_model = bot_crd.spec.agentConfig.get("bind_model") if bot_crd.spec.agentConfig else None

    if bind_model:
        # Resolve model by name
        user = db.query(User).filter(User.id == user_id).first()
        model_data = model_aggregation_service.resolve_model(db, user, bind_model)
        if model_data:
            model_config = model_data.get("config", {})
    elif bot_crd.spec.modelRef:
        # Legacy: get model from modelRef
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == bot_kind.user_id,
                Kind.kind == "Model",
                Kind.name == bot_crd.spec.modelRef.name,
                Kind.namespace == bot_crd.spec.modelRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if model_kind:
            model_crd = Model.model_validate(model_kind.json)
            model_config = model_crd.spec.modelConfig or {}

    # Extract API configuration from model
    env = model_config.get("env", {})
    if env:
        # Handle different key names
        api_key = env.get("api_key") or env.get("DIFY_API_KEY") or env.get("ANTHROPIC_API_KEY") or ""
        if api_key and is_data_encrypted(api_key):
            api_key = decrypt_sensitive_data(api_key) or ""
        config["api_key"] = api_key

        config["base_url"] = env.get("base_url") or env.get("DIFY_BASE_URL") or ""
        config["model_id"] = env.get("model_id") or ""
        config["model"] = env.get("model") or ""

        # Dify specific params
        if env.get("DIFY_PARAMS"):
            try:
                params_str = env.get("DIFY_PARAMS", "{}")
                config["params"] = json.loads(params_str) if isinstance(params_str, str) else params_str
            except:
                pass

    return config


async def _update_subtask_status_async(
    subtask_id: int,
    result: str,
    error: bool,
) -> None:
    """
    Update subtask status after chat completion.

    Uses run_in_executor for sync database operations.

    Args:
        subtask_id: Subtask ID
        result: Response content
        error: Whether an error occurred
    """
    from concurrent.futures import ThreadPoolExecutor
    from app.db.session import SessionLocal

    def update_status():
        db = SessionLocal()
        try:
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if subtask:
                if error:
                    subtask.status = SubtaskStatus.FAILED
                    subtask.error_message = result[:1000] if result else "Unknown error"
                else:
                    subtask.status = SubtaskStatus.COMPLETED
                    subtask.result = {"value": result}
                subtask.progress = 100
                subtask.updated_at = datetime.now()
                subtask.completed_at = datetime.now()
                db.commit()
        except Exception as e:
            logger.error(f"Failed to update subtask status: {e}")
            db.rollback()
        finally:
            db.close()

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    await loop.run_in_executor(executor, update_status)


# Need json import for config parsing
import json
