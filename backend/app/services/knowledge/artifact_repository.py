# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis persistence for knowledge artifacts."""

import logging
from collections.abc import Callable
from typing import Any

from redis.asyncio import Redis

from app.core.config import settings
from app.schemas.knowledge_artifact import KnowledgeArtifact

logger = logging.getLogger(__name__)


class ArtifactStorageError(RuntimeError):
    """Raised when permanent Artifact storage is unavailable or corrupt."""


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
        except Exception as exc:
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
        except Exception as exc:
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
        except Exception as exc:
            logger.warning(
                "Failed to release Artifact execution lease for subtask %s: %s",
                assistant_subtask_id,
                exc,
            )
        finally:
            await client.aclose()


class RedisArtifactRepository:
    """Store all artifacts for one knowledge base in one Redis Hash."""

    KEY_PREFIX = "knowledge-artifacts"

    def __init__(
        self,
        redis_url: str = settings.REDIS_URL,
        *,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._redis_url = redis_url
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
    def key_for(cls, knowledge_base_id: int) -> str:
        """Build the single Redis Hash key for a knowledge base."""
        return f"{cls.KEY_PREFIX}:{knowledge_base_id}"

    async def save(self, artifact: KnowledgeArtifact) -> None:
        """Create or replace one Artifact JSON value."""
        client = self._create_client()
        try:
            await client.hset(
                self.key_for(artifact.knowledge_base_id),
                artifact.artifact_id,
                artifact.model_dump_json(),
            )
        except Exception as exc:
            logger.exception(
                "Failed to save knowledge artifact %s", artifact.artifact_id
            )
            raise ArtifactStorageError("Artifact storage is unavailable") from exc
        finally:
            await client.aclose()

    async def get(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> KnowledgeArtifact | None:
        """Read one Artifact."""
        client = self._create_client()
        try:
            raw = await client.hget(self.key_for(knowledge_base_id), artifact_id)
            if raw is None:
                return None
            return self._deserialize(raw, artifact_id)
        except ArtifactStorageError:
            raise
        except Exception as exc:
            logger.exception("Failed to read knowledge artifact %s", artifact_id)
            raise ArtifactStorageError("Artifact storage is unavailable") from exc
        finally:
            await client.aclose()

    async def list_by_knowledge_base(
        self,
        knowledge_base_id: int,
    ) -> list[KnowledgeArtifact]:
        """Read all Artifacts for one knowledge base."""
        client = self._create_client()
        try:
            values = await client.hgetall(self.key_for(knowledge_base_id))
            return [
                self._deserialize(raw, artifact_id)
                for artifact_id, raw in values.items()
            ]
        except ArtifactStorageError:
            raise
        except Exception as exc:
            logger.exception(
                "Failed to list knowledge artifacts for knowledge base %s",
                knowledge_base_id,
            )
            raise ArtifactStorageError("Artifact storage is unavailable") from exc
        finally:
            await client.aclose()

    async def delete(self, knowledge_base_id: int, artifact_id: str) -> bool:
        """Delete one Artifact."""
        client = self._create_client()
        try:
            deleted = await client.hdel(self.key_for(knowledge_base_id), artifact_id)
            return bool(deleted)
        except Exception as exc:
            logger.exception("Failed to delete knowledge artifact %s", artifact_id)
            raise ArtifactStorageError("Artifact storage is unavailable") from exc
        finally:
            await client.aclose()

    async def delete_by_knowledge_base(self, knowledge_base_id: int) -> bool:
        """Delete the single Hash owned by a knowledge base."""
        client = self._create_client()
        try:
            deleted = await client.delete(self.key_for(knowledge_base_id))
            return bool(deleted)
        except Exception as exc:
            logger.exception(
                "Failed to delete artifacts for knowledge base %s",
                knowledge_base_id,
            )
            raise ArtifactStorageError("Artifact storage is unavailable") from exc
        finally:
            await client.aclose()

    @staticmethod
    def _deserialize(raw: str | bytes, artifact_id: str) -> KnowledgeArtifact:
        try:
            return KnowledgeArtifact.model_validate_json(raw)
        except Exception as exc:
            logger.exception("Corrupt knowledge artifact payload: %s", artifact_id)
            raise ArtifactStorageError(
                "Artifact storage contains invalid data"
            ) from exc
