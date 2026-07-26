# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Artifact orchestration."""

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactCreate,
    KnowledgeArtifactExecutionHealth,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_service import (
    ArtifactPermissionError,
    ArtifactService,
    ArtifactValidationError,
)
from app.services.knowledge.artifact_task_launcher import ArtifactTaskLaunchResult


def build_service() -> tuple[ArtifactService, MagicMock, AsyncMock]:
    repository = MagicMock()
    repository.create.side_effect = lambda artifact: artifact
    repository.update_execution.side_effect = lambda artifact: artifact
    launcher = AsyncMock()
    service = ArtifactService(
        MagicMock(),
        SimpleNamespace(id=7),
        repository,
        launcher=launcher,
    )
    return service, repository, launcher


def build_artifact(
    *,
    artifact_type: KnowledgeArtifactType = KnowledgeArtifactType.BRIEFING,
    status: KnowledgeArtifactStatus = KnowledgeArtifactStatus.RUNNING,
) -> KnowledgeArtifact:
    now = datetime.now().astimezone()
    return KnowledgeArtifact(
        artifact_id="artifact-1",
        knowledge_base_id=12,
        artifact_type=artifact_type,
        title="项目简报",
        status=status,
        task_id=31,
        assistant_subtask_id=41,
        source_document_ids=[101, 102],
        user_id=7,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_create_persists_before_and_after_launch():
    service, repository, launcher = build_service()
    launcher.launch.return_value = ArtifactTaskLaunchResult(
        task_id=31,
        assistant_subtask_id=41,
    )
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
        document_ids=[101, 102],
        instruction="突出风险",
    )

    with (
        patch.object(service, "_require_manage_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101, 102]),
    ):
        artifact = await service.create(12, request)

    assert artifact.status == KnowledgeArtifactStatus.RUNNING
    assert artifact.task_id == 31
    assert artifact.assistant_subtask_id == 41
    assert artifact.generation_config == {"instruction": "突出风险"}
    repository.create.assert_called_once()
    repository.update_execution.assert_called_once()
    launcher.launch.assert_awaited_once()
    assert launcher.launch.await_args.kwargs["attempt"] == 1


@pytest.mark.asyncio
async def test_create_marks_artifact_failed_when_task_launch_fails():
    service, repository, launcher = build_service()
    launcher.launch.side_effect = RuntimeError("智能体不可用")
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
        document_ids=[101],
    )

    with (
        patch.object(service, "_require_manage_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101]),
        pytest.raises(RuntimeError, match="智能体不可用"),
    ):
        await service.create(12, request)

    failed_artifact = repository.update_execution.call_args.args[0]
    assert failed_artifact.status == KnowledgeArtifactStatus.FAILED
    assert failed_artifact.error_message == "智能体不可用"


@pytest.mark.asyncio
async def test_create_requires_document_management_permission():
    service, repository, _ = build_service()
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
    )

    with (
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.get_knowledge_base",
            return_value=(SimpleNamespace(id=12), True),
        ),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=False,
        ),
        pytest.raises(ArtifactPermissionError),
    ):
        await service.create(12, request)

    repository.create.assert_not_called()


def test_parse_mind_map_accepts_exactly_one_mermaid_block():
    content = "说明\n```mermaid\ngraph TD\nA --> B\n```\n结尾"

    result = ArtifactService._parse_content(
        KnowledgeArtifactType.MIND_MAP,
        content,
    )

    assert result == "graph TD\nA --> B"


@pytest.mark.parametrize(
    "content",
    [
        "graph TD\nA --> B",
        "```mermaid\ngraph TD\nA --> B\n```\n```mermaid\ngraph LR\nC --> D\n```",
        "```mermaid\n\n```",
    ],
)
def test_parse_mind_map_rejects_invalid_output(content: str):
    with pytest.raises(ArtifactValidationError, match="exactly one Mermaid"):
        ArtifactService._parse_content(
            KnowledgeArtifactType.MIND_MAP,
            content,
        )


@pytest.mark.asyncio
async def test_reconcile_completed_mind_map_saves_renderable_content():
    service, repository, _ = build_service()
    artifact = build_artifact(artifact_type=KnowledgeArtifactType.MIND_MAP)
    subtask = SimpleNamespace(
        status="COMPLETED",
        result={"value": "```mermaid\ngraph TD\nA --> B\n```"},
        completed_at=datetime.now().astimezone(),
        error_message=None,
    )
    query = MagicMock()
    query.filter.return_value.first.return_value = subtask
    service.db.query.return_value = query

    reconciled = await service._reconcile(artifact)

    assert reconciled.status == KnowledgeArtifactStatus.SUCCEEDED
    assert reconciled.content == "graph TD\nA --> B"
    repository.update_execution.assert_called_once_with(artifact)


@pytest.mark.asyncio
async def test_reconcile_derives_stalled_without_changing_running_execution():
    service, repository, _ = build_service()
    artifact = build_artifact()
    stale_at = datetime.now().astimezone() - timedelta(minutes=11)
    artifact.updated_at = stale_at
    subtask = SimpleNamespace(
        id=41,
        status="RUNNING",
        result=None,
        completed_at=None,
        error_message=None,
        created_at=stale_at,
        updated_at=stale_at,
    )
    query = MagicMock()
    query.filter.return_value.first.return_value = subtask
    service.db.query.return_value = query
    reconciled = await service._reconcile(artifact)

    assert reconciled.status == KnowledgeArtifactStatus.RUNNING
    assert reconciled.execution_health == KnowledgeArtifactExecutionHealth.STALLED
    assert reconciled.can_retry is True
    repository.update_execution.assert_not_called()


@pytest.mark.asyncio
async def test_reconcile_keeps_recent_running_execution_healthy():
    service, repository, _ = build_service()
    artifact = build_artifact()
    recent_at = datetime.now().astimezone() - timedelta(minutes=3)
    artifact.updated_at = recent_at
    subtask = SimpleNamespace(
        id=41,
        status="RUNNING",
        result=None,
        completed_at=None,
        error_message=None,
        created_at=recent_at,
        updated_at=recent_at,
    )
    query = MagicMock()
    query.filter.return_value.first.return_value = subtask
    service.db.query.return_value = query
    reconciled = await service._reconcile(artifact)

    assert reconciled.status == KnowledgeArtifactStatus.RUNNING
    assert reconciled.execution_health == KnowledgeArtifactExecutionHealth.HEALTHY
    assert reconciled.can_retry is False
    repository.update_execution.assert_not_called()


@pytest.mark.asyncio
async def test_retry_reuses_artifact_identity_and_relaunches():
    service, repository, launcher = build_service()
    artifact = build_artifact(status=KnowledgeArtifactStatus.FAILED)
    artifact.error_code = "MODEL_ERROR"
    artifact.error_message = "模型调用失败"
    repository.get.return_value = artifact
    claimed = artifact.model_copy(deep=True)
    claimed.status = KnowledgeArtifactStatus.QUEUED
    claimed.task_id = None
    claimed.assistant_subtask_id = None
    claimed.error_code = None
    claimed.error_message = None
    claimed.attempt = 2
    repository.claim_retry.return_value = (claimed, True)
    launcher.launch.return_value = ArtifactTaskLaunchResult(
        task_id=32,
        assistant_subtask_id=42,
    )

    with patch.object(service, "_require_manage_access"):
        retried = await service.retry(12, "artifact-1")

    assert retried.artifact_id == "artifact-1"
    assert retried.status == KnowledgeArtifactStatus.RUNNING
    assert retried.task_id == 32
    assert retried.assistant_subtask_id == 42
    assert retried.error_code is None
    assert retried.error_message is None
    assert retried.attempt == 2
    assert launcher.launch.await_args.kwargs["attempt"] == 2
    repository.claim_retry.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=1,
        allow_active=False,
    )


@pytest.mark.asyncio
async def test_retry_claims_stalled_active_attempt_and_relaunches():
    service, repository, launcher = build_service()
    artifact = build_artifact()
    stale_at = datetime.now().astimezone() - timedelta(minutes=11)
    artifact.updated_at = stale_at
    repository.get.return_value = artifact
    subtask = SimpleNamespace(
        id=41,
        status="RUNNING",
        result=None,
        completed_at=None,
        error_message=None,
        created_at=stale_at,
        updated_at=stale_at,
    )
    query = MagicMock()
    query.filter.return_value.first.return_value = subtask
    service.db.query.return_value = query
    claimed = artifact.model_copy(deep=True)
    claimed.status = KnowledgeArtifactStatus.QUEUED
    claimed.task_id = None
    claimed.assistant_subtask_id = None
    claimed.attempt = 2
    repository.claim_retry.return_value = (claimed, True)
    launcher.launch.return_value = ArtifactTaskLaunchResult(
        task_id=32,
        assistant_subtask_id=42,
    )

    with patch.object(service, "_require_manage_access"):
        retried = await service.retry(12, "artifact-1")

    assert retried.status == KnowledgeArtifactStatus.RUNNING
    assert retried.attempt == 2
    repository.claim_retry.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=1,
        allow_active=True,
    )
