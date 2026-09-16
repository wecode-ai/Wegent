# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Daily refresh of explicitly enabled knowledge-base copies."""

import asyncio
import logging

from sqlalchemy.orm import Session

from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentFetchError,
    get_external_document_provider,
)
from app.services.knowledge.index_state_machine import (
    ACTIVE_INDEX_STATUSES,
    begin_external_import_attempt,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)


def _eligible_copy(
    db: Session, document_id: int, expected_generation: int
) -> tuple[KnowledgeDocument, User] | None:
    """Resolve current settings and the original importer permission."""
    document = db.get(KnowledgeDocument, document_id, populate_existing=True)
    if (
        document is None
        or document.external_provider != "dingtalk"
        or document.index_generation != expected_generation
        or document.index_status in ACTIVE_INDEX_STATUSES
    ):
        return None
    user = db.get(User, document.user_id)
    if user is None or not user.is_active:
        return None
    kb, has_access = KnowledgeService.get_knowledge_base(db, document.kind_id, user.id)
    if (
        not kb
        or not has_access
        or not kb.json.get("spec", {}).get("dingtalkAutoSyncEnabled", False)
        or not KnowledgeService.can_manage_knowledge_base_documents(
            db, document.kind_id, user.id
        )
    ):
        return None

    return document, user


@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy(
    db: Session, document_id: int, expected_generation: int
) -> bool:
    """Probe before invalidating a copy, then reuse the existing import pipeline."""
    context = _eligible_copy(db, document_id, expected_generation)
    if context is None:
        return False
    document, user = context
    provider = get_external_document_provider("dingtalk")
    try:
        update_time = asyncio.run(
            provider.get_update_time(user, document.external_resource_id)
        )
    except ExternalDocumentFetchError:
        logger.warning("DingTalk timestamp probe failed for document %s", document_id)
        return False
    # End the snapshot held across provider I/O before checking a concurrent update.
    db.rollback()
    context = _eligible_copy(db, document_id, expected_generation)
    if context is None:
        return False
    document, user = context
    if (
        update_time is not None
        and document.index_status == DocumentIndexStatus.SUCCESS
        and document.is_active
        and document.attachment_id
        and document.external_source_config.get("source_update_time") == update_time
    ):
        return False
    metadata = {
        "provider": "dingtalk",
        "resource_id": document.external_resource_id,
        "title": document.external_source_config.get("title") or document.name,
        "url": document.external_source_config.get("url", ""),
        "source_update_time": update_time,
    }
    result = external_document_import_service.refresh_existing_document(
        db, document, metadata, dispatch=False, expected_generation=expected_generation
    )
    if not result.started:
        return False
    attempt = begin_external_import_attempt(db, document_id, document.index_generation)
    if not attempt.should_execute:
        return False
    run_external_document_import(
        db, document, user, generation=attempt.generation, source_metadata=metadata
    )
    return True
