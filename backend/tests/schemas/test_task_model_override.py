# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.shared_task import JoinSharedTaskRequest
from app.schemas.task import TaskCreate, TaskModelOverride
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


def test_task_model_override_normalizes_complete_task_labels():
    override = TaskModelOverride.from_task_labels(
        {
            "modelId": " model ",
            "modelNamespace": " team-platform ",
            "forceOverrideBotModelType": " group ",
            "forceOverrideBotModel": "true",
        }
    )

    assert override == TaskModelOverride(
        name="model",
        namespace="team-platform",
        model_type="group",
        force=True,
    )


def test_task_model_override_preserves_legacy_name_only_labels():
    assert TaskModelOverride.from_task_labels({"modelId": "legacy-model"}) == (
        TaskModelOverride(name="legacy-model")
    )
    assert TaskModelOverride.from_task_labels({"modelId": "  "}) is None


def test_task_model_override_treats_blank_reference_labels_as_legacy():
    override = TaskModelOverride.from_task_labels(
        {
            "modelId": "legacy-model",
            "modelNamespace": "  ",
            "forceOverrideBotModelType": "\t",
        }
    )

    assert override == TaskModelOverride(name="legacy-model")
