# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api.endpoints.adapter import model_runtime
from app.schemas.model_runtime import StatelessResponseCreateRequest


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_stateless_response_success(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.model_runtime.web_stream_worker_client.execute",
        new=AsyncMock(return_value={"output_text": "hello from runtime"}),
    ):
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "gpt-5.4",
                "input": [{"role": "user", "content": "say hello"}],
                "stream": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["output_text"] == "hello from runtime"
    assert payload["model"] == "gpt-5.4"
    assert "created_at" in payload


def test_create_stateless_response_accepts_string_input(
    test_client: TestClient, test_token: str
):
    with patch(
        "app.api.endpoints.adapter.model_runtime.web_stream_worker_client.execute",
        new=AsyncMock(return_value={"output_text": "ok"}),
    ) as mock_execute:
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "gpt-5.4",
                "input": "direct question",
                "stream": False,
            },
        )

    assert response.status_code == 200
    _, payload = mock_execute.await_args.args
    assert payload["input"] == "direct question"


def test_streaming_response_only_relays_worker_bytes(
    test_client: TestClient,
    test_token: str,
) -> None:
    calls = []

    async def worker_stream(operation, payload):
        calls.append((operation, payload))
        yield b'data: {"type":"response.output_text.delta"}\n\n'

    with patch(
        "app.api.endpoints.adapter.model_runtime.web_stream_worker_client.stream",
        new=worker_stream,
    ):
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "gpt-5.4",
                "input": "hello",
                "stream": True,
            },
        )

    assert response.status_code == 200
    assert response.content == b'data: {"type":"response.output_text.delta"}\n\n'
    assert calls == [
        (
            "model_runtime",
            {
                "model": "gpt-5.4",
                "input": "hello",
                "instructions": None,
                "metadata": None,
                "model_config": None,
                "tools": None,
            },
        )
    ]


def test_create_stateless_response_resolves_model_reference(
    test_client: TestClient, test_token: str
):
    resolved_config = {
        "model": "openai",
        "model_id": "upstream-model",
        "base_url": "https://model.example.com/v1",
        "api_key": "secret",
    }
    with (
        patch(
            "app.api.endpoints.adapter.model_runtime._resolve_model_reference_sync",
            return_value=resolved_config,
        ) as mock_resolve,
        patch(
            "app.api.endpoints.adapter.model_runtime.web_stream_worker_client.execute",
            new=AsyncMock(
                return_value={
                    "output_text": '{"correction":null,"rationale":"aligned"}'
                }
            ),
        ) as mock_execute,
    ):
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "review-model",
                "model_ref": {
                    "name": "review-model",
                    "type": "public",
                    "namespace": "default",
                    "resource_user_id": 0,
                },
                "input": "review this",
                "stream": False,
            },
        )

    assert response.status_code == 200
    assert response.json()["model"] == "upstream-model"
    assert mock_resolve.call_args.args[0].name == "review-model"
    assert mock_execute.await_args.args[1]["model_config"] == resolved_config


@pytest.mark.asyncio
async def test_model_reference_db_resolution_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []

    def blocking_resolve(reference, user_id, user_name):
        worker_thread_ids.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return {"model_id": "resolved-model"}

    monkeypatch.setattr(
        model_runtime,
        "_resolve_model_reference_sync",
        blocking_resolve,
    )
    monkeypatch.setattr(
        model_runtime.web_stream_worker_client,
        "execute",
        AsyncMock(return_value={"output_text": "ok"}),
    )
    request = StatelessResponseCreateRequest.model_validate(
        {
            "model": "requested-model",
            "model_ref": {
                "name": "requested-model",
                "type": "public",
                "namespace": "default",
                "resource_user_id": 0,
            },
            "input": "hello",
        }
    )
    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(
        model_runtime.create_stateless_response(
            request,
            current_user=SimpleNamespace(id=7, user_name="user"),
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

    result = await task
    assert result.model == "resolved-model"
