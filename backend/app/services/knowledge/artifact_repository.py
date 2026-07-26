# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable storage and ephemeral execution leases for knowledge Artifacts."""

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.knowledge_artifact import KnowledgeArtifactRecord
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactStatus,
)

logger = logging.getLogger(__name__)


class ArtifactStorageError(RuntimeError):
    """Raised when Artifact storage is unavailable."""


class RedisArtifactExecutionLease:
    """Track whether an in-process Artifact execution is still alive."""

    KEY_PREFIX = "knowledge-artifact-execution"
    DEFAULT_TTL_SECONDS = 60

    def __init__(
        self,
        redis_url: str = settings.REDIS_URL,
        *,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._redis_url = redis_url
        self._ttl_seconds = ttl_seconds
        self._client_factory = client_factory

    def _create_client(self) -> Redis:
        if self._client_factory is not None:
            return self._client_factory()
        return Redis.from_url(
            self._redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=5.0,
            socket_connect_timeout=2.0,
            retry_on_timeout=True,
        )

    @classmethod
    def key_for(cls, assistant_subtask_id: int) -> str:
        """Build the ephemeral execution lease key."""
        return f"{cls.KEY_PREFIX}:{assistant_subtask_id}"

    async def refresh(self, assistant_subtask_id: int) -> None:
        """Create or renew an execution lease."""
        client = self._create_client()
        try:
            await client.set(
                self.key_for(assistant_subtask_id),
                "1",
                ex=self._ttl_seconds,
            )
        except RedisError as exc:
            logger.exception(
                "Failed to refresh Artifact execution lease for subtask %s",
                assistant_subtask_id,
            )
            raise ArtifactStorageError(
                "Artifact execution lease is unavailable"
            ) from exc
        finally:
            await client.aclose()

    async def active_subtask_ids(
        self,
        assistant_subtask_ids: set[int],
    ) -> set[int]:
        """Return subtask IDs whose execution leases are still alive."""
        if not assistant_subtask_ids:
            return set()

        ordered_ids = sorted(assistant_subtask_ids)
        client = self._create_client()
        try:
            values = await client.mget(
                [self.key_for(subtask_id) for subtask_id in ordered_ids]
            )
            return {
                subtask_id
                for subtask_id, value in zip(ordered_ids, values, strict=True)
                if value is not None
            }
        except RedisError as exc:
            logger.exception("Failed to read Artifact execution leases")
            raise ArtifactStorageError(
                "Artifact execution lease is unavailable"
            ) from exc
        finally:
            await client.aclose()

    async def release(self, assistant_subtask_id: int) -> None:
        """Release an execution lease after the dispatcher terminates."""
        client = self._create_client()
        try:
            await client.delete(self.key_for(assistant_subtask_id))
        except RedisError as exc:
            logger.warning(
                "Failed to release Artifact execution lease for subtask %s: %s",
                assistant_subtask_id,
                exc,
            )
        finally:
            await client.aclose()


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
            record.updated_at = datetime.now().astimezone()
            self.db.commit()
            self.db.refresh(record)
            return self._to_schema(record)
        except SQLAlchemyError as exc:
            self._raise_storage_error("rename", artifact_id, exc)

    def claim_retry(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> tuple[KnowledgeArtifact | None, bool]:
        """Atomically claim a new attempt for a failed Artifact."""
        try:
            record = (
                self._query(knowledge_base_id, artifact_id).with_for_update().first()
            )
            if record is None:
                self.db.rollback()
                return None, False
            if record.status != KnowledgeArtifactStatus.FAILED.value:
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
            record.updated_at = datetime.now().astimezone()
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

    def delete(self, knowledge_base_id: int, artifact_id: str) -> bool:
        """Physically delete an Artifact so stale executions cannot recreate it."""
        try:
            deleted = self._query(knowledge_base_id, artifact_id).delete(
                synchronize_session=False
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
