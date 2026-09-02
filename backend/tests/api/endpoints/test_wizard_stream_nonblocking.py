# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace

import pytest

from app.api.endpoints import wizard
from app.schemas.wizard import TestPromptRequest as PromptTestRequest
from app.services.wizard_db import WizardModelPlan


@pytest.mark.asyncio
async def test_wizard_stream_model_resolution_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []

    def blocking_resolve(user_id, user_name, model_name):
        worker_thread_ids.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return WizardModelPlan(config={"model": "openai", "model_id": "resolved"})

    monkeypatch.setattr(
        wizard.wizard_db_service,
        "resolve_model_config",
        blocking_resolve,
    )
    calls = []

    async def worker_stream(operation, payload):
        calls.append((operation, payload))
        yield b"data: done\n\n"

    monkeypatch.setattr(wizard.web_stream_worker_client, "stream", worker_stream)

    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(
        wizard.test_system_prompt_stream(
            PromptTestRequest(
                system_prompt="system",
                test_message="hello",
                model_name="model",
            ),
            current_user=SimpleNamespace(id=1, user_name="user"),
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
    frames = [frame async for frame in response.body_iterator]
    assert frames == [b"data: done\n\n"]
    assert calls == [
        (
            "wizard_prompt",
            {
                "message": "hello",
                "model_config": {"model": "openai", "model_id": "resolved"},
                "system_prompt": "system",
            },
        )
    ]
