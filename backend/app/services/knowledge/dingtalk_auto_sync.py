# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Daily refresh of explicitly enabled knowledge-base copies."""

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.index_state_machine import (
    ACTIVE_INDEX_STATUSES,
    begin_external_import_attempt,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from shared.telemetry.decorators import trace_sync


@trace_sync(tracer_name="knowledge.auto_sync")
def refresh_dingtalk_copy(
    db: Session, document_id: int, expected_generation: int
) -> bool:
    """Recheck eligibility when the queued job executes and reuse import processing."""
    document = db.get(KnowledgeDocument, document_id)
    if (
        document is None
        or document.external_provider != "dingtalk"
        or document.index_generation != expected_generation
        or document.index_status in ACTIVE_INDEX_STATUSES
    ):
        return False
    user = db.get(User, document.user_id)
    if user is None or not user.is_active:
        return False
    kb, has_access = KnowledgeService.get_knowledge_base(db, document.kind_id, user.id)
    if (
        not kb
        or not has_access
        or not kb.json.get("spec", {}).get("dingtalkAutoSyncEnabled", False)
        or not KnowledgeService.can_manage_knowledge_base_documents(
            db, document.kind_id, user.id
        )
    ):
        return False

    metadata = {
        "provider": "dingtalk",
        "resource_id": document.external_resource_id,
        "title": document.external_source_config.get("title") or document.name,
        "url": document.external_source_config.get("url", ""),
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
