# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge Artifact deletion capabilities."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactExecutionHealth,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_service import (
    ArtifactPermissionError,
    ArtifactService,
    ArtifactValidationError,
)


def _service() -> tuple[ArtifactService, MagicMock]:
    repository = MagicMock()
    service = ArtifactService(
        MagicMock(),
        SimpleNamespace(id=7),
        repository,
        launcher=AsyncMock(),
        task_resource_store=MagicMock(),
        subtask_resource_store=MagicMock(),
    )
    return service, repository


def _artifact(
    status: KnowledgeArtifactStatus,
    *,
    user_id: int = 7,
) -> KnowledgeArtifact:
    now = datetime.now().astimezone()
    return KnowledgeArtifact(
        artifact_id="artifact-1",
        knowledge_base_id=12,
        artifact_type=KnowledgeArtifactType.BRIEFING,
        title="项目简报",
        status=status,
        task_id=31,
        assistant_subtask_id=41,
        source_document_ids=[101],
        user_id=user_id,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_list_exposes_delete_capability_by_manage_permission_and_execution_state():
    service, repository = _service()
    completed = _artifact(KnowledgeArtifactStatus.SUCCEEDED)
    active = _artifact(KnowledgeArtifactStatus.RUNNING)
    repository.list_by_knowledge_base.return_value = [completed, active]

    with (
        patch.object(
            service,
            "_reconcile_many",
            AsyncMock(return_value=[completed, active]),
        ),
        patch.object(service, "_require_read_access"),
        patch.object(service, "_document_source_counts", return_value=(4, 0)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
    ):
        response = await service.list(12)

    assert response.items[0].can_delete is True
    assert response.items[1].can_delete is False


@pytest.mark.asyncio
async def test_delete_allows_manager_after_generation_finishes():
    service, repository = _service()
    artifact = _artifact(KnowledgeArtifactStatus.SUCCEEDED)
    repository.get.return_value = artifact
    repository.delete.return_value = True

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile", AsyncMock(return_value=artifact)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
    ):
        await service.delete(12, "artifact-1")

    repository.delete.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=artifact.attempt,
    )


@pytest.mark.asyncio
async def test_delete_rejects_active_artifact_and_read_only_user():
    service, repository = _service()
    active = _artifact(KnowledgeArtifactStatus.RUNNING)
    repository.get.return_value = active

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile", AsyncMock(return_value=active)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
        pytest.raises(ArtifactValidationError, match="cannot be deleted"),
    ):
        await service.delete(12, "artifact-1")

    repository.reset_mock()
    with (
        patch.object(service, "_require_read_access"),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=False,
        ),
        pytest.raises(ArtifactPermissionError, match="management is not allowed"),
    ):
        await service.delete(12, "artifact-1")

    repository.get.assert_not_called()
    repository.delete.assert_not_called()


@pytest.mark.asyncio
async def test_delete_allows_manager_to_remove_another_users_artifact():
    service, repository = _service()
    artifact = _artifact(KnowledgeArtifactStatus.SUCCEEDED, user_id=8)
    repository.get.return_value = artifact
    repository.delete.return_value = True

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile", AsyncMock(return_value=artifact)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
    ):
        await service.delete(12, "artifact-1")

    repository.delete.assert_called_once_with(
        12,
        "artifact-1",
        expected_attempt=artifact.attempt,
    )


@pytest.mark.asyncio
async def test_delete_rejects_concurrent_retry():
    service, repository = _service()
    artifact = _artifact(KnowledgeArtifactStatus.FAILED)
    retried = artifact.model_copy(update={"attempt": artifact.attempt + 1})
    repository.get.side_effect = [artifact, retried]
    repository.delete.return_value = False

    with (
        patch.object(service, "_require_read_access"),
        patch.object(service, "_reconcile", AsyncMock(return_value=artifact)),
        patch(
            "app.services.knowledge.artifact_service.KnowledgeService.can_manage_knowledge_base_documents",
            return_value=True,
        ),
        pytest.raises(ArtifactValidationError, match="state has changed"),
    ):
        await service.delete(12, "artifact-1")


@pytest.mark.asyncio
async def test_rename_preserves_delete_capability_for_manager():
    service, repository = _service()
    artifact = _artifact(KnowledgeArtifactStatus.SUCCEEDED, user_id=8)
    repository.rename.return_value = artifact

    with (
        patch.object(service, "_require_manage_access"),
        patch.object(service, "_reconcile", AsyncMock(return_value=artifact)),
    ):
        renamed = await service.rename(12, "artifact-1", "新标题")

    assert renamed.can_delete is True


def test_stalled_artifact_is_deletable():
    service, _ = _service()
    artifact = _artifact(KnowledgeArtifactStatus.RUNNING)
    artifact.execution_health = KnowledgeArtifactExecutionHealth.STALLED

    service._set_user_capabilities(artifact, can_manage=True)

    assert artifact.can_delete is True
