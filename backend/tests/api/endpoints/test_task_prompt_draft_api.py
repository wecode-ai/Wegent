# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api.endpoints.adapter import tasks as tasks_endpoint
from app.schemas.task import PromptDraftGenerateRequest
from app.services import prompt_draft_service
from app.services.execution.stream_client import StreamWorkerExecutionError


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _prompt_context() -> prompt_draft_service.PromptDraftContext:
    return prompt_draft_service.PromptDraftContext(
        task_id=1,
        user_id=2,
        selected_model="test-model",
        model_config={"model_id": "test-model"},
        conversation_blocks=(("user", "hello"), ("assistant", "hi")),
    )


def test_generate_prompt_draft_success(test_client: TestClient, test_token: str):
    with (
        patch(
            "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
            return_value=_prompt_context(),
        ),
        patch(
            "app.api.endpoints.adapter.tasks.web_stream_worker_client.execute",
            new=AsyncMock(
                return_value={
                    "title": "产品协作提示词",
                    "prompt": "你是产品协作助手，负责帮助我沉淀协作方式。",
                    "model": "test-model",
                    "version": 1,
                    "created_at": datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc),
                }
            ),
        ),
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
        "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
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
        "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
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
        "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
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
    with (
        patch(
            "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
            return_value=_prompt_context(),
        ),
        patch(
            "app.api.endpoints.adapter.tasks.web_stream_worker_client.execute",
            new=AsyncMock(
                side_effect=StreamWorkerExecutionError(
                    "Prompt draft generation failed",
                    error_code="prompt_draft_generation_failed",
                    status_code=502,
                )
            ),
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
    calls = []

    async def _worker_stream(operation, payload):
        calls.append((operation, payload))
        yield b'data: {"type": "prompt_delta", "delta": "\xe4\xbd\xa0\xe6\x98\xaf"}\n\n'
        yield b'data: {"type": "completed", "data": {"prompt": "done"}}\n\n'

    with (
        patch(
            "app.api.endpoints.adapter.tasks.prompt_draft_service.prepare_prompt_draft_stream_context",
            return_value=_prompt_context(),
        ),
        patch(
            "app.api.endpoints.adapter.tasks.web_stream_worker_client.stream",
            new=_worker_stream,
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
    assert calls[0][0] == "prompt_draft"
    assert calls[0][1]["context"]["selected_model"] == "test-model"


@pytest.mark.asyncio
async def test_prompt_draft_db_preparation_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []

    def blocking_prepare(task_id, user_id, user_name, model):
        worker_thread_ids.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return _prompt_context()

    monkeypatch.setattr(
        tasks_endpoint.prompt_draft_service,
        "prepare_prompt_draft_stream_context",
        blocking_prepare,
    )
    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(
        tasks_endpoint.generate_task_prompt_draft_stream(
            PromptDraftGenerateRequest(model="model"),
            task_id=1,
            current_user=SimpleNamespace(id=2, user_name="user"),
        )
    )
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.005)
        assert started.is_set()
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
        assert worker_thread_ids[0] != loop_thread_id
    finally:
        release.set()

    response = await task
    assert response.media_type == "text/event-stream"
