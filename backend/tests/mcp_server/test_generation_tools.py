# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.cards import create_async_video_card
from app.mcp_server.tools.decorator import get_registered_mcp_tools
from app.mcp_server.tools.image_generation import generate_image
from app.mcp_server.tools.video_generation import generate_video

TOKEN_INFO = TaskTokenInfo(
    task_id=11,
    subtask_id=22,
    user_id=33,
    user_name="tester",
)


def test_generation_tools_are_registered_with_typed_reference_arrays() -> None:
    tools = get_registered_mcp_tools()

    assert tools["generate_image"]["server"] == "image"
    assert tools["generate_video"]["server"] == "video"
    assert tools["create_async_video_card"]["server"] == "cards"

    image_params = {
        item["name"]: item for item in tools["generate_image"]["parameters"]
    }
    video_params = {
        item["name"]: item for item in tools["generate_video"]["parameters"]
    }
    assert image_params["reference_images"]["items"] == {"type": "string"}
    assert video_params["reference_videos"]["items"] == {"type": "string"}
    assert video_params["reference_audios"]["items"] == {"type": "string"}

    card_params = {
        item["name"]: item for item in tools["create_async_video_card"]["parameters"]
    }
    assert card_params["task_url"]["type"] == "string"


@pytest.mark.asyncio
async def test_generate_image_delegates_and_closes_session() -> None:
    db = MagicMock()
    expected = {"status": "completed"}
    with (
        patch(
            "app.mcp_server.tools.image_generation.SessionLocal",
            return_value=db,
        ),
        patch(
            "app.mcp_server.tools.image_generation.image_generation_service.generate",
            new=AsyncMock(return_value=expected),
        ) as generate,
    ):
        result = await generate_image(
            token_info=TOKEN_INFO,
            prompt="draw a cat",
            max_images=2,
        )

    assert result == expected
    generate.assert_awaited_once()
    db.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_generate_video_returns_validation_error_and_closes_session() -> None:
    db = MagicMock()
    with (
        patch(
            "app.mcp_server.tools.video_generation.SessionLocal",
            return_value=db,
        ),
        patch(
            "app.mcp_server.tools.video_generation.video_generation_service.create_job",
            new=AsyncMock(side_effect=ValueError("invalid material")),
        ),
    ):
        result = await generate_video(
            token_info=TOKEN_INFO,
            prompt="make a video",
        )

    assert result == {"error": "invalid material"}
    db.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_create_async_video_card_returns_validation_error() -> None:
    create = AsyncMock(side_effect=ValueError("invalid task URL"))
    with patch(
        "app.mcp_server.tools.cards.async_video_card_service.create",
        new=create,
    ):
        result = await create_async_video_card(
            token_info=TOKEN_INFO,
            task_url="file:///tmp/task.json",
        )

    assert result == {"error": "invalid task URL"}
    assert create.await_args.kwargs["preview_title"] == ""
    assert create.await_args.kwargs["progress_text"] == ""
