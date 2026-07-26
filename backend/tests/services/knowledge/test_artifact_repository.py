# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Redis-backed knowledge Artifact persistence."""

from datetime import datetime

import pytest

from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_repository import (
    ArtifactStorageError,
    RedisArtifactRepository,
)


class FakeRedis:
    """Minimal Redis Hash implementation for repository tests."""

    def __init__(self) -> None:
        self.values: dict[str, dict[str, str]] = {}
        self.closed = False

    async def hset(self, key: str, field: str, value: str) -> int:
        self.values.setdefault(key, {})[field] = value
        return 1

    async def hget(self, key: str, field: str) -> str | None:
        return self.values.get(key, {}).get(field)

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.values.get(key, {}))

    async def hdel(self, key: str, field: str) -> int:
        return int(self.values.get(key, {}).pop(field, None) is not None)

    async def delete(self, key: str) -> int:
        return int(self.values.pop(key, None) is not None)

    async def aclose(self) -> None:
        self.closed = True


class FailingRedis(FakeRedis):
    async def hset(self, key: str, field: str, value: str) -> int:
        raise ConnectionError("Redis unavailable")


def build_artifact(artifact_id: str = "artifact-1") -> KnowledgeArtifact:
    now = datetime.now().astimezone()
    return KnowledgeArtifact(
        artifact_id=artifact_id,
        knowledge_base_id=12,
        artifact_type=KnowledgeArtifactType.BRIEFING,
        title="项目简报",
        status=KnowledgeArtifactStatus.RUNNING,
        user_id=7,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_repository_round_trip_and_delete_without_ttl():
    client = FakeRedis()
    repository = RedisArtifactRepository(client_factory=lambda: client)
    artifact = build_artifact()

    await repository.save(artifact)

    assert await repository.get(12, "artifact-1") == artifact
    assert await repository.list_by_knowledge_base(12) == [artifact]
    assert await repository.delete(12, "artifact-1") is True
    assert await repository.get(12, "artifact-1") is None
    assert client.closed is True
    assert not hasattr(client, "expire")


@pytest.mark.asyncio
async def test_repository_deletes_all_artifacts_with_knowledge_base_key():
    client = FakeRedis()
    repository = RedisArtifactRepository(client_factory=lambda: client)
    await repository.save(build_artifact("artifact-1"))
    await repository.save(build_artifact("artifact-2"))

    assert await repository.delete_by_knowledge_base(12) is True
    assert await repository.list_by_knowledge_base(12) == []


@pytest.mark.asyncio
async def test_repository_rejects_corrupt_payload():
    client = FakeRedis()
    client.values["knowledge-artifacts:12"] = {"broken": "not-json"}
    repository = RedisArtifactRepository(client_factory=lambda: client)

    with pytest.raises(ArtifactStorageError, match="invalid data"):
        await repository.get(12, "broken")


@pytest.mark.asyncio
async def test_repository_exposes_redis_write_failure():
    repository = RedisArtifactRepository(client_factory=FailingRedis)

    with pytest.raises(ArtifactStorageError, match="unavailable"):
        await repository.save(build_artifact())
