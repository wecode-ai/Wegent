# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Artifact agent execution scheduling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.schemas.knowledge_artifact import KnowledgeArtifactType
from app.services.knowledge.artifact_task_launcher import (
    ArtifactTaskConfigurationError,
    ArtifactTaskLauncher,
)


@pytest.mark.asyncio
async def test_launch_schedules_execution():
    launcher = ArtifactTaskLauncher(
        MagicMock(),
        SimpleNamespace(id=7),
    )
    session = SimpleNamespace(
        task=MagicMock(),
        task_id=31,
        user_subtask=SimpleNamespace(id=40),
        assistant_subtask=SimpleNamespace(id=41),
    )
    request = SimpleNamespace(task_id=31, subtask_id=41)
    prepared_team = MagicMock()

    with (
        patch(
            "app.services.knowledge.artifact_task_launcher.prepare_execution_session",
            return_value=session,
        ) as prepare_session,
        patch.object(launcher, "_mark_task_as_artifact") as mark_artifact,
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
            title="",
            knowledge_base_id=12,
            document_ids=[101],
            instruction=None,
            prepared_team=prepared_team,
        )

    assert (
        prepare_session.call_args.kwargs["task_params"].client_origin
        == CLIENT_ORIGIN_FRONTEND
    )
    assert prepare_session.call_args.kwargs["task_params"].title == "简报"
    mark_artifact.assert_called_once_with(session.task, "artifact-1", 2)
    schedule_execution.assert_called_once_with(request)
    assert result.task_id == 31
    assert result.assistant_subtask_id == 41


def test_mark_task_as_artifact_keeps_task_visible():
    db = MagicMock()
    launcher = ArtifactTaskLauncher(db, SimpleNamespace(id=7))
    task = SimpleNamespace(
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "task-31", "namespace": "default"},
            "spec": {
                "title": "简报",
                "prompt": "生成简报",
                "teamRef": {"name": "team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-31", "namespace": "default"},
            },
        }
    )

    with patch(
        "app.services.knowledge.artifact_task_launcher.task_store.update_json"
    ) as update_json:
        launcher._mark_task_as_artifact(task, "artifact-1", 2)

    labels = update_json.call_args.kwargs["payload"]["metadata"]["labels"]
    assert "type" not in labels
    assert labels == {
        "taskType": "knowledge",
        "source": "knowledge_artifact",
        "artifactId": "artifact-1",
        "artifactAttempt": "2",
    }


@pytest.mark.asyncio
async def test_preflight_rejects_missing_model_before_session_creation():
    launcher = ArtifactTaskLauncher(
        MagicMock(),
        SimpleNamespace(id=7),
    )
    team = SimpleNamespace(
        name="wegent-notebook",
        namespace="default",
        user_id=0,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "wegent-notebook", "namespace": "default"},
            "spec": {
                "members": [
                    {
                        "botRef": {
                            "name": "wegent-knowledge-bot",
                            "namespace": "default",
                        }
                    }
                ],
                "collaborationModel": "coordinate",
            },
        },
    )
    bot = SimpleNamespace(name="wegent-knowledge-bot")

    with (
        patch.object(launcher, "_resolve_team", return_value=team),
        patch.object(launcher, "_resolve_first_bot", return_value=bot),
        patch(
            "app.services.knowledge.artifact_task_launcher.get_model_config_for_bot",
            side_effect=ValueError("Bot wegent-knowledge-bot has no model configured"),
        ),
        patch(
            "app.services.knowledge.artifact_task_launcher.prepare_execution_session"
        ) as prepare_session,
        pytest.raises(
            ArtifactTaskConfigurationError,
            match="has no model configured",
        ),
    ):
        await launcher.launch(
            artifact_id="artifact-1",
            attempt=1,
            artifact_type=KnowledgeArtifactType.BRIEFING,
            title="项目简报",
            knowledge_base_id=12,
            document_ids=[101],
            instruction=None,
        )

    prepare_session.assert_not_called()


@pytest.mark.asyncio
async def test_dispatch_drains_emitter_when_execution_finishes():
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
        await ArtifactTaskLauncher._dispatch_and_drain(request)

    emitter.collect.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_logs_collector_failure(caplog):
    request = SimpleNamespace(task_id=31, subtask_id=41)
    emitter = MagicMock()
    emitter.collect = AsyncMock(side_effect=RuntimeError("collector failed"))

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
        await ArtifactTaskLauncher._dispatch_and_drain(request)

    assert "Artifact result collection failed" in caplog.text
    assert "task_id=31" in caplog.text
    assert "subtask_id=41" in caplog.text


def test_mind_map_prompt_requires_structured_json():
    prompt = ArtifactTaskLauncher._build_prompt(
        KnowledgeArtifactType.MIND_MAP,
        None,
    )

    assert '"schema_version":1' in prompt
    assert "不要使用 Markdown 代码围栏" in prompt
    assert "mermaid" not in prompt.lower()
