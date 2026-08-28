# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort attachment cleanup shared by the knowledge import flows."""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def delete_attachment_best_effort(
    db: Session,
    owner_user_id: int,
    attachment_id: int,
) -> None:
    """Delete one attachment owned by a knowledge document flow.

    Never raises: an attachment that cannot be deleted is logged and left
    for orphan cleanup, because the caller's business outcome (index swap,
    failure marking, document deletion) must not be blocked by storage
    cleanup.
    """
    from app.services.context.context_service import context_service

    try:
        deleted = context_service.delete_context(
            db=db,
            context_id=attachment_id,
            user_id=owner_user_id,
        )
        if deleted:
            logger.info("[Knowledge] Deleted attachment %s", attachment_id)
        else:
            logger.warning(
                "[Knowledge] Attachment %s could not be deleted; left for "
                "orphan cleanup",
                attachment_id,
            )
    except Exception as exc:  # noqa: BLE001 - cleanup must remain best-effort
        logger.warning(
            "[Knowledge] Failed to delete attachment %s: %s; left for orphan "
            "cleanup",
            attachment_id,
            exc,
        )
