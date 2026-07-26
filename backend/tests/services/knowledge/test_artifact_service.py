# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Artifact orchestration."""

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import SubtaskStatus
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactCreate,
    KnowledgeArtifactExecutionHealth,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_service import (
    ArtifactNotFoundError,
    ArtifactPermissionError,
    ArtifactService,
    ArtifactValidationError,
)
from app.services.knowledge.artifact_task_launcher import (
    ArtifactTaskConfigurationError,
    ArtifactTaskLaunchResult,
)


def build_service() -> tuple[ArtifactService, MagicMock, AsyncMock]:
    repository = MagicMock()
    repository.create.side_effect = lambda artifact: artifact
    repository.update_execution.side_effect = lambda artifact: artifact
    launcher = AsyncMock()
    task_resource_store = MagicMock()
    subtask_resource_store = MagicMock()
    service = ArtifactService(
        MagicMock(),
        SimpleNamespace(id=7),
        repository,
        launcher=launcher,
        task_resource_store=task_resource_store,
        subtask_resource_store=subtask_resource_store,
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
    prepared_team = MagicMock()
    launcher.preflight.return_value = prepared_team
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
        patch.object(service, "_require_read_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101, 102]),
    ):
        artifact = await service.create(12, request)

    assert artifact.status == KnowledgeArtifactStatus.RUNNING
    assert artifact.task_id == 31
    assert artifact.assistant_subtask_id == 41
    assert artifact.generation_config == {"instruction": "突出风险"}
    repository.create.assert_called_once()
    repository.update_execution.assert_called_once()
    launcher.preflight.assert_awaited_once_with()
    launcher.launch.assert_awaited_once()
    assert launcher.launch.await_args.kwargs["attempt"] == 1
    assert launcher.launch.await_args.kwargs["prepared_team"] is prepared_team


@pytest.mark.asyncio
async def test_create_marks_artifact_failed_when_task_launch_fails():
    service, repository, launcher = build_service()
    launcher.preflight.return_value = MagicMock()
    launcher.launch.side_effect = RuntimeError("智能体不可用")
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
        document_ids=[101],
    )

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101]),
        pytest.raises(RuntimeError, match="智能体不可用"),
    ):
        await service.create(12, request)

    failed_artifact = repository.update_execution.call_args.args[0]
    assert failed_artifact.status == KnowledgeArtifactStatus.FAILED
    assert failed_artifact.error_message == "智能体不可用"


@pytest.mark.asyncio
async def test_create_does_not_persist_when_preflight_fails():
    service, repository, launcher = build_service()
    launcher.preflight.side_effect = ArtifactTaskConfigurationError(
        "Bot wegent-knowledge-bot has no model configured"
    )
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
        document_ids=[101],
    )

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101]),
        pytest.raises(
            ArtifactTaskConfigurationError,
            match="has no model configured",
        ),
    ):
        await service.create(12, request)

    repository.create.assert_not_called()
    repository.update_execution.assert_not_called()
    launcher.launch.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_allows_user_with_read_access_without_management_permission():
    service, repository, launcher = build_service()
    launcher.preflight.return_value = MagicMock()
    launcher.launch.return_value = ArtifactTaskLaunchResult(
        task_id=31,
        assistant_subtask_id=41,
    )
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
        ) as can_manage,
        patch.object(service, "_resolve_document_ids", return_value=[101]),
    ):
        artifact = await service.create(12, request)

    assert artifact.status == KnowledgeArtifactStatus.RUNNING
    repository.create.assert_called_once()
    can_manage.assert_not_called()


@pytest.mark.asyncio
async def test_create_rejects_user_without_read_access():
    service, repository, _ = build_service()
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.BRIEFING,
    )

    with (
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.get_knowledge_base",
            return_value=(None, False),
        ),
        pytest.raises(ArtifactNotFoundError),
    ):
        await service.create(12, request)

    repository.create.assert_not_called()


@pytest.mark.asyncio
async def test_list_includes_available_document_count():
    service, repository, _ = build_service()
    repository.list_by_knowledge_base.return_value = []

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile_many", AsyncMock(return_value=[])),
        patch.object(service, "_document_source_counts", return_value=(4, 2)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
    ):
        response = await service.list(12)

    assert response.items == []
    assert response.can_manage is True
    assert response.available_document_count == 4
    assert response.processing_document_count == 2


def test_parse_mind_map_accepts_structured_json():
    content = """
    {
      "schema_version": 1,
      "root_id": "root",
      "nodes": [
        {"id": "root", "parent_id": null, "title": "主题"},
        {"id": "child", "parent_id": "root", "title": "子主题"}
      ]
    }
    """

    result = ArtifactService._parse_content(
        KnowledgeArtifactType.MIND_MAP,
        content,
    )

    assert '"root_id":"root"' in result
    assert '"parent_id":"root"' in result


@pytest.mark.parametrize(
    "content",
    [
        "graph TD\nA --> B",
        '{"schema_version":1,"root_id":"missing","nodes":[]}',
        (
            '{"schema_version":1,"root_id":"root","nodes":['
            '{"id":"root","parent_id":null,"title":"主题"},'
            '{"id":"child","parent_id":"unknown","title":"子主题"}]}'
        ),
    ],
)
def test_parse_mind_map_rejects_invalid_output(content: str):
    with pytest.raises(ArtifactValidationError, match="valid interactive tree"):
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
        result={
            "value": (
                '{"schema_version":1,"root_id":"root","nodes":['
                '{"id":"root","parent_id":null,"title":"主题"},'
                '{"id":"child","parent_id":"root","title":"子主题"}]}'
            )
        },
        completed_at=datetime.now().astimezone(),
        error_message=None,
    )
    service.subtask_store.get_by_id_and_role.return_value = subtask

    reconciled = await service._reconcile(artifact)

    assert reconciled.status == KnowledgeArtifactStatus.SUCCEEDED
    assert reconciled.content is not None
    assert '"root_id":"root"' in reconciled.content
    repository.update_execution.assert_called_once_with(artifact)


def test_parse_mind_map_rejects_cycles():
    content = (
        '{"schema_version":1,"root_id":"root","nodes":['
        '{"id":"root","parent_id":null,"title":"主题"},'
        '{"id":"a","parent_id":"b","title":"A"},'
        '{"id":"b","parent_id":"a","title":"B"}]}'
    )

    with pytest.raises(ArtifactValidationError, match="valid interactive tree"):
        ArtifactService._parse_content(KnowledgeArtifactType.MIND_MAP, content)


def test_resolve_mind_map_node_uses_available_artifact_sources():
    service, repository, _ = build_service()
    artifact = build_artifact(
        artifact_type=KnowledgeArtifactType.MIND_MAP,
        status=KnowledgeArtifactStatus.SUCCEEDED,
    )
    artifact.content = (
        '{"schema_version":1,"root_id":"root","nodes":['
        '{"id":"root","parent_id":null,"title":"主题"},'
        '{"id":"child","parent_id":"root","title":"子主题"}]}'
    )
    repository.get.return_value = artifact
    service.db.query.return_value.filter.return_value.all.return_value = [(102,)]

    with patch.object(service, "_require_read_access"):
        node, document_ids = service.resolve_mind_map_node(
            12,
            "artifact-1",
            "child",
        )

    assert node.title == "子主题"
    assert document_ids == [102]


def test_resolve_mind_map_node_rejects_legacy_mermaid():
    service, repository, _ = build_service()
    artifact = build_artifact(
        artifact_type=KnowledgeArtifactType.MIND_MAP,
        status=KnowledgeArtifactStatus.SUCCEEDED,
    )
    artifact.content = "mindmap\n  root((主题))"
    repository.get.return_value = artifact

    with (
        patch.object(service, "_require_read_access"),
        pytest.raises(ArtifactValidationError, match="does not support"),
    ):
        service.resolve_mind_map_node(12, "artifact-1", "root")


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
    service.subtask_store.get_by_id_and_role.return_value = subtask
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
    service.subtask_store.get_by_id_and_role.return_value = subtask
    reconciled = await service._reconcile(artifact)

    assert reconciled.status == KnowledgeArtifactStatus.RUNNING
    assert reconciled.execution_health == KnowledgeArtifactExecutionHealth.HEALTHY
    assert reconciled.can_retry is False
    repository.update_execution.assert_not_called()


@pytest.mark.asyncio
async def test_retry_reuses_artifact_identity_and_relaunches():
    service, repository, launcher = build_service()
    prepared_team = MagicMock()
    launcher.preflight.return_value = prepared_team
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

    with patch.object(service, "_require_read_access") as require_read:
        retried = await service.retry(12, "artifact-1")

    require_read.assert_called_once_with(12)
    assert retried.artifact_id == "artifact-1"
    assert retried.status == KnowledgeArtifactStatus.RUNNING
    assert retried.task_id == 32
    assert retried.assistant_subtask_id == 42
    assert retried.error_code is None
    assert retried.error_message is None
    assert retried.attempt == 2
    assert launcher.launch.await_args.kwargs["attempt"] == 2
    assert launcher.launch.await_args.kwargs["prepared_team"] is prepared_team
    repository.claim_retry.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=1,
        allow_active=False,
    )


@pytest.mark.asyncio
async def test_retry_claims_stalled_active_attempt_and_relaunches():
    service, repository, launcher = build_service()
    launcher.preflight.return_value = MagicMock()
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
    service.subtask_store.get_by_id_and_role.return_value = subtask
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

    with patch.object(service, "_require_read_access"):
        retried = await service.retry(12, "artifact-1")

    assert retried.status == KnowledgeArtifactStatus.RUNNING
    assert retried.attempt == 2
    repository.claim_retry.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=1,
        allow_active=True,
    )


@pytest.mark.asyncio
async def test_retry_does_not_claim_when_preflight_fails():
    service, repository, launcher = build_service()
    artifact = build_artifact(status=KnowledgeArtifactStatus.FAILED)
    repository.get.return_value = artifact
    launcher.preflight.side_effect = ArtifactTaskConfigurationError(
        "Bot wegent-knowledge-bot has no model configured"
    )

    with (
        patch.object(service, "_require_read_access"),
        pytest.raises(
            ArtifactTaskConfigurationError,
            match="has no model configured",
        ),
    ):
        await service.retry(12, "artifact-1")

    repository.claim_retry.assert_not_called()
    launcher.launch.assert_not_awaited()


def test_repair_execution_ids_uses_task_store_boundaries():
    service, _, _ = build_service()
    artifact = build_artifact()
    artifact.task_id = None
    artifact.assistant_subtask_id = None
    service.task_store.get_owned_task_by_name.return_value = SimpleNamespace(id=31)
    service.subtask_store.get_latest_assistant_by_statuses.return_value = (
        SimpleNamespace(id=41)
    )

    service._repair_execution_ids(artifact)

    service.task_store.get_owned_task_by_name.assert_called_once_with(
        service.db,
        user_id=7,
        name="knowledge-artifact-artifact-1-1",
        namespace="default",
    )
    service.subtask_store.get_latest_assistant_by_statuses.assert_called_once_with(
        service.db,
        task_id=31,
        statuses=list(SubtaskStatus),
        owner_user_id=7,
    )
    assert artifact.task_id == 31
    assert artifact.assistant_subtask_id == 41
