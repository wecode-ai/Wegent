# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Real MCP processes and Chat Shell graph; only the model is simulated."""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from chat_shell.agents.graph_builder import LangGraphAgentBuilder
from chat_shell.services.context import ChatContext
from chat_shell.tools.base import ToolRegistry
from chat_shell.tools.builtin.load_skill import LoadSkillTool
from chat_shell.tools.skill_factory import _apply_skill_runtime_tool_policies
from shared.models.execution import ExecutionRequest


class ScriptedMcpModel(BaseChatModel):
    calls: int = 0
    tool_names: list[str]

    @property
    def _llm_type(self) -> str:
        return "mcp-fault-isolation-model"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        index = self.calls
        self.calls += 1
        message = (
            AIMessage(content="continued with healthy MCP")
            if index >= len(self.tool_names)
            else AIMessage(
                content="",
                tool_calls=[
                    {"id": f"call-{index}", "name": self.tool_names[index], "args": {}}
                ],
            )
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


class UnavailableMcpHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_error(401 if self.path == "/unauthorized" else 503)

    def do_POST(self) -> None:
        self.do_GET()

    def log_message(self, *_args) -> None:
        pass


class ChatMcpFaultIsolation(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.root = tempfile.TemporaryDirectory(prefix="chat-mcp-isolation-")
        self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name)
        self.uv = shutil.which("uv")
        self.assertIsNotNone(self.uv, "MCP E2E requires the repository uv runner")
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), UnavailableMcpHandler)
        self.worker = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.http.server_close)
        self.addAsyncCleanup(asyncio.to_thread, self.http.shutdown)

    def _server(self, role: str) -> dict:
        return {
            "type": "stdio",
            "command": self.uv,
            "args": [
                "run",
                "--no-sync",
                "python",
                str(Path(__file__).resolve()),
                "--serve",
                role,
                str(self.path / role),
            ],
        }

    async def _connect(self, servers: dict):
        context = ChatContext(
            ExecutionRequest(
                mcp_servers=[
                    {"name": name, **config} for name, config in servers.items()
                ]
            )
        )
        tools, clients = await asyncio.wait_for(context._connect_mcp_servers(), 15)
        for client in clients:
            self.addAsyncCleanup(client.disconnect)
        return context, tools

    def _graph(self, tools, names: list[str]):
        registry = ToolRegistry()
        for tool in tools:
            registry.register(tool)
        model = ScriptedMcpModel(tool_names=names)
        return (
            model,
            LangGraphAgentBuilder(model, tool_registry=registry)._build_agent(),
        )

    async def test_faults_keep_healthy_mcp_and_failed_direct_return_continues(
        self,
    ) -> None:
        url = f"http://127.0.0.1:{self.http.server_port}"
        context, tools = await self._connect(
            {
                "missing_context": {
                    "type": "http",
                    "url": "${{backend_api_url}}/mcp/connectors/sse",
                },
                "configuration": {"type": "unsupported", "url": url},
                "authorization": {"type": "http", "url": f"{url}/unauthorized"},
                "startup": {"type": "http", "url": f"{url}/startup-error"},
                "spawn": {"type": "stdio", "command": str(self.path / "absent")},
                "failing": self._server("failing"),
                "healthy": self._server("healthy"),
            }
        )
        self.assertTrue(context._mcp_unavailable)
        self.assertEqual(
            {tool._wegent_mcp_server_label for tool in tools}, {"failing", "healthy"}
        )
        _apply_skill_runtime_tool_policies(
            {"name": "fault-isolation", "runtime": {"returnDirectTools": ["direct"]}},
            tools,
        )
        direct = next(tool for tool in tools if tool.name.endswith("_direct"))
        healthy = next(tool for tool in tools if tool.name.endswith("_healthy"))
        self.assertTrue(direct.return_direct)
        model, graph = self._graph(tools, [direct.name, healthy.name])
        state = await asyncio.wait_for(
            graph.ainvoke(
                {"messages": [HumanMessage(content="Continue with available MCPs.")]},
                config={"configurable": {"thread_id": "mcp-fault-isolation"}},
            ),
            15,
        )
        results = [
            message for message in state["messages"] if isinstance(message, ToolMessage)
        ]
        self.assertEqual(results[0].status, "error")
        self.assertEqual(results[1].content[0]["text"], "HEALTHY_MCP_RESULT")
        self.assertEqual(state["messages"][-1].content, "continued with healthy MCP")
        self.assertEqual(model.calls, 3)
        self.assertTrue(direct._wegent_mcp_unavailable.is_set())
        self.assertEqual((self.path / "failing").read_text().splitlines(), ["called"])
        self.assertEqual((self.path / "healthy").read_text().splitlines(), ["called"])

    async def test_deferred_direct_mcp_keeps_success_and_failure_routes(self) -> None:
        _, tools = await self._connect({"independent": self._server("healthy")})
        healthy = tools[0]
        for role in ("failing", "healthy"):
            with self.subTest(role=role):
                load_skill = LoadSkillTool(
                    user_id=1,
                    skill_names=[role],
                    skill_metadata={role: {"prompt": "Use the skill MCP."}},
                )

                async def load_tools() -> list:
                    _, loaded = await self._connect({role: self._server(role)})
                    loaded[0].return_direct = True
                    return loaded

                load_skill.register_skill_tool_loader(role, load_tools)
                model, graph = self._graph([load_skill, healthy], [])
                deferred = (await load_skill.ensure_skill_tools_loaded(role))[0]
                load_skill._run(role)
                model.tool_names = [deferred.name]
                if role == "failing":
                    model.tool_names.append(healthy.name)
                state = await asyncio.wait_for(
                    graph.ainvoke(
                        {"messages": [HumanMessage(content="Use available MCPs.")]},
                        config={"configurable": {"thread_id": f"deferred-{role}"}},
                    ),
                    15,
                )
                if role == "failing":
                    self.assertTrue(deferred._wegent_mcp_unavailable.is_set())
                    self.assertEqual(model.calls, 3)
                    self.assertEqual(
                        state["messages"][-1].content, "continued with healthy MCP"
                    )
                else:
                    self.assertEqual(model.calls, 1)
                    self.assertEqual(
                        state["messages"][-1].content[0]["text"], "HEALTHY_MCP_RESULT"
                    )
        self.assertEqual((self.path / "failing").read_text().splitlines(), ["called"])
        self.assertEqual(
            (self.path / "healthy").read_text().splitlines(), ["called", "called"]
        )

    async def test_task_cancellation_remains_cancellation(self) -> None:
        _, tools = await self._connect(
            {"waiting": self._server("waiting"), "healthy": self._server("healthy")}
        )
        waiting = next(tool for tool in tools if tool.name.endswith("_waiting"))
        model, graph = self._graph(tools, [waiting.name])
        execution = asyncio.create_task(
            graph.ainvoke(
                {"messages": [HumanMessage(content="Wait for explicit cancellation.")]},
                config={"configurable": {"thread_id": "mcp-cancellation"}},
            )
        )
        try:

            async def wait_for_call() -> None:
                while not (self.path / "waiting").exists():
                    if execution.done():
                        await execution
                        self.fail("Execution ended before the cancellable MCP call")
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_for_call(), 10)
            execution.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(execution, 5)
            self.assertFalse(waiting._wegent_mcp_unavailable.is_set())
            self.assertEqual(model.calls, 1)
            self.assertFalse((self.path / "healthy").exists())
        finally:
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)


def serve(role: str, evidence: str) -> None:
    from mcp.server.fastmcp import FastMCP

    server = FastMCP(role)

    async def operation() -> str:
        with Path(evidence).open("a") as output:
            output.write("called\n")
        if role == "failing":
            raise RuntimeError("MCP_ISOLATION_CALL_FAILED")
        if role == "waiting":
            await asyncio.Event().wait()
        return "HEALTHY_MCP_RESULT"

    server.tool(
        name={"failing": "direct", "healthy": "healthy", "waiting": "waiting"}[role]
    )(operation)
    server.run(transport="stdio")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--serve"]:
        serve(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
