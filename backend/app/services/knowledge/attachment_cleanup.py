# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort cleanup for attachments created by external Wiki sync."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Integer, cast, exists
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.knowledge.external_refresh_snapshot import (
    EXTERNAL_REFRESH_SNAPSHOT_KEY,
)

logger = logging.getLogger(__name__)

EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER = "external_wiki_sync"


@dataclass(frozen=True)
class AttachmentOrphanCleanupReport:
    scanned: int = 0
    referenced: int = 0
    deleted: int = 0
    retryable_failures: int = 0

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def mark_attachments_for_orphan_cleanup(
    db: Session,
    attachment_ids: set[int],
) -> None:
    """Mark Wiki-owned attachments without changing their references."""
    if not attachment_ids:
        return
    contexts = (
        db.query(SubtaskContext).filter(SubtaskContext.id.in_(attachment_ids)).all()
    )
    for context in contexts:
        context.type_data = {
            **(context.type_data or {}),
            "lifecycle_owner": EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER,
        }
        flag_modified(context, "type_data")


def cleanup_orphaned_knowledge_attachments(
    db: Session,
    *,
    retention_hours: int,
    batch_size: int,
    now: datetime | None = None,
) -> AttachmentOrphanCleanupReport:
    """Delete aged, explicitly Wiki-owned attachments with no document link."""
    current_time = now or datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = current_time - timedelta(hours=max(1, retention_hours))
    converted_expression = cast(
        KnowledgeDocument.source_config["converted_attachment_id"].as_string(),
        Integer,
    )
    pending_attachment_expression = cast(
        KnowledgeDocument.source_config[EXTERNAL_REFRESH_SNAPSHOT_KEY][
            "previous_attachment_id"
        ].as_string(),
        Integer,
    )
    pending_converted_expression = cast(
        KnowledgeDocument.source_config[EXTERNAL_REFRESH_SNAPSHOT_KEY][
            "previous_converted_attachment_id"
        ].as_string(),
        Integer,
    )
    candidates = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.subtask_id == 0,
            SubtaskContext.created_at < cutoff,
            SubtaskContext.type_data["lifecycle_owner"].as_string()
            == EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER,
            ~exists().where(KnowledgeDocument.attachment_id == SubtaskContext.id),
            ~exists().where(converted_expression == SubtaskContext.id),
            ~exists().where(pending_attachment_expression == SubtaskContext.id),
            ~exists().where(pending_converted_expression == SubtaskContext.id),
        )
        .order_by(SubtaskContext.id.asc())
        .limit(max(1, batch_size))
        .all()
    )
    candidate_owners = {context.id: context.user_id for context in candidates}
    candidate_ids = set(candidate_owners)
    if not candidate_ids:
        return AttachmentOrphanCleanupReport()

    direct_references = {
        attachment_id
        for (attachment_id,) in db.query(KnowledgeDocument.attachment_id)
        .filter(KnowledgeDocument.attachment_id.in_(candidate_ids))
        .all()
    }
    converted_references = {
        int(attachment_id)
        for (attachment_id,) in db.query(converted_expression)
        .filter(converted_expression.in_(candidate_ids))
        .all()
        if attachment_id is not None
    }
    pending_references = {
        int(attachment_id)
        for expression in (
            pending_attachment_expression,
            pending_converted_expression,
        )
        for (attachment_id,) in db.query(expression)
        .filter(expression.in_(candidate_ids))
        .all()
        if attachment_id is not None
    }
    referenced_ids = direct_references | converted_references | pending_references

    from app.services.context.context_service import context_service

    deleted = 0
    retryable_failures = 0
    for attachment_id, owner_user_id in candidate_owners.items():
        if attachment_id in referenced_ids:
            continue
        try:
            was_deleted = context_service.delete_context(
                db,
                attachment_id,
                owner_user_id,
                keep_row_on_storage_failure=True,
            )
        except Exception:  # noqa: BLE001 - one orphan must not block the batch
            db.rollback()
            logger.warning(
                "[Knowledge] Failed to clean up orphan attachment %s",
                attachment_id,
                exc_info=True,
            )
            retryable_failures += 1
            continue
        if was_deleted:
            deleted += 1
        else:
            retryable_failures += 1
    return AttachmentOrphanCleanupReport(
        scanned=len(candidate_ids),
        referenced=len(referenced_ids),
        deleted=deleted,
        retryable_failures=retryable_failures,
    )


def delete_attachment_best_effort(
    db: Session,
    owner_user_id: int,
    attachment_id: int,
    *,
    retry_orphan_cleanup: bool = False,
) -> None:
    """Delete one attachment owned by a knowledge document flow.

    Never raises: an attachment that cannot be deleted is logged and left
    for scoped retry when requested, because the caller's business outcome
    (index swap, failure marking, document deletion) must not be blocked by
    storage cleanup.
    """
    from app.services.context.context_service import context_service

    try:
        if retry_orphan_cleanup:
            mark_attachments_for_orphan_cleanup(db, {attachment_id})
            db.commit()
            deleted = context_service.delete_context(
                db=db,
                context_id=attachment_id,
                user_id=owner_user_id,
                keep_row_on_storage_failure=True,
            )
        else:
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
