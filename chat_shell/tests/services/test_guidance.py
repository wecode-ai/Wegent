# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell guidance consumption."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from chat_shell.agents.graph_builder import LangGraphAgentBuilder
from chat_shell.services.guidance import (
    GuidanceConsumer,
    GuidanceItem,
    RemoteGuidanceQueueClient,
)


class FakeGuidanceQueue:
    """In-memory guidance queue for consumer tests."""

    def __init__(self, item: GuidanceItem | None = None):
        self.item = item
        self.consume_calls: list[tuple[int, int]] = []
        self.expire_calls: list[tuple[int, int]] = []

    async def consume(self, task_id: int, subtask_id: int) -> GuidanceItem | None:
        self.consume_calls.append((task_id, subtask_id))
        item = self.item
        self.item = None
        return item

    async def expire(self, task_id: int, subtask_id: int) -> None:
        self.expire_calls.append((task_id, subtask_id))


class FakeResponse:
    """Minimal HTTP response object for remote client tests."""

    def __init__(self, payload: dict):
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class FakeHttpClient:
    """Records POST paths and returns queued responses."""

    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.post_calls: list[str] = []

    async def post(self, path: str) -> FakeResponse:
        self.post_calls.append(path)
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_pre_model_hook_appends_guidance_human_message_and_emits_block():
    queue = FakeGuidanceQueue(GuidanceItem(guidance_id="g-1", message="Prefer tests."))
    emitter = AsyncMock()
    consumer = GuidanceConsumer(task_id=10, subtask_id=20, queue=queue, emitter=emitter)
    hook = consumer.create_pre_model_hook()

    messages = [SystemMessage(content="System"), HumanMessage(content="Original")]

    result = await hook({"messages": messages})

    llm_messages = result["llm_input_messages"]
    assert llm_messages[:-1] == messages
    assert isinstance(llm_messages[-1], HumanMessage)
    assert "Prefer tests." in llm_messages[-1].content
    assert queue.consume_calls == [(10, 20)]
    emitter.block_created.assert_awaited_once()
    block = emitter.block_created.await_args.args[0]
    assert block["type"] == "guidance"
    assert block["guidance_id"] == "g-1"
    assert block["content"] == "Prefer tests."
    assert block["status"] == "done"


@pytest.mark.asyncio
async def test_pre_model_hook_consumes_only_once():
    queue = FakeGuidanceQueue(GuidanceItem(guidance_id="g-1", message="Once."))
    emitter = AsyncMock()
    consumer = GuidanceConsumer(task_id=10, subtask_id=20, queue=queue, emitter=emitter)
    hook = consumer.create_pre_model_hook()

    messages = [HumanMessage(content="Original")]

    first = await hook({"messages": messages})
    second = await hook({"messages": messages})

    assert len(first["llm_input_messages"]) == 2
    assert second["llm_input_messages"] == messages
    assert queue.consume_calls == [(10, 20)]
    emitter.block_created.assert_awaited_once()


@pytest.mark.asyncio
async def test_expire_pending_delegates_to_queue():
    queue = FakeGuidanceQueue()
    consumer = GuidanceConsumer(
        task_id=10, subtask_id=20, queue=queue, emitter=AsyncMock()
    )

    await consumer.expire_pending()
    await consumer.expire_pending()

    assert queue.expire_calls == [(10, 20)]


@pytest.mark.asyncio
async def test_remote_guidance_queue_client_uses_internal_chat_guidance_endpoints():
    http_client = FakeHttpClient(
        [
            FakeResponse(
                {
                    "item": {
                        "guidance_id": "g-1",
                        "message": "Prefer examples.",
                    }
                }
            ),
            FakeResponse({"expired_ids": ["g-2"]}),
        ]
    )
    client = RemoteGuidanceQueueClient(base_url="http://backend/api/internal")
    client._client = http_client

    item = await client.consume(task_id=10, subtask_id=20)
    await client.expire(task_id=10, subtask_id=20)

    assert item == GuidanceItem(guidance_id="g-1", message="Prefer examples.")
    assert http_client.post_calls == [
        "/chat/guidance/10/20/consume",
        "/chat/guidance/10/20/expire",
    ]


def test_langgraph_agent_builder_passes_pre_model_hook_to_create_react_agent():
    pre_model_hook = MagicMock()
    builder = LangGraphAgentBuilder(llm=MagicMock(), pre_model_hook=pre_model_hook)

    with patch("chat_shell.agents.graph_builder.create_react_agent") as create_agent:
        builder._build_agent()

    assert create_agent.call_args.kwargs["pre_model_hook"] is pre_model_hook
