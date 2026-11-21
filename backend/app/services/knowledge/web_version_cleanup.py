# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Collect retired versions using existing attachment lifecycle records."""

import asyncio
import logging
from datetime import datetime, timezone
from time import monotonic

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import SubtaskContext
from app.services.knowledge.index_state_machine import get_document_index_lock_name
from app.services.knowledge.web_publication import candidate_is_running

logger = logging.getLogger(__name__)
CURSOR_KEY = "wegent:web-version-cleanup:cursor"


def _still_referenced(document: KnowledgeDocument | None, reference: str) -> bool:
    if document is None:
        return False
    config = document.source_config or {}
    generation = config.get("published_generation")
    published = f"{document.id}@{generation}" if generation else str(document.id)
    return reference == published or candidate_is_running(document, reference)


def cleanup_retired_versions(db: Session) -> dict:
    from app.services.context import context_service
    from app.services.rag.gateway_factory import get_rag_gateway
    from app.services.rag.runtime_specs import DeleteRuntimeSpec

    with distributed_lock.owned_watchdog_context("web-version-cleanup") as scan_lease:
        if scan_lease is None:
            return {"status": "locked"}
        redis = distributed_lock.redis_client
        cursor = int(redis.get(CURSOR_KEY) or 0)
        started = monotonic()
        maximum = max(1, settings.EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS)
        budget = max(
            1,
            min(
                settings.EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS,
                settings.KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS,
            ),
        )
        batch_size = max(1, settings.KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_BATCH_SIZE)
        scanned = cleaned = failed = protected = deferred = 0
        while (
            scanned < maximum and monotonic() - started < budget and scan_lease.owned()
        ):
            limit = min(batch_size, maximum - scanned)
            ids = [
                value
                for (value,) in db.query(SubtaskContext.id)
                .filter(
                    SubtaskContext.id > cursor,
                    SubtaskContext.type_data["lifecycle_owner"].as_string()
                    == "web_refresh",
                )
                .order_by(SubtaskContext.id)
                .limit(limit)
                .all()
            ]
            db.rollback()
            if not ids:
                cursor = 0
                break
            for attachment_id in ids:
                if monotonic() - started >= budget or not scan_lease.owned():
                    break
                cursor = attachment_id
                scanned += 1
                attachment = (
                    db.query(SubtaskContext)
                    .filter(SubtaskContext.id == attachment_id)
                    .populate_existing()
                    .first()
                )
                record = (
                    (attachment.type_data or {}).get("web_index_version")
                    if attachment
                    else None
                )
                db.rollback()
                if record is None or datetime.fromisoformat(
                    record["not_before"]
                ) > datetime.now(timezone.utc):
                    deferred += 1
                    continue
                document_id = record["document_id"]
                with distributed_lock.owned_watchdog_context(
                    get_document_index_lock_name(document_id)
                ) as lease:
                    if lease is None:
                        deferred += 1
                        continue
                    document = (
                        db.query(KnowledgeDocument)
                        .filter(KnowledgeDocument.id == document_id)
                        .populate_existing()
                        .with_for_update()
                        .first()
                    )
                    referenced = _still_referenced(document, record["doc_ref"])
                    if referenced:
                        db.rollback()
                        protected += 1
                        continue
                    if document is not None:
                        config = dict(document.source_config or {})
                        candidate = config.get("_web_refresh") or {}
                        draft = (
                            candidate
                            if candidate.get("draft")
                            else candidate.get("previous_draft") or {}
                        )
                        if (
                            draft.get("draft")
                            and draft.get("doc_ref") == record["doc_ref"]
                        ):
                            expired = {
                                **draft,
                                "expired": True,
                                "attachment_id": None,
                            }
                            config["_web_refresh"] = (
                                expired
                                if candidate.get("draft")
                                else {**candidate, "previous_draft": expired}
                            )
                            document.source_config = config
                            if not lease.owned():
                                db.rollback()
                                deferred += 1
                                continue
                            db.commit()
                    db.rollback()
                    try:
                        spec = DeleteRuntimeSpec.model_validate(
                            {
                                **record["delete_spec"],
                                "document_ref": record["doc_ref"],
                                "version_attachment_id": attachment_id,
                            }
                        )
                        result = asyncio.run(
                            get_rag_gateway().delete_document_index(spec, db=None)
                        )
                        if (
                            result.get("status") not in {"success", "deleted"}
                            or not lease.owned()
                        ):
                            raise RuntimeError("Version cleanup was not acknowledged")
                        attachment = (
                            db.query(SubtaskContext)
                            .filter(SubtaskContext.id == attachment_id)
                            .populate_existing()
                            .first()
                        )
                        if attachment is not None:
                            for derived_id in record.get("retired_attachments", []):
                                derived = db.get(SubtaskContext, derived_id)
                                if (
                                    derived is not None
                                    and not context_service.delete_context(
                                        db,
                                        derived_id,
                                        derived.user_id,
                                        keep_row_on_storage_failure=True,
                                    )
                                ):
                                    raise RuntimeError(
                                        "Derived attachment cleanup was not acknowledged"
                                    )
                            deleted = context_service.delete_context(
                                db,
                                attachment_id,
                                attachment.user_id,
                                keep_row_on_storage_failure=True,
                            )
                            if not deleted:
                                raise RuntimeError(
                                    "Attachment cleanup was not acknowledged"
                                )
                        cleaned += 1
                    except Exception:
                        db.rollback()
                        logger.warning(
                            "Retired version retained for retry: document_id=%s version=%s",
                            document_id,
                            record["doc_ref"],
                            exc_info=True,
                        )
                        failed += 1
            if cursor != ids[-1]:
                break
            if len(ids) < limit:
                cursor = 0
                break
        if scan_lease.owned():
            redis.set(CURSOR_KEY, cursor, ex=8 * 86400)
        report = {
            "scanned": scanned,
            "cleaned": cleaned,
            "failed": failed,
            "protected": protected,
            "deferred": deferred,
            "next_cursor": cursor,
        }
        logger.info("Web version cleanup completed: %s", report)
        return report
