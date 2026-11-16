# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Private Python runtime transport and lifecycle contracts."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sse_starlette.sse import ServerSentEvent

from app.core.config import settings
from app.services.execution.package_runtime import (
    PACKAGE_RUNTIME_PATH,
    mount_package_runtime,
    package_runtime_lifespan,
)


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "package")
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "unit-package-token")
    app = FastAPI()
    mount_package_runtime(app)
    return TestClient(app)


@pytest.mark.parametrize("token", [None, "wrong-token"])
def test_engine_rejects_requests_without_internal_credentials(runtime, token):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = runtime.post(
        f"{PACKAGE_RUNTIME_PATH}/v1/responses",
        headers=headers,
        json={"model": "mock", "input": "hello", "stream": True},
    )
    assert response.status_code == 401


def test_http_mode_does_not_mount_embedded_engine(monkeypatch):
    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "http")
    app = FastAPI()
    mount_package_runtime(app)
    assert (
        TestClient(app).post(f"{PACKAGE_RUNTIME_PATH}/v1/responses").status_code == 404
    )


def test_image_runtime_in_http_mode_streams_the_agent_result(monkeypatch):
    from app.services.chat.storage.session import session_manager
    from app.services.execution.agents.image import image_agent
    from app.services.execution.agents.image.providers.base import (
        ImageGenerationResult,
        ImageResult,
    )

    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "http")
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "unit-image-token")
    monkeypatch.setattr(session_manager, "is_cancelled", AsyncMock(return_value=False))
    register = AsyncMock()
    unregister = AsyncMock()
    monkeypatch.setattr(session_manager, "register_stream", register)
    monkeypatch.setattr(session_manager, "unregister_stream", unregister)
    provider = AsyncMock(name="image-provider")
    provider.generate.return_value = ImageGenerationResult(
        images=[ImageResult(url="https://images.example.com/generated.png")],
        model="gpt-image-e2e",
    )
    selected = []

    def select_provider(protocol, config):
        selected.append((protocol, config["model_id"]))
        return provider

    monkeypatch.setattr(image_agent, "get_image_provider", select_provider)
    upload = AsyncMock(return_value=41)
    monkeypatch.setattr(image_agent.ImageAgent, "_upload_attachment", upload)
    app = FastAPI()
    mount_package_runtime(app)
    client = TestClient(app)
    path = f"{PACKAGE_RUNTIME_PATH}/v1/image-execution"
    reference = "https://images.example.com/reference.png"
    request = {
        "task_id": 7,
        "subtask_id": 8,
        "message_id": 2,
        "user": {"id": 9},
        "prompt": "Draw a blue square",
        "attachments": [{"mime_type": "image/png", "url": reference}],
        "model_config": {
            "modelType": "image",
            "protocol": "gpt-image",
            "model_id": "gpt-image-e2e",
        },
    }

    assert client.post(path, json=request).status_code == 401
    provider.generate.assert_not_awaited()
    response = client.post(
        path, json=request, headers={"Authorization": "Bearer unit-image-token"}
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == ["start", "chunk", "done"]
    assert all(
        event["subtask_id"] == 8 and event["message_id"] == 2 for event in events
    )
    placeholder = events[1]["result"]["blocks"][0]
    result = events[2]["result"]["blocks"][0]
    assert placeholder["is_placeholder"] is True
    assert result["id"] == placeholder["id"]
    assert result["image_attachment_ids"] == [41]
    assert result["image_download_urls"]
    assert selected == [("gpt-image", "gpt-image-e2e")]
    provider.generate.assert_awaited_once_with(
        prompt="Draw a blue square", reference_images=[reference]
    )
    assert upload.await_args.kwargs["user_id"] == 9
    register.assert_not_awaited()
    unregister.assert_not_awaited()


def test_embedded_engine_reuses_chat_shell_sse(runtime, monkeypatch):
    from chat_shell.api.v1 import response as engine

    received = []

    async def stream(request, request_id):
        received.append((request.metadata, request_id))
        yield ServerSentEvent(
            event="response.completed", data='{"type":"response.completed"}'
        )

    monkeypatch.setattr(engine, "_stream_response", stream)
    response = runtime.post(
        f"{PACKAGE_RUNTIME_PATH}/v1/responses",
        headers={
            "Authorization": "Bearer unit-package-token",
            "X-Request-ID": "package-1",
        },
        json={
            "model": "mock",
            "input": "hello",
            "stream": True,
            "metadata": {"task_id": 7},
        },
    )
    assert response.status_code == 200
    assert "event: response.completed" in response.text
    assert received == [({"task_id": 7}, "package-1")]


@pytest.mark.asyncio
@pytest.mark.parametrize("completed", [True, False])
async def test_package_shutdown_drains_or_cancels_engine_streams(
    monkeypatch, completed
):
    from chat_shell.core import shutdown

    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "package")
    manager = AsyncMock()
    manager.wait_for_streams.return_value = completed
    monkeypatch.setattr(shutdown, "shutdown_manager", manager)
    async with package_runtime_lifespan():
        manager.initiate_shutdown.assert_not_awaited()
    manager.initiate_shutdown.assert_awaited_once()
    manager.wait_for_streams.assert_awaited_once_with(
        timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT
    )
    assert manager.cancel_all_streams.await_count == (0 if completed else 1)
