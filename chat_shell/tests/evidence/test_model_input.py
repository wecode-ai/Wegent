"""Evidence is issued only for complete native RAG units in model input."""

import json

import pytest
from langchain_core.messages import HumanMessage, ToolMessage

from chat_shell.services.answer_evidence import EvidenceRegistry


def test_only_complete_trusted_tool_input_is_confirmed():
    registry = EvidenceRegistry()
    chunk = {
        "content": "原始证据",
        "knowledge_base_id": 7,
        "document_id": 9,
        "source": "资料",
        "source_type": "internal",
    }
    unit = registry.offer(chunk)
    registry.observe(
        {"messages": [HumanMessage(content=json.dumps({"results": [unit]}))]}
    )
    assert registry.confirmed() == []
    registry.observe(
        {
            "llm_input_messages": [
                ToolMessage(
                    content=json.dumps({"results": [{**unit, "content": "原始"}]}),
                    tool_call_id="call",
                    name="knowledge_base_search",
                )
            ]
        }
    )
    assert registry.confirmed() == []
    registry.observe(
        {
            "messages": [
                ToolMessage(
                    content=json.dumps({"results": [unit]}),
                    tool_call_id="call",
                    name="knowledge_base_search",
                )
            ]
        }
    )
    assert registry.confirmed()[0]["content"] == "原始证据"
    registry.observe({"messages": []})
    assert len(registry.confirmed()) == 1


def test_external_and_oversized_units_are_not_offered():
    registry = EvidenceRegistry()
    for change in ({"source_type": "external"}, {"content": "字" * 5001}):
        chunk = {
            "content": "证据",
            "knowledge_base_id": 7,
            "document_id": 9,
            "source": "资料",
            "source_type": "internal",
            **change,
        }
        assert "evidence_id" not in registry.offer(chunk)


async def test_real_react_guard_guidance_chain_matches_model_request():
    from unittest.mock import AsyncMock

    from langchain_core.language_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.tools import tool
    from langgraph.prebuilt import create_react_agent
    from pydantic import PrivateAttr

    from chat_shell.guard import UnifiedContextGuard, chain_pre_model_hooks
    from chat_shell.services.guidance import GuidanceConsumer, GuidanceItem

    registry = EvidenceRegistry()
    captured = []

    class CaptureModel(BaseChatModel):
        _count: int = PrivateAttr(default=0)

        @property
        def _llm_type(self):
            return "evidence-capture"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            captured.append(messages)
            self._count += 1
            message = (
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "knowledge_base_search",
                            "args": {"query": "资料"},
                            "id": "call",
                        }
                    ],
                )
                if self._count == 1
                else AIMessage(content="完成")
            )
            return ChatResult(generations=[ChatGeneration(message=message)])

    @tool
    def knowledge_base_search(query: str) -> str:
        """Retrieve the native indexed fixture."""
        unit = registry.offer(
            {
                "content": "模型实际收到的原文",
                "source": "资料",
                "knowledge_base_id": 7,
                "document_id": 9,
            }
        )
        return json.dumps({"results": [unit]}, ensure_ascii=False)

    guidance = GuidanceConsumer(
        7,
        12,
        AsyncMock(consume=AsyncMock(return_value=GuidanceItem("guide", "引用证据"))),
        AsyncMock(),
    )
    guard = UnifiedContextGuard(model_id="gpt-4", sources=[], compression_enabled=True)
    graph = create_react_agent(
        CaptureModel(),
        [knowledge_base_search],
        pre_model_hook=chain_pre_model_hooks(
            guard, guidance.create_pre_model_hook(), registry.observe
        ),
    )
    await graph.ainvoke({"messages": [HumanMessage(content="请核对资料")]})
    received = [message for message in captured[-1] if isinstance(message, ToolMessage)]
    actual = json.loads(received[0].content)["results"][0]
    assert registry.confirmed() == [actual]
    assert actual["content"] == "模型实际收到的原文"
    assert any("引用证据" in str(message.content) for message in captured[0])


async def test_native_mcp_transport_registers_only_trusted_backend_units():
    from langchain_core.tools import StructuredTool

    from chat_shell.services.answer_evidence import active_evidence, wrap_native_search

    async def search(query: str):
        return [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "mode": "rag_retrieval",
                        "chunks": [
                            {
                                "content": "原生 MCP 原文",
                                "title": "资料",
                                "document_id": 9,
                                "knowledge_base_id": 7,
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
            }
        ], {}

    registry = EvidenceRegistry()
    token = active_evidence.set(registry)
    try:
        untrusted = StructuredTool.from_function(
            coroutine=search,
            name="wegent_kb_search_knowledge_base",
            description="search",
            response_format="content_and_artifact",
        )
        wrap_native_search(
            untrusted, "https://other.example/mcp/knowledge/sse", "http://backend"
        )
        content = await untrusted.ainvoke({"query": "q"})
        assert "evidence_id" not in str(content)
        trusted = StructuredTool.from_function(
            coroutine=search,
            name="wegent-knowledge_wegent_kb_search_knowledge_base",
            description="search",
            response_format="content_and_artifact",
        )
        wrap_native_search(
            trusted,
            "http://backend/mcp/knowledge/sse",
            "http://backend",
            server_name="wegent-knowledge",
        )
        message = await trusted.ainvoke(
            {
                "name": trusted.name,
                "args": {"query": "q"},
                "id": "call",
                "type": "tool_call",
            }
        )
        registry.observe({"messages": [message]})
        assert registry.confirmed()[0]["content"] == "原生 MCP 原文"
    finally:
        active_evidence.reset(token)


@pytest.mark.parametrize("searches", [1, 2])
async def test_openai_sdk_request_preserves_registered_body_after_hooks(searches):
    """Capture the provider HTTP request, beyond the abstract model interface."""
    from unittest.mock import AsyncMock

    import httpx
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent

    from chat_shell.guard import UnifiedContextGuard, chain_pre_model_hooks
    from chat_shell.services.guidance import GuidanceConsumer

    registry = EvidenceRegistry()
    requests = []

    async def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if len(requests) <= searches:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"call-{len(requests)}",
                        "type": "function",
                        "function": {
                            "name": "knowledge_base_search",
                            "arguments": '{"query":"资料"}',
                        },
                    }
                ],
            }
        else:
            message = {"role": "assistant", "content": "已核对"}
        return httpx.Response(
            200,
            json={
                "id": "model",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-4",
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": (
                            "tool_calls" if len(requests) <= searches else "stop"
                        ),
                    }
                ],
            },
        )

    @tool
    def knowledge_base_search(query: str) -> str:
        """Search indexed native text."""
        return json.dumps(
            {
                "results": [
                    registry.offer(
                        {
                            "content": "SDK 收到的完整原文",
                            "source": "资料",
                            "knowledge_base_id": 7,
                            "document_id": 9 + len(requests),
                        }
                    )
                ]
            },
            ensure_ascii=False,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        model = ChatOpenAI(
            model="gpt-4",
            api_key="unit-test",
            base_url="http://model/v1",
            http_async_client=client,
        )
        guard = UnifiedContextGuard(
            model_id="gpt-4", sources=[], compression_enabled=True
        )
        guidance = GuidanceConsumer(
            7, 12, AsyncMock(consume=AsyncMock(return_value=None)), AsyncMock()
        )
        graph = create_react_agent(
            model,
            [knowledge_base_search],
            pre_model_hook=chain_pre_model_hooks(
                guard, guidance.create_pre_model_hook(), registry.observe
            ),
        )
        await graph.ainvoke({"messages": [HumanMessage(content="核对资料")]})
    sent = next(
        message for message in requests[-1]["messages"] if message["role"] == "tool"
    )
    actual_unit = json.loads(sent["content"])["results"][0]
    assert actual_unit["content"] == "SDK 收到的完整原文"
    sent_units = [
        json.loads(message["content"])["results"][0]
        for message in requests[-1]["messages"]
        if message["role"] == "tool"
    ]
    assert registry.confirmed() == sent_units
    assert len({unit["evidence_id"] for unit in sent_units}) == searches
    assert [unit["document_id"] for unit in sent_units] == list(
        range(10, 10 + searches)
    )


def test_malformed_tool_units_are_not_confirmed_or_allowed_to_break_model_hook():
    registry = EvidenceRegistry()
    for payload in (
        {"results": None},
        {"results": {"content": "partial"}},
        {"results": [{"evidence_id": ["invalid"]}]},
    ):
        assert (
            registry.observe(
                {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(payload),
                            name="knowledge_base_search",
                            tool_call_id="call",
                        )
                    ]
                }
            )
            == {}
        )
    assert registry.confirmed() == []


def test_sent_unit_survives_later_in_place_compaction():
    registry = EvidenceRegistry()
    unit = registry.offer(
        {
            "content": "完整原文",
            "source": "同名",
            "knowledge_base_id": 7,
            "document_id": 9,
        }
    )
    message = ToolMessage(
        content=json.dumps({"results": [unit]}),
        tool_call_id="first",
        name="knowledge_base_search",
    )
    registry.observe({"messages": [message]})
    # A caller can compact its own confirmed payload before the next request.
    exported = registry.confirmed()
    exported[0]["content"] = "摘要"
    registry.observe({"messages": [message.model_copy(update={"content": "摘要"})]})
    assert registry.confirmed()[0]["content"] == "完整原文"


async def test_budget_compaction_keeps_earlier_sent_identity_but_rejects_new_fragments():
    from chat_shell.compression.token_counter import TokenCounter
    from chat_shell.guard import UnifiedContextGuard, chain_pre_model_hooks
    from chat_shell.guard.tool_output import ToolOutputGuardAdapter
    from chat_shell.guard.types import TruncationPolicy

    registry = EvidenceRegistry()
    first = registry.offer(
        {
            "content": "已发送的原文",
            "source": "同名",
            "knowledge_base_id": 7,
            "document_id": 9,
        }
    )
    second = registry.offer(
        {
            "content": "检索结果 " * 700,
            "source": "同名",
            "knowledge_base_id": 7,
            "document_id": 10,
        }
    )
    assert first["evidence_id"] != second["evidence_id"]
    earlier = ToolMessage(
        content=json.dumps({"results": [first]}),
        name="knowledge_base_search",
        tool_call_id="first",
        id="first",
    )
    registry.observe({"messages": [earlier]})
    guard = UnifiedContextGuard(
        model_id="gpt-4",
        sources=[
            ToolOutputGuardAdapter(
                TokenCounter(model_name="gpt-4"),
                TruncationPolicy(kind="tokens", limit=50),
            )
        ],
        compression_enabled=True,
    )
    hook = chain_pre_model_hooks(guard, registry.observe)
    updates = await hook(
        {
            "messages": [
                HumanMessage(content="核对"),
                earlier,
                ToolMessage(
                    content=json.dumps({"results": [second]}),
                    name="knowledge_base_search",
                    tool_call_id="second",
                    id="second",
                ),
            ]
        }
    )
    assert any(
        "truncated=true" in str(message.content) for message in updates["messages"]
    )
    assert registry.confirmed() == [first]
    for content in [
        json.dumps({"results": [{**second, "content": "摘要"}]}),
        json.dumps({"results": [second]})[:-8],
        f'[[evidence:{second["evidence_id"]}]]',
    ]:
        registry.observe(
            {
                "messages": [
                    ToolMessage(
                        content=content,
                        name="knowledge_base_search",
                        tool_call_id="partial",
                    )
                ]
            }
        )
    assert registry.confirmed() == [first]
    other_generation = EvidenceRegistry()
    other_generation.observe({"messages": [earlier]})
    assert other_generation.confirmed() == []
