# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Correction service implementation.

Provides business logic for AI correction functionality.
"""

import logging
from datetime import datetime
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus

logger = logging.getLogger(__name__)


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

    # Get all subtasks before this message
    previous_subtasks = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.message_id < before_message_id,
            Subtask.status == SubtaskStatus.COMPLETED,
        )
        .order_by(Subtask.message_id.asc())
        .all()
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


async def evaluate_and_save_correction(
    db: Session,
    subtask: Subtask,
    original_question: str,
    original_answer: str,
    model_config: dict,
    correction_model_id: str,
    history: Optional[list[dict[str, str]]] = None,
    tools: Optional[list] = None,
    on_progress: Optional[Callable[[str, Optional[str]], Any]] = None,
    on_chunk: Optional[Callable[[str, str, int], Any]] = None,
) -> dict:
    """
    Evaluate and save correction for a subtask.

    Args:
        db: Database session
        subtask: The subtask to correct
        original_question: Original user question
        original_answer: Original AI answer
        model_config: Model configuration dict
        correction_model_id: ID of the correction model
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

    # Get model display name for persistence
    model_display_name = model_config.get("model_id", correction_model_id)

    # Save correction to subtask.result for persistence
    subtask_result = subtask.result or {}
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

    subtask.result = subtask_result
    flag_modified(subtask, "result")
    db.commit()

    logger.info(f"Saved correction result for subtask {subtask.id} to database")

    return llm_result


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
        subtask.result = result
        flag_modified(subtask, "result")
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

    subtask.result = subtask_result
    flag_modified(subtask, "result")
    db.commit()

    logger.info(f"Applied correction for subtask {subtask.id}")

    return original_value
