# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable storage for knowledge Artifacts."""

import logging
from datetime import datetime, timezone

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.knowledge_artifact import KnowledgeArtifactRecord
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactStatus,
)

logger = logging.getLogger(__name__)


class ArtifactStorageError(RuntimeError):
    """Raised when Artifact storage is unavailable."""


class KnowledgeArtifactRepository:
    """Persist Artifacts in MySQL with race-safe, field-scoped updates."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create(self, artifact: KnowledgeArtifact) -> KnowledgeArtifact:
        """Insert a new Artifact."""
        record = KnowledgeArtifactRecord(
            artifact_id=artifact.artifact_id,
            knowledge_base_id=artifact.knowledge_base_id,
            artifact_type=artifact.artifact_type.value,
            title=artifact.title,
            status=artifact.status.value,
            task_id=artifact.task_id,
            assistant_subtask_id=artifact.assistant_subtask_id,
            content=artifact.content,
            source_document_ids=artifact.source_document_ids,
            generation_config=artifact.generation_config,
            error_code=artifact.error_code,
            error_message=artifact.error_message,
            user_id=artifact.user_id,
            schema_version=artifact.schema_version,
            version=artifact.version,
            attempt=artifact.attempt,
            created_at=artifact.created_at,
            updated_at=artifact.updated_at,
            completed_at=artifact.completed_at,
        )
        try:
            self.db.add(record)
            self.db.commit()
            self.db.refresh(record)
            return self._to_schema(record)
        except SQLAlchemyError as exc:
            self._raise_storage_error("create", artifact.artifact_id, exc)

    def get(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> KnowledgeArtifact | None:
        """Read one Artifact within its knowledge-base boundary."""
        try:
            record = self._query(knowledge_base_id, artifact_id).first()
            return self._to_schema(record) if record is not None else None
        except SQLAlchemyError as exc:
            self._raise_storage_error("read", artifact_id, exc)

    def list_by_knowledge_base(
        self,
        knowledge_base_id: int,
        *,
        limit: int = 50,
    ) -> list[KnowledgeArtifact]:
        """Read the newest Artifacts without loading the whole knowledge base."""
        try:
            records = (
                self.db.query(KnowledgeArtifactRecord)
                .filter(KnowledgeArtifactRecord.knowledge_base_id == knowledge_base_id)
                .order_by(
                    KnowledgeArtifactRecord.created_at.desc(),
                    KnowledgeArtifactRecord.artifact_id.desc(),
                )
                .limit(limit)
                .all()
            )
            return [self._to_schema(record) for record in records]
        except SQLAlchemyError as exc:
            self._raise_storage_error("list", str(knowledge_base_id), exc)

    def rename(
        self,
        knowledge_base_id: int,
        artifact_id: str,
        title: str,
    ) -> KnowledgeArtifact | None:
        """Update only user-owned metadata."""
        try:
            record = (
                self._query(knowledge_base_id, artifact_id).with_for_update().first()
            )
            if record is None:
                self.db.rollback()
                return None
            record.title = title
            record.version += 1
            record.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            self.db.commit()
            self.db.refresh(record)
            return self._to_schema(record)
        except SQLAlchemyError as exc:
            self._raise_storage_error("rename", artifact_id, exc)

    def claim_retry(
        self,
        knowledge_base_id: int,
        artifact_id: str,
        *,
        expected_attempt: int,
        allow_active: bool = False,
    ) -> tuple[KnowledgeArtifact | None, bool]:
        """Atomically claim a new attempt for a failed or user-confirmed stall."""
        try:
            record = (
                self._query(knowledge_base_id, artifact_id).with_for_update().first()
            )
            if record is None:
                self.db.rollback()
                return None, False
            active_statuses = {
                KnowledgeArtifactStatus.QUEUED.value,
                KnowledgeArtifactStatus.RUNNING.value,
            }
            retryable = record.status == KnowledgeArtifactStatus.FAILED.value or (
                allow_active and record.status in active_statuses
            )
            if record.attempt != expected_attempt or not retryable:
                artifact = self._to_schema(record)
                self.db.rollback()
                return artifact, False

            record.status = KnowledgeArtifactStatus.QUEUED.value
            record.task_id = None
            record.assistant_subtask_id = None
            record.content = None
            record.error_code = None
            record.error_message = None
            record.completed_at = None
            record.attempt += 1
            record.version += 1
            record.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            self.db.commit()
            self.db.refresh(record)
            return self._to_schema(record), True
        except SQLAlchemyError as exc:
            self._raise_storage_error("retry", artifact_id, exc)

    def update_execution(
        self,
        artifact: KnowledgeArtifact,
    ) -> KnowledgeArtifact | None:
        """Update execution fields for a current attempt and legal transition."""
        try:
            (
                self._query(artifact.knowledge_base_id, artifact.artifact_id)
                .filter(
                    KnowledgeArtifactRecord.attempt == artifact.attempt,
                    KnowledgeArtifactRecord.status.in_(
                        self._allowed_previous_statuses(artifact.status)
                    ),
                )
                .update(
                    {
                        KnowledgeArtifactRecord.status: artifact.status.value,
                        KnowledgeArtifactRecord.task_id: artifact.task_id,
                        KnowledgeArtifactRecord.assistant_subtask_id: (
                            artifact.assistant_subtask_id
                        ),
                        KnowledgeArtifactRecord.content: artifact.content,
                        KnowledgeArtifactRecord.error_code: artifact.error_code,
                        KnowledgeArtifactRecord.error_message: artifact.error_message,
                        KnowledgeArtifactRecord.completed_at: artifact.completed_at,
                        KnowledgeArtifactRecord.updated_at: artifact.updated_at,
                        KnowledgeArtifactRecord.version: (
                            KnowledgeArtifactRecord.version + 1
                        ),
                    },
                    synchronize_session=False,
                )
            )
            self.db.commit()
            return self.get(artifact.knowledge_base_id, artifact.artifact_id)
        except SQLAlchemyError as exc:
            self._raise_storage_error("update", artifact.artifact_id, exc)

    @staticmethod
    def _allowed_previous_statuses(
        target: KnowledgeArtifactStatus,
    ) -> tuple[str, ...]:
        if target == KnowledgeArtifactStatus.QUEUED:
            return (KnowledgeArtifactStatus.QUEUED.value,)
        if target == KnowledgeArtifactStatus.RUNNING:
            return (
                KnowledgeArtifactStatus.QUEUED.value,
                KnowledgeArtifactStatus.RUNNING.value,
            )
        return (
            KnowledgeArtifactStatus.QUEUED.value,
            KnowledgeArtifactStatus.RUNNING.value,
        )

    def delete(
        self,
        knowledge_base_id: int,
        artifact_id: str,
        *,
        expected_attempt: int,
    ) -> bool:
        """Physically delete an Artifact so stale executions cannot recreate it."""
        try:
            deleted = (
                self._query(knowledge_base_id, artifact_id)
                .filter(KnowledgeArtifactRecord.attempt == expected_attempt)
                .delete(synchronize_session=False)
            )
            self.db.commit()
            return bool(deleted)
        except SQLAlchemyError as exc:
            self._raise_storage_error("delete", artifact_id, exc)

    def delete_by_knowledge_base(self, knowledge_base_id: int) -> bool:
        """Delete every Artifact owned by a knowledge base."""
        try:
            deleted = (
                self.db.query(KnowledgeArtifactRecord)
                .filter(KnowledgeArtifactRecord.knowledge_base_id == knowledge_base_id)
                .delete(synchronize_session=False)
            )
            self.db.commit()
            return bool(deleted)
        except SQLAlchemyError as exc:
            self._raise_storage_error("delete all", str(knowledge_base_id), exc)

    def _query(self, knowledge_base_id: int, artifact_id: str):
        return self.db.query(KnowledgeArtifactRecord).filter(
            KnowledgeArtifactRecord.knowledge_base_id == knowledge_base_id,
            KnowledgeArtifactRecord.artifact_id == artifact_id,
        )

    @staticmethod
    def _to_schema(record: KnowledgeArtifactRecord) -> KnowledgeArtifact:
        return KnowledgeArtifact(
            artifact_id=record.artifact_id,
            knowledge_base_id=record.knowledge_base_id,
            artifact_type=record.artifact_type,
            title=record.title,
            status=record.status,
            task_id=record.task_id,
            assistant_subtask_id=record.assistant_subtask_id,
            content=record.content,
            source_document_ids=list(record.source_document_ids or []),
            generation_config=dict(record.generation_config or {}),
            error_code=record.error_code,
            error_message=record.error_message,
            user_id=record.user_id,
            schema_version=record.schema_version,
            version=record.version,
            attempt=record.attempt,
            created_at=record.created_at,
            updated_at=record.updated_at,
            completed_at=record.completed_at,
        )

    def _raise_storage_error(
        self,
        operation: str,
        target: str,
        exc: SQLAlchemyError,
    ) -> None:
        self.db.rollback()
        logger.exception(
            "Failed to %s knowledge Artifact %s",
            operation,
            target,
        )
        raise ArtifactStorageError("Artifact storage is unavailable") from exc
