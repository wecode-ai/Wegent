# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.services import prompt_draft_service


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_generate_prompt_draft_success(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft",
        return_value={
            "title": "产品协作提示词",
            "prompt": "你是产品协作助手，负责帮助我沉淀协作方式。",
            "model": "test-model",
            "version": 1,
            "created_at": datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc),
        },
    ):
        response = test_client.post(
            "/api/tasks/1/prompt-drafts/generate",
            headers=_auth_header(test_token),
            json={"model": "test-model", "source": "pet_panel"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["title"] == "产品协作提示词"
    assert payload["prompt"].startswith("你是")
    assert payload["model"] == "test-model"
    assert payload["version"] == 1
    assert "created_at" in payload


def test_generate_prompt_draft_not_found(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft",
        side_effect=ValueError("task_not_found"),
    ):
        response = test_client.post(
            "/api/tasks/999999/prompt-drafts/generate",
            headers=_auth_header(test_token),
            json={},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Task not found"


def test_generate_prompt_draft_invalid_conversation(
    test_client: TestClient, test_token: str
):
    with patch(
        "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft",
        side_effect=RuntimeError("conversation_too_short"),
    ):
        response = test_client.post(
            "/api/tasks/1/prompt-drafts/generate",
            headers=_auth_header(test_token),
            json={},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Conversation is too short to generate prompt"


def test_generate_prompt_draft_requires_available_model(
    test_client: TestClient, test_token: str
):
    with patch(
        "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft",
        side_effect=prompt_draft_service.PromptDraftModelUnavailableError(
            "prompt_draft_model_unavailable"
        ),
    ):
        response = test_client.post(
            "/api/tasks/1/prompt-drafts/generate",
            headers=_auth_header(test_token),
            json={},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "No available model for prompt draft generation"


def test_generate_prompt_draft_returns_502_when_generation_fails(
    test_client: TestClient, test_token: str
):
    with patch(
        "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft",
        side_effect=prompt_draft_service.PromptDraftGenerationFailedError(
            "prompt_draft_generation_failed"
        ),
    ):
        response = test_client.post(
            "/api/tasks/1/prompt-drafts/generate",
            headers=_auth_header(test_token),
            json={},
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "Prompt draft generation failed"


def test_generate_prompt_draft_stream_success(test_client: TestClient, test_token: str):
    async def _mock_stream(*args, **kwargs):
        del args, kwargs
        yield {"type": "prompt_delta", "delta": "你是"}
        yield {"type": "prompt_done", "prompt": "你是协作助手..."}
        yield {"type": "title_done", "title": "协作提示词"}
        yield {
            "type": "completed",
            "data": {
                "title": "协作提示词",
                "prompt": "你是协作助手...",
                "model": "test-model",
                "version": 1,
                "created_at": "2026-03-28T00:00:00+00:00",
            },
        }

    with (
        patch(
            "app.api.endpoints.adapter.tasks.prompt_draft_service.validate_prompt_draft_context",
            return_value=None,
        ),
        patch(
            "app.api.endpoints.adapter.tasks.prompt_draft_service.generate_prompt_draft_stream",
            side_effect=_mock_stream,
        ),
    ):
        response = test_client.post(
            "/api/tasks/1/prompt-drafts/generate/stream",
            headers=_auth_header(test_token),
            json={"model": "test-model", "source": "pet_panel"},
        )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert '"type": "completed"' in response.text
