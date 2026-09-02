# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Correction service implementation.

Provides business logic for AI correction functionality.
"""

import copy
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole
from app.stores.tasks import subtask_store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CorrectionPreparation:
    """Detached correction inputs loaded before the model call starts."""

    subtask_id: int
    message_id: int
    existing_correction: Optional[dict[str, Any]]
    model_config: dict[str, Any]
    history: list[dict[str, str]]


def _prepare_correction_sync(
    user_id: int,
    user_name: str,
    task_id: int,
    message_id: int,
    correction_model_id: str,
    force_retry: bool,
) -> CorrectionPreparation:
    """Validate and snapshot one correction request in a worker-owned session."""
    from fastapi import HTTPException

    from app.models.task import TaskResource
    from app.services.chat.config.model_resolver import (
        _find_model,
        extract_and_process_model_config,
    )
    from app.services.chat.storage.db import get_db_session
    from app.stores.tasks import task_access_store, task_store

    with get_db_session() as db:
        task = task_store.get_owned_task_by_state(
            db,
            task_id=task_id,
            user_id=user_id,
            state=TaskResource.STATE_ACTIVE,
        )
        if not task and not task_access_store.is_member(
            db,
            task_id=task_id,
            user_id=user_id,
        ):
            raise HTTPException(status_code=404, detail="Task not found")

        subtask = subtask_store.get_by_id(db, subtask_id=message_id)
        if (
            not subtask
            or subtask.task_id != task_id
            or subtask.role != SubtaskRole.ASSISTANT
        ):
            raise HTTPException(status_code=404, detail="AI message not found")

        existing_correction = copy.deepcopy(get_existing_correction(subtask))
        if existing_correction and not force_retry:
            return CorrectionPreparation(
                subtask_id=subtask.id,
                message_id=subtask.message_id,
                existing_correction=existing_correction,
                model_config={},
                history=[],
            )

        model_spec = _find_model(db, correction_model_id, user_id)
        if not model_spec:
            raise HTTPException(
                status_code=400,
                detail=f"Correction model '{correction_model_id}' not found",
            )

        return CorrectionPreparation(
            subtask_id=subtask.id,
            message_id=subtask.message_id,
            existing_correction=existing_correction,
            model_config=copy.deepcopy(
                extract_and_process_model_config(
                    model_spec=model_spec,
                    user_id=user_id,
                    user_name=user_name,
                )
            ),
            history=build_chat_history(db, task_id, subtask.message_id),
        )


async def prepare_correction(
    *,
    user_id: int,
    user_name: str,
    task_id: int,
    message_id: int,
    correction_model_id: str,
    force_retry: bool,
) -> CorrectionPreparation:
    """Load correction inputs without retaining a request Session."""
    from app.services.chat.storage.db import run_sync_in_executor

    return await run_sync_in_executor(
        _prepare_correction_sync,
        user_id,
        user_name,
        task_id,
        message_id,
        correction_model_id,
        force_retry,
    )


def get_existing_correction(subtask: Subtask) -> Optional[dict]:
    """
    Get existing correction from subtask result.

    Args:
        subtask: The subtask to check

    Returns:
        Correction dict if exists, None otherwise
    """
    result = subtask.result or {}
    if isinstance(result, dict):
        return result.get("correction")
    return None


def build_chat_history(
    db: Session,
    task_id: int,
    before_message_id: int,
) -> list[dict[str, str]]:
    """
    Build chat history from previous subtasks.

    Args:
        db: Database session
        task_id: Task ID
        before_message_id: Message ID to get history before

    Returns:
        List of chat history messages
    """
    history: list[dict[str, str]] = []

    if before_message_id <= 1:
        return history

    previous_subtasks = subtask_store.list_completed_before_message_id(
        db,
        task_id=task_id,
        before_message_id=before_message_id,
    )

    for prev_subtask in previous_subtasks:
        if prev_subtask.role == SubtaskRole.USER:
            history.append({"role": "user", "content": prev_subtask.prompt or ""})
        elif prev_subtask.role == SubtaskRole.ASSISTANT:
            # Extract content from result
            content = ""
            if prev_subtask.result:
                if isinstance(prev_subtask.result, dict):
                    content = prev_subtask.result.get("value", "")
                elif isinstance(prev_subtask.result, str):
                    content = prev_subtask.result
            history.append({"role": "assistant", "content": content})

    logger.info(f"Built chat history with {len(history)} messages for task {task_id}")

    return history


async def evaluate_correction(
    *,
    original_question: str,
    original_answer: str,
    model_config: dict[str, Any],
    history: Optional[list[dict[str, str]]] = None,
    tools: Optional[list] = None,
    on_progress: Optional[Callable[[str, Optional[str]], Any]] = None,
    on_chunk: Optional[Callable[[str, str, int], Any]] = None,
) -> dict:
    """
    Evaluate one correction without retaining database state across the model call.

    Args:
        original_question: Original user question
        original_answer: Original AI answer
        model_config: Model configuration dict
        history: Optional chat history
        tools: Optional tools for correction
        on_progress: Optional progress callback
        on_chunk: Optional chunk callback

    Returns:
        Correction result dict
    """
    from app.services.correction_service import correction_service

    # Call correction service with progress callbacks
    llm_result = await correction_service.evaluate_response_with_progress(
        original_question=original_question,
        original_answer=original_answer,
        model_config=model_config,
        history=history,
        tools=tools,
        on_progress=on_progress,
        on_chunk=on_chunk,
    )

    return llm_result


def _save_correction_sync(
    subtask_id: int,
    correction_model_id: str,
    model_display_name: str,
    llm_result: dict[str, Any],
) -> None:
    """Reload and update the subtask inside one database worker."""
    from app.services.chat.storage.db import get_db_session

    llm_result = copy.deepcopy(llm_result)
    with get_db_session() as db:
        subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
        if subtask is None:
            raise RuntimeError("Correction target no longer exists")
        subtask_result = copy.deepcopy(subtask.result or {})
        if not isinstance(subtask_result, dict):
            subtask_result = {}
        subtask_result["correction"] = {
            "model_id": correction_model_id,
            "model_name": model_display_name,
            "scores": llm_result["scores"],
            "corrections": llm_result["corrections"],
            "summary": llm_result["summary"],
            "improved_answer": llm_result["improved_answer"],
            "is_correct": llm_result["is_correct"],
            "corrected_at": datetime.utcnow().isoformat() + "Z",
        }
        subtask_store.update_result(db, subtask=subtask, result=subtask_result)
        db.commit()
        logger.info("Saved correction result for subtask %s", subtask.id)


async def save_correction(
    *,
    subtask_id: int,
    correction_model_id: str,
    model_config: dict[str, Any],
    llm_result: dict[str, Any],
) -> None:
    """Persist a completed correction in the shared bounded DB executor."""
    from app.services.chat.storage.db import run_sync_in_executor

    await run_sync_in_executor(
        _save_correction_sync,
        subtask_id,
        correction_model_id,
        str(model_config.get("model_id", correction_model_id)),
        llm_result,
    )


def delete_correction_from_subtask(db: Session, subtask: Subtask) -> bool:
    """
    Delete correction data from a subtask.

    Args:
        db: Database session
        subtask: The subtask to delete correction from

    Returns:
        True if correction was deleted, False if no correction existed
    """
    result = subtask.result or {}
    if isinstance(result, dict) and "correction" in result:
        del result["correction"]
        subtask_store.update_result(db, subtask=subtask, result=result)
        db.commit()
        logger.info(f"Deleted correction for subtask {subtask.id}")
        return True
    return False


def apply_correction_to_subtask(
    db: Session,
    subtask: Subtask,
    improved_answer: str,
) -> str:
    """
    Apply the improved answer from correction to replace the AI message content.

    Args:
        db: Database session
        subtask: The subtask to apply correction to
        improved_answer: The improved answer to apply

    Returns:
        The original value before replacement
    """
    subtask_result = subtask.result or {}
    if not isinstance(subtask_result, dict):
        subtask_result = {}

    # Store the original value before replacement (for potential undo)
    original_value = subtask_result.get("value", "")

    # Update the value with improved answer
    subtask_result["value"] = improved_answer

    # Mark correction as applied and store original value
    if "correction" in subtask_result:
        subtask_result["correction"]["applied"] = True
        subtask_result["correction"]["applied_at"] = datetime.utcnow().isoformat() + "Z"
        subtask_result["correction"]["original_value"] = original_value

    subtask_store.update_result(db, subtask=subtask, result=subtask_result)
    db.commit()

    logger.info(f"Applied correction for subtask {subtask.id}")

    return original_value
