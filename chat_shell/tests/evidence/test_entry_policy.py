"""The chat entry's internal capability controls native evidence behavior."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import SystemMessage, ToolMessage, convert_to_messages
from langchain_core.tools import StructuredTool

from chat_shell.agent import ChatAgent
from chat_shell.services import chat_service as module
from chat_shell.services.answer_evidence import active_evidence, wrap_native_search
from shared.models import (
    EmitterBuilder,
    ExecutionRequest,
    GeneratorTransport,
    OpenAIRequestConverter,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,enabled",
    [
        ("package", False),
        ("package", True),
        ("http", False),
        ("http", True),
        ("http-wrong-token", False),
        ("http-unconfigured", False),
        ("http-existing-token-alias", True),
    ],
)
async def test_chat_entry_controls_native_tool_output_and_model_input(
    monkeypatch, enabled, mode
):
    monkeypatch.setattr(
        "chat_shell.compression.token_counter._get_encoding_for_model",
        lambda *args: SimpleNamespace(
            encode=lambda text, **kwargs: list(text),
            decode=lambda tokens: "".join(tokens),
        ),
    )
    chunk = {
        "content": "Original evidence",
        "title": "Document",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    raw = json.dumps({"mode": "rag_retrieval", "chunks": [chunk]})

    async def search(query: str) -> str:
        return raw

    tool = wrap_native_search(
        StructuredTool.from_function(
            coroutine=search,
            name="wegent_kb_search_knowledge_base",
            description="Search",
        ),
        "http://backend/api/mcp/knowledge",
        "http://backend",
    )
    captured = {}

    async def stream(*, config, messages, **kwargs):
        output = await tool._arun(query="document")
        captured["tool_output"] = output
        messages = [
            *convert_to_messages(messages),
            ToolMessage(
                content=output, name=tool.name, tool_call_id="search", id="result"
            ),
        ]
        state = await config.pre_model_hook({"messages": messages})
        captured["model_input"] = state.get("llm_input_messages", messages)
        yield "Answer"

    context = SimpleNamespace(
        prepare=AsyncMock(
            return_value=SimpleNamespace(
                history=[], extra_tools=[tool], system_prompt="Answer the question"
            )
        ),
        cleanup=AsyncMock(),
    )
    agent = SimpleNamespace(
        build_messages=ChatAgent().build_messages,
        create_agent_builder=lambda config: SimpleNamespace(),
        stream=stream,
    )
    monkeypatch.setattr(module, "ChatContext", lambda request: context)
    monkeypatch.setattr("chat_shell.create_chat_agent", lambda **kwargs: agent)
    monkeypatch.setattr(module.settings, "MESSAGE_COMPRESSION_ENABLED", False)
    monkeypatch.setattr(
        "chat_shell.services.sandbox_attachment_sync.sync_chat_attachments_to_sandbox",
        AsyncMock(),
    )
    queue = SimpleNamespace(consume=AsyncMock(return_value=None), expire=AsyncMock())
    monkeypatch.setattr(module, "create_guidance_queue_client", lambda: queue)
    monkeypatch.setattr(
        module,
        "create_tool_event_handler",
        lambda *args: SimpleNamespace(wait_pending=AsyncMock()),
    )
    service = module.ChatService()
    service._storage = SimpleNamespace(
        register_stream=AsyncMock(return_value=asyncio.Event()),
        unregister_stream=AsyncMock(),
    )
    transport = GeneratorTransport()
    emitter = EmitterBuilder().with_task(1, 2).with_transport(transport).build()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        user_id=3,
        prompt="Read",
        enable_answer_evidence=enabled,
    )

    if mode.startswith("http"):
        from chat_shell.api.v1.response import router

        monkeypatch.setattr(module, "chat_service", service)
        monkeypatch.setattr(
            module.settings, "INTERNAL_SERVICE_TOKEN", "test-service-token"
        )
        monkeypatch.setattr(module.settings, "REMOTE_STORAGE_TOKEN", "")
        wire = OpenAIRequestConverter.from_execution_request(request)
        # An unauthenticated API caller cannot activate the internal capability.
        wire["metadata"]["enable_answer_evidence"] = True
        headers = {"Authorization": "Bearer test-service-token"} if enabled else {}
        if mode == "http-wrong-token":
            headers = {"Authorization": "Bearer wrong-token"}
        if mode == "http-unconfigured":
            monkeypatch.setattr(module.settings, "INTERNAL_SERVICE_TOKEN", "")
            headers = {"Authorization": "Bearer test-service-token"}
        if mode == "http-existing-token-alias":
            monkeypatch.setattr(module.settings, "INTERNAL_SERVICE_TOKEN", "")
            monkeypatch.setattr(
                module.settings, "REMOTE_STORAGE_TOKEN", "test-service-token"
            )
        app = FastAPI()
        app.include_router(router)
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/v1/responses", json=wire, headers=headers)
        assert response.status_code == 200
        events = [
            json.loads(line[6:])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]
        completed = next(
            data["response"] for data in events if data["type"] == "response.completed"
        )
    else:
        await service.chat(request, emitter)
        completed = next(
            data["response"]
            for event, data in transport.get_events()
            if event == "response.completed"
        )

    system_input = "\n".join(
        message.content
        for message in captured["model_input"]
        if isinstance(message, SystemMessage)
    )
    if enabled:
        assert "<answer_evidence>" in system_input
        assert "[[evidence:<evidence_id>]]" in system_input
        unit = json.loads(captured["tool_output"])["chunks"][0]
        assert unit["content"] == chunk["content"]
        assert f'[[evidence:{unit["evidence_id"]}]]' in str(captured["model_input"])
        assert completed["_answer_evidence"] == [unit]
    else:
        assert system_input == "Answer the question"
        assert captured["tool_output"] == raw
        assert "evidence_id" not in str(captured["model_input"])
        assert "[[evidence:" not in str(captured["model_input"])
        assert "_answer_evidence" not in completed
    assert active_evidence.get() is None
