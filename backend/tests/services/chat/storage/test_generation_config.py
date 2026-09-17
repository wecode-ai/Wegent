# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generation settings must survive task creation for refresh and retry."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.models.user import User
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    create_task_and_subtasks,
)
from tests.services.chat.storage.test_task_manager import _build_existing_task


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("task_type", "config_key"),
    [("image", "image_config"), ("video", "video_config"), ("chat", "video_config")],
)
async def test_generation_config_preserves_media_type(
    test_db: Session, test_user: User, task_type: str, config_key: str
) -> None:
    task = _build_existing_task(task_id=2503, user_id=test_user.id)
    task.client_origin = CLIENT_ORIGIN_FRONTEND
    test_db.add(task)
    test_db.commit()
    team = SimpleNamespace(
        id=1256, user_id=test_user.id, name="generate", namespace="default"
    )
    params = TaskCreationParams(
        message="generate media",
        task_type=task_type,
        model_id="selected-model",
        generate_params={"model": "selected-model", "size": "1512x648"},
        pipeline_bot_ids=[1255],
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    with (
        patch(
            "app.services.chat.storage.task_manager.initialize_redis_chat_history",
            new=AsyncMock(),
        ),
        patch("app.services.memory.is_memory_enabled_for_user", return_value=False),
        patch(
            "app.services.chat.trigger.group_chat.is_task_group_chat",
            return_value=False,
        ),
    ):
        result = await create_task_and_subtasks(
            db=test_db,
            user=test_user,
            team=team,
            message=params.message,
            params=params,
            task_id=task.id,
        )

    test_db.refresh(result.user_subtask)
    stored = result.user_subtask.result
    assert stored[config_key]["model"] == "selected-model"
    if task_type == "image":
        assert stored[config_key]["size"] == "1512x648"
        assert "video_config" not in stored
    else:
        assert "image_config" not in stored
