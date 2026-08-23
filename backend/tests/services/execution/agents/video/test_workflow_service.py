# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.services.execution.agents.video.workflow_service import (
    VideoWorkflowService,
    build_video_director_card_block,
)
from app.services.execution.agents.video.workflows.base import (
    VideoWorkflowCreation,
    VideoWorkflowSnapshot,
)


def test_external_workflow_clients_are_resolved_through_registry(
    monkeypatch,
) -> None:
    from app.services.execution.agents.video import workflows

    client = MagicMock()
    factory = MagicMock(return_value=client)
    monkeypatch.setattr(workflows, "_workflow_client_factories", {})

    workflows.register_video_workflow_client("example_workflow", factory)

    assert workflows.get_video_workflow_client("example_workflow") is client
    factory.assert_called_once_with()


def test_video_director_card_uses_public_workflow_snapshot() -> None:
    block = build_video_director_card_block(
        block_id="card-1",
        snapshot=VideoWorkflowSnapshot(
            status="completed",
            progress=100,
            card={
                "title": "Generated video",
                "video_url": "https://media.example.com/video.mp4",
            },
        ),
    )

    assert block["card_type"] == "video_director_generation"
    assert block["card_status"] == "populated"
    assert block["card_data"]["title"] == "Generated video"


@pytest.mark.asyncio
async def test_workflow_service_passes_selected_model_to_registered_workflow() -> None:
    service = VideoWorkflowService()
    token_info = TaskTokenInfo(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="tester",
    )
    workflow = AsyncMock()
    workflow.create.return_value = VideoWorkflowCreation(
        external_task_id="workflow-1",
        query_url="https://workflow.example.com/task/1",
        snapshot=VideoWorkflowSnapshot(status="processing", progress=5),
    )

    with (
        patch(
            "app.services.execution.agents.video.workflow_service."
            "resolve_selected_video_params",
            return_value={
                "model": "video-model-1",
                "model_display_name": "Video Model 1",
            },
        ),
        patch(
            "app.services.execution.agents.video.workflow_service."
            "get_video_workflow_client",
            return_value=workflow,
        ),
        patch("app.tasks.video_tasks.update_subtask_video_job") as persist,
        patch("app.tasks.video_tasks.dispatch_video_polling_task") as dispatch,
        patch("app.tasks.video_websocket.emit_card_created") as emit,
    ):
        result = await service.create_video_workflow(
            db=MagicMock(),
            token_info=token_info,
            workflow_type="example_workflow",
            prompt="brief",
        )

    assert workflow.create.await_args.kwargs["model"] == "video-model-1"
    assert persist.call_args.args[2]["type"] == "card"
    assert dispatch.call_args.kwargs["workflow_type"] == "example_workflow"
    assert emit.call_args.kwargs["block"]["card_status"] == "pending"
    assert result["status"] == "polling"
