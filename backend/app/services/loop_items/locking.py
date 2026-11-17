# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared lock order for Issue mutations, executions and activity projection."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem


def lock_existing_issue(db: Session, item_id: str | None) -> None:
    """Lock Issue before execution/activity rows without locking missing-key gaps."""
    if not item_id:
        return
    with db.no_autoflush:
        candidate = db.query(LoopItem.id).filter(LoopItem.id == item_id).first()
        if candidate is not None:
            db.query(LoopItem.id).filter(
                LoopItem.id == candidate.id
            ).with_for_update().first()
