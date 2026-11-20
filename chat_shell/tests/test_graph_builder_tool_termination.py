# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import StructuredTool

from chat_shell.agents.graph_builder import (
    LangGraphAgentBuilder,
    _has_unexecuted_tool_calls,
)
from chat_shell.tools.base import ToolRegistry
from chat_shell.tools.builtin.load_skill import LazySkillProviderTool, LoadSkillTool
from chat_shell.tools.mcp.client import wrap_tool_with_protection


def test_return_direct_tool_result_is_not_unexecuted() -> None:
    final_message = ToolMessage(
        content="card created",
        tool_call_id="call-1",
        name="create_async_video_card",
    )

    assert not _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=1)


def test_replaced_tool_call_is_unexecuted() -> None:
    final_message = AIMessage(content="Sorry, need more steps.")

    assert _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=1)


def test_pending_ai_tool_call_is_unexecuted() -> None:
    final_message = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call-1",
                "name": "create_async_video_card",
                "args": {},
            }
        ],
    )

    assert _has_unexecuted_tool_calls(final_message, last_model_end_tool_calls=0)


class _DirectMcpModel(BaseChatModel):
    calls: int = 0
    invalid_arguments: bool = False

    @property
    def _llm_type(self) -> str:
        return "direct-mcp-fixture"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls += 1
        if self.calls < 3:
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": f"call-{self.calls}",
                        "name": "direct" if self.calls == 1 else "healthy",
                        "args": (
                            {"private_input": "private-invalid-tool-input"}
                            if self.invalid_arguments and self.calls == 1
                            else {} if self.calls == 2 else {"value": "probe"}
                        ),
                    }
                ],
            )
        else:
            message = AIMessage(content="continued with healthy tools")
        return ChatResult(generations=[ChatGeneration(message=message)])


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "connection", "validation"])
@pytest.mark.parametrize("loading", ["eager", "deferred", "proxy"])
async def test_direct_mcp_failures_continue_the_real_agent_graph(
    failure: str | None, loading: str, caplog: pytest.LogCaptureFixture
) -> None:
    def direct(value: str) -> str:
        """Run a direct-return MCP operation."""
        if failure == "connection":
            raise ConnectionError("private-credential-and-response")
        return "direct-success"

    direct_tool = wrap_tool_with_protection(StructuredTool.from_function(direct))
    direct_tool.return_direct = True
    healthy = wrap_tool_with_protection(
        StructuredTool.from_function(
            func=lambda: "healthy-result", name="healthy", description="Healthy MCP"
        )
    )
    registry = ToolRegistry()
    load_skill_tool = LoadSkillTool(
        user_id=1,
        skill_names=["direct_skill"],
        skill_metadata={"direct_skill": {"prompt": "Use the direct MCP tool."}},
    )
    if loading != "eager":

        async def load_direct_tools() -> list:
            return [direct_tool]

        load_skill_tool.register_skill_tool_loader("direct_skill", load_direct_tools)
        if loading == "proxy":
            load_skill_tool.register_skill_tools(
                "direct_skill",
                [
                    LazySkillProviderTool(
                        skill_name="direct_skill",
                        tool_name=direct_tool.name,
                        description="Deferred MCP operation",
                        load_skill_tool=load_skill_tool,
                    )
                ],
            )
        registry.register(load_skill_tool)
    else:
        registry.register(direct_tool)
    registry.register(healthy)
    model = _DirectMcpModel(invalid_arguments=failure == "validation")
    builder = LangGraphAgentBuilder(model, tool_registry=registry)
    graph = builder._build_agent()
    if loading != "eager":
        # Deferred MCP metadata becomes available only after graph construction.
        await load_skill_tool.ensure_skill_tools_loaded("direct_skill")
        load_skill_tool._run("direct_skill")
    state = await graph.ainvoke(
        {
            "messages": [
                HumanMessage(content="Complete the work using available tools.")
            ]
        },
        config={"configurable": {"thread_id": "direct-mcp-test"}},
    )
    if failure is None:
        assert model.calls == 1
        assert state["messages"][-1].content == "direct-success"
    else:
        assert model.calls == 3
        assert state["messages"][-1].content == "continued with healthy tools"
        results = [
            message for message in state["messages"] if isinstance(message, ToolMessage)
        ]
        assert results[0].status == "error"
        assert results[1].content == "healthy-result"
        assert direct_tool._wegent_mcp_unavailable.is_set()
        assert "private-credential-and-response" not in str(state)
        assert "private-invalid-tool-input" not in str(results)
    assert "private-credential-and-response" not in caplog.text
    assert "private-invalid-tool-input" not in caplog.text
