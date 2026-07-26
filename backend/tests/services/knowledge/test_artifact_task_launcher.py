# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Artifact agent execution leases."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.knowledge_artifact import KnowledgeArtifactType
from app.services.knowledge.artifact_task_launcher import ArtifactTaskLauncher


@pytest.mark.asyncio
async def test_launch_creates_lease_before_scheduling_execution():
    execution_lease = AsyncMock()
    launcher = ArtifactTaskLauncher(
        MagicMock(),
        SimpleNamespace(id=7),
        execution_lease=execution_lease,
    )
    session = SimpleNamespace(
        task=MagicMock(),
        task_id=31,
        user_subtask=SimpleNamespace(id=40),
        assistant_subtask=SimpleNamespace(id=41),
    )
    request = SimpleNamespace(task_id=31, subtask_id=41)

    with (
        patch.object(launcher, "_resolve_team", return_value=MagicMock()),
        patch(
            "app.services.knowledge.artifact_task_launcher.prepare_execution_session",
            return_value=session,
        ),
        patch.object(launcher, "_mark_task_as_background") as mark_background,
        patch(
            "app.services.knowledge.artifact_task_launcher.link_selected_documents_to_subtask"
        ),
        patch(
            "app.services.knowledge.artifact_task_launcher.build_execution_request",
            new_callable=AsyncMock,
            return_value=request,
        ),
        patch.object(launcher, "_schedule_execution") as schedule_execution,
    ):
        result = await launcher.launch(
            artifact_id="artifact-1",
            attempt=2,
            artifact_type=KnowledgeArtifactType.BRIEFING,
            title="项目简报",
            knowledge_base_id=12,
            document_ids=[101],
            instruction=None,
        )

    execution_lease.refresh.assert_awaited_once_with(41)
    mark_background.assert_called_once_with(session.task, "artifact-1", 2)
    schedule_execution.assert_called_once_with(request)
    assert result.task_id == 31
    assert result.assistant_subtask_id == 41


@pytest.mark.asyncio
async def test_dispatch_releases_lease_when_execution_finishes():
    execution_lease = AsyncMock()
    request = SimpleNamespace(task_id=31, subtask_id=41)
    emitter = MagicMock()
    emitter.collect = AsyncMock(return_value=("", None))

    with (
        patch(
            "app.services.knowledge.artifact_task_launcher.SSEResultEmitter",
            return_value=emitter,
        ),
        patch(
            "app.services.knowledge.artifact_task_launcher.execution_dispatcher.dispatch",
            new_callable=AsyncMock,
        ),
    ):
        await ArtifactTaskLauncher._dispatch_and_drain(request, execution_lease)

    execution_lease.release.assert_awaited_once_with(41)
