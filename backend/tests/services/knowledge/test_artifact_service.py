# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Artifact orchestration."""

from datetime import datetime, timedelta, timezone
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
    db = MagicMock()
    db.get_bind.return_value.dialect.name = "mysql"
    service = ArtifactService(
        db,
        SimpleNamespace(id=7),
        repository,
        launcher=launcher,
        task_resource_store=task_resource_store,
        subtask_resource_store=subtask_resource_store,
    )
    return service, repository, launcher


def mysql_naive_now() -> datetime:
    """Return the current time in the configured MySQL session timezone."""
    mysql_timezone = timezone(timedelta(hours=8))
    return datetime.now(timezone.utc).astimezone(mysql_timezone).replace(tzinfo=None)


def build_artifact(
    *,
    artifact_type: KnowledgeArtifactType = KnowledgeArtifactType.BRIEFING,
    status: KnowledgeArtifactStatus = KnowledgeArtifactStatus.RUNNING,
) -> KnowledgeArtifact:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
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
        patch.object(service, "_require_manage_access"),
        patch.object(service, "_resolve_document_ids", return_value=[101, 102]),
    ):
        artifact = await service.create(12, request)

    assert artifact.status == KnowledgeArtifactStatus.RUNNING
    assert artifact.task_id == 31
    assert artifact.assistant_subtask_id == 41
    assert artifact.generation_config == {"instruction": "突出风险"}
    assert artifact.created_at.tzinfo is None
    assert artifact.updated_at.tzinfo is None
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
        patch.object(service, "_require_manage_access"),
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
        patch.object(service, "_require_manage_access"),
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
async def test_create_rejects_user_without_contributor_permission():
    service, repository, launcher = build_service()
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
    launcher.preflight.assert_not_awaited()


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
async def test_retry_rejects_user_without_contributor_permission():
    service, repository, launcher = build_service()

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
        await service.retry(12, "artifact-1")

    repository.get.assert_not_called()
    launcher.preflight.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_rejects_user_without_contributor_permission():
    service, repository, _ = build_service()

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
        await service.delete(12, "artifact-1")

    repository.get.assert_not_called()
    repository.delete.assert_not_called()


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


@pytest.mark.asyncio
async def test_list_masks_write_capabilities_for_read_only_user():
    service, repository, _ = build_service()
    artifact = build_artifact(status=KnowledgeArtifactStatus.FAILED)
    artifact.can_retry = True
    repository.list_by_knowledge_base.return_value = [artifact]

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile_many", AsyncMock(return_value=[artifact])),
        patch.object(service, "_document_source_counts", return_value=(4, 0)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=False,
        ),
    ):
        response = await service.list(12)

    assert response.can_manage is False
    assert response.items[0].can_retry is False
    assert response.items[0].can_delete is False


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


def test_parse_mind_map_accepts_explanatory_text_around_json():
    content = """
    已根据所选文档生成思维导图

    {"schema_version":1,"root_id":"root","nodes":[
      {"id":"root","parent_id":null,"title":"主题"},
      {"id":"child","parent_id":"root","title":"子主题"}
    ]}

    以上是完整结果。
    """

    result = ArtifactService._parse_content(
        KnowledgeArtifactType.MIND_MAP,
        content,
    )

    assert '"root_id":"root"' in result
    assert '"parent_id":"root"' in result


def test_parse_briefing_accepts_content_beyond_previous_varchar_limit():
    content = "x" * 12_001

    assert (
        ArtifactService._parse_content(
            KnowledgeArtifactType.BRIEFING,
            content,
        )
        == content
    )


def test_resolve_document_ids_deduplicates_in_request_order():
    service, _, _ = build_service()
    with patch(
        "app.services.knowledge.artifact_service.KnowledgeService.resolve_usable_document_ids",
        return_value=[102, 101],
    ) as resolve_document_ids:
        result = service._resolve_document_ids(12, [102, 101, 102])

    assert result == [102, 101]
    assert resolve_document_ids.call_args.kwargs["document_ids"] == [102, 101]


def test_resolve_document_ids_uses_all_indexed_documents_for_empty_scope():
    service, _, _ = build_service()
    query = service.db.query.return_value.filter.return_value
    query.order_by.return_value.with_entities.return_value = [
        (document_id,) for document_id in range(1, 52)
    ]

    assert service._resolve_document_ids(12, []) == list(range(1, 52))


def test_default_title_is_locale_neutral_when_omitted():
    request = KnowledgeArtifactCreate(
        artifact_type=KnowledgeArtifactType.MIND_MAP,
        document_ids=[101],
    )

    assert ArtifactService._default_title(request) == ""


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
    completed_at = mysql_naive_now()
    subtask = SimpleNamespace(
        status="COMPLETED",
        result={
            "value": (
                '{"schema_version":1,"root_id":"root","nodes":['
                '{"id":"root","parent_id":null,"title":"主题"},'
                '{"id":"child","parent_id":"root","title":"子主题"}]}'
            )
        },
        completed_at=completed_at,
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
async def test_reconcile_uses_recent_subtask_activity_for_running_execution():
    service, repository, _ = build_service()
    artifact = build_artifact()
    artifact.updated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        minutes=11
    )
    recent_at = mysql_naive_now() - timedelta(minutes=3)
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
    expected_recent_at = (
        recent_at.replace(tzinfo=timezone(timedelta(hours=8)))
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )
    assert reconciled.updated_at == expected_recent_at
    repository.update_execution.assert_called_once()


@pytest.mark.asyncio
async def test_reconcile_keeps_recent_running_execution_healthy():
    service, repository, _ = build_service()
    artifact = build_artifact()
    artifact.updated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        minutes=3
    )
    utc_naive_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        minutes=3
    )
    subtask = SimpleNamespace(
        id=41,
        status="RUNNING",
        result=None,
        completed_at=None,
        error_message=None,
        created_at=utc_naive_at,
        updated_at=utc_naive_at,
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
    artifact.error_message = "模型调用失败"
    repository.get.return_value = artifact
    claimed = artifact.model_copy(deep=True)
    claimed.status = KnowledgeArtifactStatus.QUEUED
    claimed.task_id = None
    claimed.assistant_subtask_id = None
    claimed.error_message = None
    claimed.attempt = 2
    repository.claim_retry.return_value = (claimed, True)
    launcher.launch.return_value = ArtifactTaskLaunchResult(
        task_id=32,
        assistant_subtask_id=42,
    )

    with patch.object(service, "_require_manage_access") as require_manage:
        retried = await service.retry(12, "artifact-1")

    require_manage.assert_called_once_with(12)
    assert retried.artifact_id == "artifact-1"
    assert retried.status == KnowledgeArtifactStatus.RUNNING
    assert retried.task_id == 32
    assert retried.assistant_subtask_id == 42
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
    artifact.updated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        minutes=11
    )
    recent_at = mysql_naive_now() - timedelta(minutes=11)
    repository.get.return_value = artifact
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


@pytest.mark.asyncio
async def test_retry_does_not_claim_when_preflight_fails():
    service, repository, launcher = build_service()
    artifact = build_artifact(status=KnowledgeArtifactStatus.FAILED)
    repository.get.return_value = artifact
    launcher.preflight.side_effect = ArtifactTaskConfigurationError(
        "Bot wegent-knowledge-bot has no model configured"
    )

    with (
        patch.object(service, "_require_manage_access"),
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
