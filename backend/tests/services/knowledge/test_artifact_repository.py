# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for durable knowledge Artifact persistence."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models.knowledge_artifact import KnowledgeArtifactRecord
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_repository import KnowledgeArtifactRepository


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    KnowledgeArtifactRecord.__table__.create(engine)
    session_factory = sessionmaker(bind=engine)
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def build_artifact(
    artifact_id: str = "artifact-1",
    *,
    created_at: datetime | None = None,
) -> KnowledgeArtifact:
    now = created_at or datetime.now().astimezone()
    return KnowledgeArtifact(
        artifact_id=artifact_id,
        knowledge_base_id=12,
        artifact_type=KnowledgeArtifactType.BRIEFING,
        title="项目简报",
        status=KnowledgeArtifactStatus.RUNNING,
        task_id=31,
        assistant_subtask_id=41,
        user_id=7,
        created_at=now,
        updated_at=now,
    )


def test_repository_round_trip_list_limit_and_delete(db: Session):
    repository = KnowledgeArtifactRepository(db)
    older = build_artifact(
        "artifact-1",
        created_at=datetime.now().astimezone() - timedelta(minutes=1),
    )
    newer = build_artifact("artifact-2")

    repository.create(older)
    repository.create(newer)

    assert repository.get(12, "artifact-1").artifact_id == "artifact-1"
    assert [item.artifact_id for item in repository.list_by_knowledge_base(12)] == [
        "artifact-2",
        "artifact-1",
    ]
    assert len(repository.list_by_knowledge_base(12, limit=1)) == 1
    assert (
        repository.delete(
            12,
            "artifact-1",
            expected_attempt=older.attempt,
        )
        is True
    )
    assert repository.get(12, "artifact-1") is None


def test_execution_update_preserves_concurrent_rename(db: Session):
    repository = KnowledgeArtifactRepository(db)
    stale_execution = repository.create(build_artifact())

    renamed = repository.rename(12, "artifact-1", "新的标题")
    stale_execution.status = KnowledgeArtifactStatus.SUCCEEDED
    stale_execution.content = "生成结果"
    stale_execution.updated_at = datetime.now().astimezone()
    updated = repository.update_execution(stale_execution)

    assert renamed.title == "新的标题"
    assert updated.title == "新的标题"
    assert updated.status == KnowledgeArtifactStatus.SUCCEEDED
    assert updated.content == "生成结果"


def test_deleted_artifact_cannot_be_recreated_by_stale_execution(db: Session):
    repository = KnowledgeArtifactRepository(db)
    stale_execution = repository.create(build_artifact())

    assert (
        repository.delete(
            12,
            "artifact-1",
            expected_attempt=stale_execution.attempt,
        )
        is True
    )

    stale_execution.status = KnowledgeArtifactStatus.SUCCEEDED
    assert repository.update_execution(stale_execution) is None
    assert repository.get(12, "artifact-1") is None


def test_delete_rejects_a_stale_attempt(db: Session):
    repository = KnowledgeArtifactRepository(db)
    artifact = repository.create(build_artifact())

    assert (
        repository.delete(
            12,
            "artifact-1",
            expected_attempt=artifact.attempt + 1,
        )
        is False
    )
    assert repository.get(12, "artifact-1") is not None


def test_terminal_state_cannot_regress_to_running(db: Session):
    repository = KnowledgeArtifactRepository(db)
    stale_running = repository.create(build_artifact())
    completed = stale_running.model_copy(deep=True)
    completed.status = KnowledgeArtifactStatus.SUCCEEDED
    completed.content = "最终结果"

    repository.update_execution(completed)

    stale_running.updated_at = datetime.now().astimezone()
    rejected = repository.update_execution(stale_running)
    persisted = repository.get(12, "artifact-1")
    assert rejected.status == KnowledgeArtifactStatus.SUCCEEDED
    assert persisted.status == KnowledgeArtifactStatus.SUCCEEDED
    assert persisted.content == "最终结果"


def test_retry_claim_is_atomic_and_invalidates_old_attempt(db: Session):
    repository = KnowledgeArtifactRepository(db)
    failed = build_artifact()
    failed.status = KnowledgeArtifactStatus.FAILED
    old_attempt = repository.create(failed)

    claimed, did_claim = repository.claim_retry(
        12,
        "artifact-1",
        expected_attempt=1,
    )
    second_claim, second_did_claim = repository.claim_retry(
        12,
        "artifact-1",
        expected_attempt=1,
    )

    assert did_claim is True
    assert claimed.status == KnowledgeArtifactStatus.QUEUED
    assert claimed.attempt == 2
    assert second_did_claim is False
    assert second_claim.attempt == 2
    old_attempt.status = KnowledgeArtifactStatus.SUCCEEDED
    rejected = repository.update_execution(old_attempt)
    assert rejected.attempt == 2
    assert repository.get(12, "artifact-1").status == KnowledgeArtifactStatus.QUEUED


def test_repository_deletes_all_artifacts_for_knowledge_base(db: Session):
    repository = KnowledgeArtifactRepository(db)
    repository.create(build_artifact("artifact-1"))
    repository.create(build_artifact("artifact-2"))

    assert repository.delete_by_knowledge_base(12) is True
    assert repository.list_by_knowledge_base(12) == []


def test_retry_claim_requires_explicit_active_permission_and_current_attempt(
    db: Session,
):
    repository = KnowledgeArtifactRepository(db)
    repository.create(build_artifact())

    not_allowed, not_claimed = repository.claim_retry(
        12,
        "artifact-1",
        expected_attempt=1,
    )
    stale_attempt, stale_claimed = repository.claim_retry(
        12,
        "artifact-1",
        expected_attempt=2,
        allow_active=True,
    )
    claimed, did_claim = repository.claim_retry(
        12,
        "artifact-1",
        expected_attempt=1,
        allow_active=True,
    )

    assert not_claimed is False
    assert not_allowed.attempt == 1
    assert stale_claimed is False
    assert stale_attempt.attempt == 1
    assert did_claim is True
    assert claimed.attempt == 2
    assert claimed.status == KnowledgeArtifactStatus.QUEUED
