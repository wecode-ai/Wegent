# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.execution.agents.generation_context import (
    GenerationContext,
    resolve_generation_model,
)


def test_resolve_generation_model_uses_available_category_fallback() -> None:
    context = GenerationContext(
        user=MagicMock(),
        task=MagicMock(),
        subtask=MagicMock(),
        team=MagicMock(),
        model_config={"modelType": "llm"},
    )

    with (
        patch(
            "app.services.execution.agents.generation_context."
            "model_aggregation_service.list_available_models",
            return_value=[{"name": "image-model", "type": "public"}],
        ) as list_models,
        patch(
            "app.services.execution.agents.generation_context."
            "settings.DEFAULT_IMAGE_GENERATION_MODEL",
            "",
        ),
        patch(
            "app.services.execution.agents.generation_context._build_request",
            return_value=SimpleNamespace(
                model_config={"modelType": "image", "model_id": "gpt-image-2"}
            ),
        ) as build_request,
    ):
        result = resolve_generation_model(
            db=MagicMock(),
            context=context,
            prompt="draw",
            model_type="image",
        )

    assert result["modelType"] == "image"
    assert list_models.call_args.kwargs["model_category_type"] == "image"
    assert build_request.call_args.kwargs["override_model_name"] == "image-model"
    assert build_request.call_args.kwargs["force_override"] is True


def test_resolve_generation_model_uses_configured_default() -> None:
    context = GenerationContext(
        user=MagicMock(),
        task=MagicMock(),
        subtask=MagicMock(),
        team=MagicMock(),
        model_config={"modelType": "llm"},
    )

    with (
        patch(
            "app.services.execution.agents.generation_context."
            "settings.DEFAULT_IMAGE_GENERATION_MODEL",
            "preferred-image-model",
        ),
        patch(
            "app.services.execution.agents.generation_context."
            "model_aggregation_service.list_available_models",
            return_value=[
                {"name": "another-image-model", "type": "user"},
                {"name": "preferred-image-model", "type": "public"},
            ],
        ),
        patch(
            "app.services.execution.agents.generation_context._build_request",
            return_value=SimpleNamespace(
                model_config={"modelType": "image", "model_id": "gpt-image-2"}
            ),
        ) as build_request,
    ):
        result = resolve_generation_model(
            db=MagicMock(),
            context=context,
            prompt="draw",
            model_type="image",
        )

    assert result["modelType"] == "image"
    assert (
        build_request.call_args.kwargs["override_model_name"] == "preferred-image-model"
    )


def test_resolve_generation_model_rejects_unavailable_configured_default() -> None:
    context = GenerationContext(
        user=MagicMock(),
        task=MagicMock(),
        subtask=MagicMock(),
        team=MagicMock(),
        model_config={"modelType": "llm"},
    )

    with (
        patch(
            "app.services.execution.agents.generation_context."
            "settings.DEFAULT_VIDEO_GENERATION_MODEL",
            "missing-video-model",
        ),
        patch(
            "app.services.execution.agents.generation_context."
            "model_aggregation_service.list_available_models",
            return_value=[{"name": "available-video-model", "type": "public"}],
        ),
        patch(
            "app.services.execution.agents.generation_context._build_request"
        ) as build_request,
    ):
        try:
            resolve_generation_model(
                db=MagicMock(),
                context=context,
                prompt="animate",
                model_type="video",
            )
        except ValueError as exc:
            assert str(exc) == (
                "Configured default video model "
                "'missing-video-model' is not available"
            )
        else:
            raise AssertionError("Expected unavailable default model to fail")

    build_request.assert_not_called()
