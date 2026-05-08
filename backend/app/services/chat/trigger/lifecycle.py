# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared execution lifecycle helpers for chat and responses surfaces."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Team
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    create_assistant_subtask,
    create_new_task,
    create_user_subtask,
    get_bot_ids_from_team,
    get_task_with_access_check,
)
from app.services.readers.kinds import KindType, kindReader

logger = logging.getLogger(__name__)


@dataclass
class ExecutionSessionSetup:
    """Unified session setup result used before execution request building."""

    task: TaskResource
    task_id: int
    user_subtask: Subtask
    assistant_subtask: Subtask
    existing_subtasks: List[Subtask]
    bot_ids: List[int]
    bot_name: str
    bot_namespace: str
    subtask_user_id: int


def prepare_execution_session(
    db: Session,
    user: User,
    team: Kind,
    input_text: str,
    model_info: Dict[str, Any],
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    source: str = "chat_shell",
    is_api_call: bool = False,
    api_key_name: Optional[str] = None,
) -> ExecutionSessionSetup:
    """Create or reuse task/session state before building an execution request."""

    team_crd = Team.model_validate(team.json)
    if not team_crd.spec.members:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Team has no members configured",
        )

    bot_ids = get_bot_ids_from_team(db, team)

    first_bot_name = ""
    first_bot_namespace = "default"
    for member in team_crd.spec.members:
        member_bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if member_bot:
            first_bot_name = member.botRef.name
            first_bot_namespace = member.botRef.namespace
            break

    if not first_bot_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid bots found in team",
        )

    workspace_data = tool_settings.get("workspace") or {}
    task = None
    subtask_user_id = user.id

    if task_id:
        task, subtask_user_id = get_task_with_access_check(db, task_id, user.id)
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

    if not task:
        params = TaskCreationParams(
            message=input_text,
            model_id=model_info.get("model_id"),
            force_override_bot_model=model_info.get("model_id") is not None,
            git_url=workspace_data.get("git_url"),
            git_repo=workspace_data.get("git_repo"),
            git_domain=workspace_data.get("git_domain"),
            branch_name=workspace_data.get("branch"),
            task_type="code" if workspace_data.get("git_url") else "chat",
            source=source,
            is_api_call=is_api_call,
            api_key_name=api_key_name,
        )
        task = create_new_task(db, user, team, params)
        subtask_user_id = user.id

    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task.id, Subtask.user_id == subtask_user_id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    user_subtask = create_user_subtask(
        db=db,
        subtask_user_id=subtask_user_id,
        sender_user_id=user.id,
        task_id=task.id,
        team_id=team.id,
        bot_ids=bot_ids,
        message=input_text,
        next_message_id=next_message_id,
        parent_id=parent_id,
    )
    assistant_subtask = create_assistant_subtask(
        db=db,
        subtask_user_id=subtask_user_id,
        task_id=task.id,
        team_id=team.id,
        bot_ids=bot_ids,
        next_message_id=next_message_id + 1,
        parent_id=next_message_id,
    )

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    db.refresh(assistant_subtask)

    return ExecutionSessionSetup(
        task=task,
        task_id=task.id,
        user_subtask=user_subtask,
        assistant_subtask=assistant_subtask,
        existing_subtasks=existing_subtasks,
        bot_ids=bot_ids,
        bot_name=first_bot_name,
        bot_namespace=first_bot_namespace,
        subtask_user_id=subtask_user_id,
    )


async def _get_existing_subtask_result(subtask_id: int) -> Dict[str, Any]:
    """Load the stored subtask result so we can preserve existing fields."""
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask

    db = SessionLocal()
    try:
        subtask = db.get(Subtask, subtask_id)
        if subtask and isinstance(subtask.result, dict):
            return dict(subtask.result)
        return {}
    except Exception as exc:
        logger.warning(
            "[CompletedResult] Failed to load existing subtask result for %s: %s",
            subtask_id,
            exc,
        )
        return {}
    finally:
        db.close()


async def collect_completed_result(
    subtask_id: int,
    *,
    status: str,
    result: Optional[Dict[str, Any]] = None,
    error_message: Optional[str] = None,
    error_code: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Collect the final terminal result payload for a subtask."""
    import app.services.chat.storage as chat_storage

    normalized_status = status.upper()

    accumulated_content = await chat_storage.session_manager.get_accumulated_content(
        subtask_id
    )
    blocks = await chat_storage.session_manager.finalize_and_get_blocks(subtask_id)
    existing_result = await _get_existing_subtask_result(subtask_id)

    if result is not None and not isinstance(result, dict):
        logger.warning(
            "[CompletedResult] Ignoring non-dict runtime result for subtask %s: %s",
            subtask_id,
            type(result).__name__,
        )

    runtime_result = dict(result) if isinstance(result, dict) else {}

    has_payload = bool(
        runtime_result
        or existing_result
        or accumulated_content
        or blocks
        or normalized_status == "COMPLETED"
        or (normalized_status == "FAILED" and error_code)
    )
    if not has_payload:
        return None

    final_result: Dict[str, Any] = dict(runtime_result)

    for key, value in existing_result.items():
        current_value = final_result.get(key)
        if (
            key not in final_result
            or current_value is None
            or (key == "blocks" and not current_value)
        ):
            final_result[key] = value

    if final_result.get("value") is None and (
        normalized_status == "COMPLETED" or accumulated_content
    ):
        final_result["value"] = accumulated_content

    if blocks and not final_result.get("blocks"):
        final_result["blocks"] = blocks
        logger.info(
            "[CompletedResult] Added %d blocks to %s result for subtask %s",
            len(blocks),
            normalized_status.lower(),
            subtask_id,
        )

    if normalized_status == "FAILED" and error_code:
        final_result["error_type"] = error_code

        from shared.utils.error_classifier import extract_http_status_code

        http_code = extract_http_status_code(error_message or "")
        if http_code is not None:
            final_result["error_code"] = http_code

    return final_result


async def persist_completed_result(
    *,
    subtask_id: int,
    task_id: int,
    status: str,
    result: Optional[Dict[str, Any]],
    error: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> None:
    """Persist a terminal result and clean up streaming state."""
    import app.services.chat.storage as chat_storage
    import app.services.chat.storage.db as chat_db

    normalized_status = status.upper()

    try:
        await chat_db.db_handler.update_subtask_status(
            subtask_id,
            normalized_status,
            result=result,
            error=error,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )
    finally:
        try:
            await chat_storage.session_manager.cleanup_streaming_state(
                subtask_id,
                task_id=task_id,
            )
        except Exception as exc:
            logger.warning(
                "[CompletedResult] Failed to cleanup streaming state for subtask %s: %s",
                subtask_id,
                exc,
                exc_info=True,
            )


__all__ = [
    "ExecutionSessionSetup",
    "prepare_execution_session",
    "collect_completed_result",
    "persist_completed_result",
]
