# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Publish Xiaoxin's fixed HR resource into one configured knowledge base."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentImportError,
)
from app.services.knowledge.indexing import extract_rag_config_from_knowledge_base
from app.services.knowledge.xiaoxin import (
    XIAOXIN_HR_RESOURCE_ID,
    XIAOXIN_PROVIDER_ID,
)
from shared.telemetry.decorators import set_span_attribute, trace_sync

logger = logging.getLogger(__name__)

XiaoxinSyncTrigger = Literal["notification", "daily"]

_DAILY_REQUIRED_SETTINGS = {
    "XIAOXIN_KNOWLEDGE_PULL_URL": lambda: settings.XIAOXIN_KNOWLEDGE_PULL_URL,
    "XIAOXIN_SIGN_SECRET": lambda: settings.XIAOXIN_SIGN_SECRET,
    "XIAOXIN_TARGET_KB_ID": lambda: settings.XIAOXIN_TARGET_KB_ID,
    "XIAOXIN_SYNC_USER_ID": lambda: settings.XIAOXIN_SYNC_USER_ID,
}


class XiaoxinSyncError(RuntimeError):
    """A notification could not be submitted to the fixed import path."""

    def __init__(
        self,
        message: str,
        status_code: int = status.HTTP_503_SERVICE_UNAVAILABLE,
        *,
        stage: str = "configuration",
        error_code: str = "xiaoxin_sync_failed",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.stage = stage
        self.error_code = error_code


@dataclass(frozen=True)
class XiaoxinSyncSubmission:
    """The document attempt accepted by the external import state machine."""

    knowledge_base_id: int
    document: KnowledgeDocument


def get_xiaoxin_daily_sync_skip_reason() -> str | None:
    """Return a safe reason when the daily task must have no side effects."""
    if not settings.XIAOXIN_SYNC_ENABLED:
        return "sync_disabled"

    missing = [
        name
        for name, read_value in _DAILY_REQUIRED_SETTINGS.items()
        if not _configured(read_value())
    ]
    if missing:
        return f"missing_configuration:{','.join(missing)}"
    return None


def _configured(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, int):
        return value > 0
    return bool(value)


def _require_sync_configuration() -> None:
    if not settings.XIAOXIN_SYNC_ENABLED:
        raise XiaoxinSyncError(
            "Xiaoxin knowledge sync is disabled",
            error_code="xiaoxin_sync_disabled",
        )

    if not all(
        (
            settings.XIAOXIN_TARGET_KB_ID > 0,
            settings.XIAOXIN_SYNC_USER_ID > 0,
        )
    ):
        raise XiaoxinSyncError(
            "Xiaoxin knowledge sync target is not configured",
            error_code="xiaoxin_target_config_incomplete",
        )


def _resolve_fixed_target(db: Session) -> Kind:
    target = (
        db.query(Kind)
        .filter(
            Kind.id == settings.XIAOXIN_TARGET_KB_ID,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .one_or_none()
    )
    if target is None:
        raise XiaoxinSyncError(
            "Xiaoxin target knowledge base could not be resolved",
            stage="target_resolution",
            error_code="xiaoxin_target_not_resolved",
        )
    return target


def _resolve_sync_user(db: Session) -> User:
    user = (
        db.query(User)
        .filter(
            User.id == settings.XIAOXIN_SYNC_USER_ID,
            User.is_active.is_(True),
        )
        .one_or_none()
    )
    if user is None:
        raise XiaoxinSyncError(
            "Xiaoxin sync user is unavailable",
            stage="sync_user_resolution",
            error_code="xiaoxin_sync_user_unavailable",
        )
    return user


def _validate_target_rag_configuration(
    db: Session,
    target: Kind,
    user: User,
) -> None:
    if extract_rag_config_from_knowledge_base(db, target, user.id) is None:
        raise XiaoxinSyncError(
            "Xiaoxin target knowledge base has no RAG configuration",
            stage="import_context",
            error_code="xiaoxin_target_rag_missing",
        )


def _dispatch_failed(document: KnowledgeDocument) -> bool:
    if document.index_status != DocumentIndexStatus.FAILED:
        return False
    error = document.processing_error_payload or {}
    return error.get("code") == "external_import_dispatch_failed"


@trace_sync(
    span_name="knowledge.xiaoxin_hr_sync.submit",
    tracer_name="knowledge.sync",
    extract_attributes=lambda db, *, trigger_source="notification": {
        "knowledge.trigger_source": trigger_source,
        "knowledge.domain": XIAOXIN_HR_RESOURCE_ID,
    },
)
def submit_xiaoxin_hr_sync(
    db: Session,
    *,
    trigger_source: XiaoxinSyncTrigger = "notification",
) -> XiaoxinSyncSubmission:
    """Resolve the fixed target and submit or reuse its HR import attempt."""
    started_at = time.perf_counter()
    try:
        submission, dispatch_elapsed_ms = _submit_to_fixed_target(db)
    except XiaoxinSyncError as exc:
        _log_sync_failure(exc, trigger_source, started_at)
        raise
    except Exception:
        error = XiaoxinSyncError(
            "Xiaoxin knowledge sync submission failed",
            stage="submission",
            error_code="xiaoxin_sync_internal_error",
        )
        _log_sync_failure(error, trigger_source, started_at)
        raise

    _log_sync_success(submission, trigger_source, started_at, dispatch_elapsed_ms)
    return submission


def _submit_to_fixed_target(
    db: Session,
) -> tuple[XiaoxinSyncSubmission, float]:
    _require_sync_configuration()
    target = _resolve_fixed_target(db)
    user = _resolve_sync_user(db)
    _validate_target_rag_configuration(db, target, user)

    dispatch_started_at = time.perf_counter()
    try:
        document = external_document_import_service.import_document(
            db=db,
            user=user,
            knowledge_base_id=target.id,
            provider_id=XIAOXIN_PROVIDER_ID,
            external_resource_id=XIAOXIN_HR_RESOURCE_ID,
        )
    except ExternalDocumentImportError as exc:
        raise XiaoxinSyncError(
            str(exc),
            status_code=exc.status_code,
            stage="dispatch",
            error_code="xiaoxin_import_rejected",
        ) from exc
    dispatch_elapsed_ms = round((time.perf_counter() - dispatch_started_at) * 1000, 3)
    if _dispatch_failed(document):
        raise XiaoxinSyncError(
            "Xiaoxin knowledge sync could not be dispatched",
            stage="dispatch",
            error_code="external_import_dispatch_failed",
        )
    return (
        XiaoxinSyncSubmission(knowledge_base_id=target.id, document=document),
        dispatch_elapsed_ms,
    )


def _log_sync_success(
    submission: XiaoxinSyncSubmission,
    trigger_source: XiaoxinSyncTrigger,
    started_at: float,
    dispatch_elapsed_ms: float,
) -> None:
    document = submission.document
    total_elapsed_ms = round((time.perf_counter() - started_at) * 1000, 3)
    set_span_attribute("knowledge.knowledge_base_id", submission.knowledge_base_id)
    set_span_attribute("knowledge.document_id", document.id)
    set_span_attribute("knowledge.index_generation", document.index_generation)
    set_span_attribute("knowledge.dispatch_elapsed_ms", dispatch_elapsed_ms)
    set_span_attribute("knowledge.total_elapsed_ms", total_elapsed_ms)
    logger.info(
        "Xiaoxin HR knowledge sync submitted",
        extra={
            "trigger_source": trigger_source,
            "domain": XIAOXIN_HR_RESOURCE_ID,
            "knowledge_base_id": submission.knowledge_base_id,
            "document_id": document.id,
            "index_generation": document.index_generation,
            "index_status": document.index_status.value,
            "dispatch_elapsed_ms": dispatch_elapsed_ms,
            "total_elapsed_ms": total_elapsed_ms,
        },
    )


def _log_sync_failure(
    error: XiaoxinSyncError,
    trigger_source: XiaoxinSyncTrigger,
    started_at: float,
) -> None:
    elapsed_ms = round((time.perf_counter() - started_at) * 1000, 3)
    set_span_attribute("knowledge.failure_stage", error.stage)
    set_span_attribute("knowledge.error_code", error.error_code)
    set_span_attribute("knowledge.total_elapsed_ms", elapsed_ms)
    logger.error(
        "Xiaoxin HR knowledge sync submission failed",
        extra={
            "trigger_source": trigger_source,
            "domain": XIAOXIN_HR_RESOURCE_ID,
            "failure_stage": error.stage,
            "error_code": error.error_code,
            "total_elapsed_ms": elapsed_ms,
        },
    )
