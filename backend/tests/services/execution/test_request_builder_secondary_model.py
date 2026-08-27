# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Secondary model resolution for generation-model Chat agents."""

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.services.execution.request_builder import TaskRequestBuilder


@pytest.mark.parametrize("task_type", ["video", "image"])
def test_direct_generation_task_retains_primary_generation_model(
    task_type: str,
) -> None:
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = SimpleNamespace(
        json={"metadata": {"labels": {"taskType": task_type}}},
    )

    assert builder._should_use_secondary_model_for_generation_chat(task) is False


@pytest.mark.parametrize("task_type", ["chat", "code", None])
def test_non_generation_task_uses_secondary_model_for_generation_bot(
    task_type: str | None,
) -> None:
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    labels = {} if task_type is None else {"taskType": task_type}
    task = SimpleNamespace(json={"metadata": {"labels": labels}})

    assert builder._should_use_secondary_model_for_generation_chat(task) is True


def _resolve_model(
    *,
    secondary_model: dict | None,
    use_secondary_model_for_chat: bool,
    primary_model: dict | None = None,
    resolution_meta: dict[str, bool] | None = None,
) -> dict:
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    builder.db = Mock()
    bot = SimpleNamespace(
        name="test-video-bot",
        json={"spec": {"agent_config": {}}},
    )

    with (
        patch(
            "app.services.chat.config.model_resolver.get_model_config_for_bot",
            return_value=primary_model or {"modelType": "video", "model": "seedance"},
        ),
        patch(
            "app.services.chat.config.model_resolver._process_model_config_placeholders",
            side_effect=lambda **kwargs: dict(kwargs["model_config"]),
        ),
        patch.object(
            builder,
            "_get_secondary_model_config",
            return_value=secondary_model,
        ),
    ):
        return builder._get_model_config(
            bot=bot,
            user_id=7,
            user_name="director",
            override_model_name=None,
            force_override=False,
            task_id=11,
            team_id=13,
            use_secondary_model_for_chat=use_secondary_model_for_chat,
            resolution_meta=resolution_meta,
        )


def test_generation_chat_uses_secondary_planning_llm() -> None:
    planning_model = {"modelType": "llm", "model": "planning-llm"}
    resolution_meta: dict[str, bool] = {}

    result = _resolve_model(
        secondary_model=planning_model,
        use_secondary_model_for_chat=True,
        resolution_meta=resolution_meta,
    )

    assert result == planning_model
    assert resolution_meta == {"used_secondary_model": True}


def test_generation_path_retains_video_model_and_exposes_secondary_llm() -> None:
    planning_model = {"modelType": "llm", "model": "planning-llm"}

    result = _resolve_model(
        secondary_model=planning_model,
        use_secondary_model_for_chat=False,
    )

    assert result == {
        "modelType": "video",
        "model": "seedance",
        "secondary_model_config": planning_model,
    }


def test_generation_chat_requires_secondary_model() -> None:
    with pytest.raises(ValueError, match="requires an LLM secondary model"):
        _resolve_model(
            secondary_model=None,
            use_secondary_model_for_chat=True,
        )


def test_llm_primary_model_is_not_replaced_by_secondary_model() -> None:
    result = _resolve_model(
        primary_model={"modelType": "llm", "model": "chat-model"},
        secondary_model={"modelType": "llm", "model": "planning-llm"},
        use_secondary_model_for_chat=True,
    )

    assert result == {"modelType": "llm", "model": "chat-model"}


def test_generation_chat_requires_llm_secondary_model() -> None:
    with pytest.raises(ValueError, match="must be an LLM"):
        _resolve_model(
            secondary_model={"modelType": "video", "model": "another-video-model"},
            use_secondary_model_for_chat=True,
        )
