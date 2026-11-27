# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Python consumers for Rust-dispatched web maintenance; no second cron."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from math import ceil
from random import uniform

from celery.utils.time import maybe_iso8601

from app.core.celery_app import celery_app
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.knowledge.web_refresh import (
    WebRefreshBusy,
    WebRefreshDomainBusy,
    refresh_web_document,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)


@celery_app.task(
    bind=True,
    name="app.tasks.web_auto_update_tasks.refresh_web_document",
    max_retries=settings.KNOWLEDGE_INDEX_LOCK_MAX_RETRIES,
    default_retry_delay=settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS,
)
@trace_sync(span_name="knowledge.web_auto_refresh", tracer_name="knowledge.tasks")
def refresh_web_document_task(
    self, document_id: int, expected_generation: int, document_lock_retries: int = 0
):
    if not settings.WEB_AUTO_UPDATE_SCHEDULE_ENABLED:
        return {"status": "disabled"}
    try:
        with SessionLocal() as db:
            document = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .first()
            )
            if document is None or document.index_generation != expected_generation:
                return {"status": "skipped", "reason": "stale_or_deleted"}
            user = (
                db.query(User)
                .filter(User.id == document.user_id, User.is_active.is_(True))
                .first()
            )
            if user is None:
                return {"status": "skipped", "reason": "owner_unavailable"}
            result = asyncio.run(
                refresh_web_document(
                    db,
                    user,
                    document_id,
                    automatic=True,
                    expected_generation=expected_generation,
                )
            )
            # Celery's JSON result backend cannot serialize a Pydantic model.
            return {
                "status": "accepted" if result["success"] else "skipped",
                "document_id": document_id,
                "reason": result["error_code"],
            }
    except WebRefreshBusy as exc:
        retry_options = {}
        delay = self.default_retry_delay
        if isinstance(exc, WebRefreshDomainBusy):
            # Keep the original scan message deadline across retries. Domain
            # contention is a queue of different documents, not a duplicate job.
            now = datetime.now(timezone.utc)
            deadline = self.request.expires or now + timedelta(days=1)
            if isinstance(deadline, str):
                deadline = maybe_iso8601(deadline)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            base_delay = max(1, delay)
            delay = min(300, base_delay * 2 ** min(self.request.retries, 8))
            delay += uniform(0, min(base_delay, 15))
            if now + timedelta(seconds=delay) >= deadline:
                return {"status": "skipped", "reason": "domain_wait_expired"}
            retry_options = {
                "expires": deadline,
                "max_retries": ceil(86400 / base_delay),
            }
        elif document_lock_retries >= self.max_retries:
            logger.info("Web refresh busy retry exhausted: document_id=%s", document_id)
            return {"status": "skipped", "reason": "busy_retry_exhausted"}
        else:
            document_lock_retries += 1
            retry_options["max_retries"] = self.request.retries + self.max_retries
        raise self.retry(
            exc=exc,
            countdown=delay,
            **retry_options,
            kwargs={
                "document_id": document_id,
                "document_lock_retries": document_lock_retries,
                "expected_generation": (
                    exc.generation
                    if exc.generation is not None
                    else expected_generation
                ),
            },
        )
    except ValueError:
        # Permission/switch/source changes invalidate this scheduled observation.
        logger.info(
            "Web refresh invalidated: document_id=%s generation=%s",
            document_id,
            expected_generation,
        )
        return {"status": "skipped", "reason": "source_or_access_changed"}


@celery_app.task(name="app.tasks.web_auto_update_tasks.cleanup_retired_versions")
@trace_sync(span_name="knowledge.web_version_cleanup", tracer_name="knowledge.tasks")
def cleanup_retired_versions_task():
    from app.services.knowledge.web_version_cleanup import cleanup_retired_versions

    with SessionLocal() as db:
        return cleanup_retired_versions(db)
