# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.services.execution.agents.video.generation_service import (
    VideoGenerationService,
)


@pytest.mark.asyncio
async def test_create_job_stages_images_before_provider_call() -> None:
    service = VideoGenerationService()
    db = MagicMock()
    token_info = TaskTokenInfo(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="test-user",
    )
    provider = AsyncMock()
    provider.create_job.return_value = "job-1"
    original = [{"url": "https://source.example.com/reference.png"}]
    staged = [{"url": "https://staging.example.com/reference.png"}]

    with (
        patch(
            "app.services.execution.agents.video.generation_service."
            "resolve_generation_context",
            return_value=SimpleNamespace(),
        ),
        patch(
            "app.services.execution.agents.video.generation_service."
            "resolve_generation_model",
            return_value={
                "protocol": "seedance",
                "videoConfig": {"capabilities": {"supports_image_input": True}},
            },
        ),
        patch(
            "app.services.execution.agents.video.generation_service."
            "normalize_reference_materials",
            side_effect=[original, [], []],
        ),
        patch(
            "app.services.execution.agents.video.generation_service."
            "stage_video_reference_images",
            AsyncMock(return_value=staged),
        ) as stage_images,
        patch(
            "app.services.execution.agents.video.generation_service."
            "get_video_provider",
            return_value=provider,
        ),
        patch(
            "app.tasks.video_tasks.update_subtask_video_job",
        ),
        patch(
            "app.tasks.video_tasks.dispatch_video_polling_task",
        ),
    ):
        await service.create_job(
            db=db,
            token_info=token_info,
            prompt=(
                "<attachment>\nreference image metadata\n</attachment>\n"
                "Generate a video"
            ),
            reference_images=["1"],
        )

    stage_images.assert_awaited_once_with(original, 3)
    provider.create_job.assert_awaited_once()
    assert provider.create_job.await_args.kwargs["prompt"] == "Generate a video"
    assert provider.create_job.await_args.kwargs["reference_images"] == staged
    assert provider.create_job.await_args.kwargs["reference_image"] == staged[0]["url"]
