# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist and broadcast generic asynchronous card blocks."""

import asyncio
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.services.chat.storage import session_manager
from app.stores.tasks import subtask_store
from app.tasks.video_websocket import emit_chat_event_from_celery

logger = logging.getLogger(__name__)


def _merge_block(blocks: list[dict[str, Any]], block: dict[str, Any]) -> None:
    block_id = str(block["id"])
    for index, existing in enumerate(blocks):
        if str(existing.get("id")) == block_id:
            blocks[index] = {**existing, **block}
            return
    blocks.append(block)


def _run_async(coro: Any) -> Any:
    """Run one storage coroutine from a synchronous MCP or Celery worker."""
    return asyncio.run(coro)


class AsyncCardService:
    """Keep one card block consistent across DB, Redis, and WebSocket clients."""

    @staticmethod
    def persist(db: Session, subtask_id: int, block: dict[str, Any]) -> None:
        subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
        if subtask is None:
            raise ValueError(f"Subtask {subtask_id} not found")

        result = dict(subtask.result or {})
        raw_blocks = result.get("blocks")
        blocks = (
            [dict(item) for item in raw_blocks if isinstance(item, dict)]
            if isinstance(raw_blocks, list)
            else []
        )
        _merge_block(blocks, block)
        result["blocks"] = blocks
        subtask_store.update_result(db, subtask=subtask, result=result)
        db.commit()

    @staticmethod
    def cache(subtask_id: int, block: dict[str, Any]) -> None:
        _run_async(session_manager.add_block(subtask_id, dict(block)))

    @classmethod
    def create(
        cls,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        block: dict[str, Any],
    ) -> None:
        cls.persist(db, subtask_id, block)
        cls.cache(subtask_id, block)
        emit_chat_event_from_celery(
            "chat:block_created",
            {"task_id": task_id, "subtask_id": subtask_id, "block": block},
            task_id,
        )

    @classmethod
    def update(
        cls,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        block: dict[str, Any],
    ) -> None:
        cls.persist(db, subtask_id, block)
        cls.cache(subtask_id, block)
        updates = {
            key: value for key, value in block.items() if key not in {"id", "type"}
        }
        emit_chat_event_from_celery(
            "chat:block_updated",
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "block_id": str(block["id"]),
                **updates,
            },
            task_id,
        )
