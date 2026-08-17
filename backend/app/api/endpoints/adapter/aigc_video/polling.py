# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable polling state for AIGC asynchronous cards."""

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.subtask import Subtask
from app.stores.tasks import subtask_store

AIGC_CARD_POLL_CONTEXTS_KEY = "aigc_card_polls"
TERMINAL_CARD_STATUSES = {"populated", "error", "expired"}


def create_poll_token() -> str:
    """Create a token that identifies the only valid scheduled poll."""
    return uuid.uuid4().hex


def prepare_poll_context(
    db: Session,
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    poll_count: int,
    scheduled_token: str,
) -> None:
    """Store recovery metadata in the caller's current transaction."""
    subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
    if subtask is None:
        raise ValueError(f"Subtask {subtask_id} not found")

    result = dict(subtask.result or {})
    contexts = _get_poll_contexts(result)
    contexts[str(block["card_id"])] = _build_poll_context(
        task_id=task_id,
        subtask_id=subtask_id,
        task_url=task_url,
        block=block,
        poll_count=poll_count,
        scheduled_token=scheduled_token,
    )
    result[AIGC_CARD_POLL_CONTEXTS_KEY] = contexts
    subtask_store.update_result(db, subtask=subtask, result=result)


def persist_poll_context(
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    poll_count: int,
    scheduled_token: str,
) -> None:
    """Persist recovery metadata before a Celery poll is dispatched."""
    db = SessionLocal()
    try:
        prepare_poll_context(
            db,
            task_id=task_id,
            subtask_id=subtask_id,
            task_url=task_url,
            block=block,
            poll_count=poll_count,
            scheduled_token=scheduled_token,
        )
        db.commit()
    finally:
        db.close()


def claim_poll(
    *,
    subtask_id: int,
    card_id: str,
    scheduled_token: str,
    poll_count: int,
) -> bool:
    """Claim a scheduled poll and reject tasks superseded by recovery."""
    db = SessionLocal()
    try:
        subtask = (
            db.query(Subtask).filter(Subtask.id == subtask_id).with_for_update().first()
        )
        if subtask is None:
            return False

        result = dict(subtask.result or {})
        contexts = _get_poll_contexts(result)
        context = contexts.get(card_id)
        if not _matches_poll(context, card_id, scheduled_token):
            return False

        updated = dict(context)
        updated["poll_count"] = poll_count
        updated["last_poll_at"] = _utc_now()
        contexts[card_id] = updated
        result[AIGC_CARD_POLL_CONTEXTS_KEY] = contexts
        subtask_store.update_result(db, subtask=subtask, result=result)
        db.commit()
        return True
    finally:
        db.close()


def finish_poll(
    *,
    subtask_id: int,
    card_id: str,
    scheduled_token: str,
    status: str,
    error: str = "",
) -> None:
    """Mark the current poll context terminal without touching newer work."""
    db = SessionLocal()
    try:
        subtask = (
            db.query(Subtask).filter(Subtask.id == subtask_id).with_for_update().first()
        )
        if subtask is None:
            return

        result = dict(subtask.result or {})
        contexts = _get_poll_contexts(result)
        context = contexts.get(card_id)
        if not _matches_poll(context, card_id, scheduled_token):
            return

        updated = dict(context)
        updated["status"] = status
        updated["last_poll_at"] = _utc_now()
        if error:
            updated["error"] = error
        contexts[card_id] = updated
        result[AIGC_CARD_POLL_CONTEXTS_KEY] = contexts
        subtask_store.update_result(db, subtask=subtask, result=result)
        db.commit()
    finally:
        db.close()


def find_card_block(result: Any, card_id: str) -> dict[str, Any] | None:
    """Find one persisted card block by its public card identifier."""
    if not isinstance(result, dict):
        return None
    blocks = result.get("blocks")
    if not isinstance(blocks, list):
        return None
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "card" and str(block.get("card_id")) == card_id:
            return dict(block)
    return None


def get_poll_contexts(result: Any) -> list[dict[str, Any]]:
    """Return all durable poll contexts from one subtask result."""
    if not isinstance(result, dict):
        return []
    return [dict(context) for context in _get_poll_contexts(result).values()]


def _build_poll_context(
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    poll_count: int,
    scheduled_token: str,
) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "subtask_id": subtask_id,
        "card_id": str(block["card_id"]),
        "card_type": str(block["card_type"]),
        "task_url": task_url,
        "status": "polling",
        "poll_count": poll_count,
        "scheduled_token": scheduled_token,
        "last_poll_at": _utc_now(),
    }


def _matches_poll(context: Any, card_id: str, scheduled_token: str) -> bool:
    return (
        isinstance(context, dict)
        and context.get("status") == "polling"
        and str(context.get("card_id")) == card_id
        and context.get("scheduled_token") == scheduled_token
    )


def _get_poll_contexts(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_contexts = result.get(AIGC_CARD_POLL_CONTEXTS_KEY)
    if not isinstance(raw_contexts, dict):
        return {}
    return {
        str(card_id): dict(context)
        for card_id, context in raw_contexts.items()
        if isinstance(context, dict)
    }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
