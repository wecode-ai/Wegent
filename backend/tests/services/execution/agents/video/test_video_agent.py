# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import EventType, ExecutionRequest


@pytest.mark.asyncio
async def test_creation_failure_releases_shutdown_wait_and_closes_placeholder() -> None:
    from app.services.execution.agents.video.video_agent import VideoAgent

    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        message_id=3,
        prompt="Generate a video",
        model_config={"protocol": "seedance", "videoConfig": {}},
        user={"id": 4, "name": "test-user"},
        attachments=[
            {
                "mime_type": "image/png",
                "url": "https://example.com/reference.png",
            }
        ],
    )
    emitter = AsyncMock()
    session_manager = MagicMock()
    session_manager.register_stream = AsyncMock()
    session_manager.unregister_stream = AsyncMock()
    shutdown_manager = MagicMock()
    shutdown_manager.register_stream = AsyncMock(return_value=True)
    shutdown_manager.unregister_stream = AsyncMock()
    provider = AsyncMock()
    provider.create_job = AsyncMock(side_effect=RuntimeError("request rejected"))

    with (
        patch(
            "app.services.chat.storage.session.session_manager",
            session_manager,
        ),
        patch(
            "app.services.execution.agents.video.video_agent.shutdown_manager",
            shutdown_manager,
        ),
        patch(
            "app.services.execution.agents.video.video_agent.resolve_uploaded_media",
            return_value=([], [], []),
        ),
        patch(
            "app.services.execution.agents.video.video_agent.determine_image_mode",
            return_value="reference",
        ),
        patch(
            "app.services.execution.agents.video.video_agent."
            "validate_reference_materials"
        ),
        patch(
            "app.services.execution.agents.video.video_agent.get_video_provider",
            return_value=provider,
        ),
    ):
        await VideoAgent().execute(request, emitter)

    shutdown_manager.register_stream.assert_awaited_once_with(2)
    shutdown_manager.unregister_stream.assert_awaited_once_with(2)
    session_manager.unregister_stream.assert_awaited_once_with(2)

    chunk_events = [
        call.args[0]
        for call in emitter.emit.await_args_list
        if call.args[0].type == EventType.CHUNK
    ]
    final_block = chunk_events[-1].result["blocks"][0]
    assert final_block["status"] == "error"
    assert final_block["is_placeholder"] is False
