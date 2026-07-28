# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.shared_task import JoinSharedTaskRequest
from app.schemas.task import TaskCreate
from app.services.chat.storage import TaskCreationParams


def test_task_create_model_id_defaults_to_force_override():
    task = TaskCreate(prompt="hello", model_id="gpt-5")

    assert task.force_override_bot_model is True


def test_join_shared_task_model_id_defaults_to_force_override():
    request = JoinSharedTaskRequest(share_token="token", model_id="gpt-5")

    assert request.force_override_bot_model is True


def test_task_creation_params_model_id_defaults_to_force_override():
    params = TaskCreationParams(message="hello", model_id="gpt-5")

    assert params.force_override_bot_model is True
