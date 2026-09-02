# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import sys
import threading
from types import SimpleNamespace

import pytest

from app.core import payload_codec
from app.models.subtask import SubtaskRole
from app.services.execution.agents import base_intent_analyzer
from app.services.execution.agents.image.intent_analyzer import ImageIntentAnalyzer


@pytest.mark.asyncio
async def test_image_intent_history_does_not_block_event_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    session = SimpleNamespace(close=lambda: None)

    def blocking_history(*args, **kwargs):
        del args, kwargs
        started.set()
        assert release.wait(timeout=1)
        return [
            SimpleNamespace(role=SubtaskRole.USER, prompt="previous"),
            SimpleNamespace(role=SubtaskRole.ASSISTANT, result={"blocks": []}),
        ]

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: session)
    monkeypatch.setattr(
        "app.stores.tasks.subtask_store.list_by_task_ordered",
        blocking_history,
    )

    task = asyncio.create_task(
        ImageIntentAnalyzer().analyze(
            task_id=1,
            current_prompt="current",
            secondary_model_config=None,
        )
    )
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.001)
    assert started.is_set()

    loop_ticked = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_ticked.set)
    await asyncio.wait_for(loop_ticked.wait(), timeout=0.1)
    release.set()

    result = await task
    assert result.merged_prompt == "current"
    assert result.is_followup is False


@pytest.mark.asyncio
async def test_intent_json_decode_runs_outside_event_loop(monkeypatch) -> None:
    loop_thread = threading.get_ident()
    decode_thread: int | None = None
    original_loads = json.loads
    content = json.dumps(
        {
            "value": "x" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES,
        }
    )

    def observed_loads(value: str):
        nonlocal decode_thread
        decode_thread = threading.get_ident()
        return original_loads(value)

    class Completions:
        async def create(self, **kwargs):
            del kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

    class Client:
        def __init__(self, **kwargs) -> None:
            del kwargs
            self.chat = SimpleNamespace(completions=Completions())

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

    monkeypatch.setitem(
        sys.modules,
        "openai",
        SimpleNamespace(AsyncOpenAI=Client),
    )
    monkeypatch.setattr(base_intent_analyzer.json, "loads", observed_loads)

    result = await ImageIntentAnalyzer()._call_llm_json(
        "prompt",
        {"api_key": "key", "base_url": "https://example.com"},
    )

    assert result == {
        "value": "x" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES,
    }
    assert decode_thread is not None
    assert decode_thread != loop_thread
