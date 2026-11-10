"""Execution-local native RAG units observed after all model-input hooks."""

import inspect
import json
from contextvars import ContextVar
from typing import Any
from uuid import uuid4

from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool

active_evidence: ContextVar["EvidenceRegistry | None"] = ContextVar(
    "answer_evidence", default=None
)


class EvidenceRegistry:
    def __init__(self) -> None:
        self._offered: dict[str, dict] = {}
        self._sent: dict[str, dict] = {}
        self._tool_names: dict[str, str] = {}

    def offer(self, chunk: dict, tool_name: str = "knowledge_base_search") -> dict:
        unit = dict(chunk)
        if (
            chunk.get("source_type") not in (None, "", "internal")
            or chunk.get("source_id")
            or not isinstance(chunk.get("knowledge_base_id"), int)
            or not isinstance(chunk.get("document_id"), int)
            or not isinstance(chunk.get("content"), str)
            or not 0 < len(chunk["content"]) <= 5000
        ):
            return unit
        local_id = uuid4().hex
        unit["evidence_id"] = local_id
        unit["evidence_instruction"] = f"Cite this unit using [[evidence:{local_id}]]"
        self._offered[local_id] = dict(unit)
        self._tool_names[local_id] = tool_name
        return unit

    def observe(self, state: dict) -> dict:
        messages = state.get("llm_input_messages", state.get("messages", []))
        for message in messages:
            if not isinstance(message, ToolMessage):
                continue
            blocks = (
                message.content
                if isinstance(message.content, list)
                else [message.content]
            )
            for block in blocks:
                text = block.get("text") if isinstance(block, dict) else block
                try:
                    payload = json.loads(text)
                except (TypeError, ValueError):
                    continue
                if not isinstance(payload, dict):
                    continue
                units = payload.get("results", payload.get("chunks", []))
                if not isinstance(units, list):
                    continue
                for unit in units:
                    if not isinstance(unit, dict):
                        continue
                    local_id = unit.get("evidence_id")
                    if (
                        isinstance(local_id, str)
                        and local_id in self._offered
                        and message.name == self._tool_names[local_id]
                        and unit == self._offered[local_id]
                    ):
                        self._sent[local_id] = unit
        return {}

    def confirmed(self) -> list[dict]:
        return [dict(unit) for unit in self._sent.values()]


def wrap_native_search(
    tool: BaseTool, server_url: str, backend_url: str, server_name: str = ""
) -> BaseTool:
    """Trust only the configured Backend's native knowledge MCP endpoint."""
    if (
        not backend_url
        or server_url.rstrip("/")
        not in {
            backend_url.rstrip("/") + "/api/mcp/knowledge",
            backend_url.rstrip("/") + "/api/mcp/knowledge/sse",
            backend_url.rstrip("/") + "/mcp/knowledge",
            backend_url.rstrip("/") + "/mcp/knowledge/sse",
        }
        or tool.name
        not in {
            "wegent_kb_search_knowledge_base",
            f"{server_name}_wegent_kb_search_knowledge_base",
        }
    ):
        return tool
    original = tool._arun

    async def run(
        *args: Any, config: RunnableConfig | None = None, **kwargs: Any
    ) -> Any:
        if "config" in inspect.signature(original).parameters:
            kwargs["config"] = config
        output = await original(*args, **kwargs)
        registry = active_evidence.get()
        if registry is None:
            return output
        content = output[0] if isinstance(output, tuple) else output
        blocks = content if isinstance(content, list) else [content]
        formatted = []
        for block in blocks:
            text = block.get("text") if isinstance(block, dict) else block
            try:
                payload = json.loads(text)
            except (TypeError, ValueError):
                formatted.append(block)
                continue
            if (
                isinstance(payload, dict)
                and payload.get("mode") == "rag_retrieval"
                and isinstance(payload.get("chunks"), list)
            ):
                payload["chunks"] = [
                    registry.offer(
                        {
                            **chunk,
                            "source": chunk.get(
                                "title", chunk.get("document_name", "")
                            ),
                            "source_chunk_id": chunk.get("chunk_id") or "",
                        },
                        tool_name=tool.name,
                    )
                    for chunk in payload.get("chunks", [])
                    if isinstance(chunk, dict)
                ]
                text = json.dumps(payload, ensure_ascii=False)
                block = {**block, "text": text} if isinstance(block, dict) else text
            formatted.append(block)
        value = formatted if isinstance(content, list) else formatted[0]
        return (value, output[1]) if isinstance(output, tuple) else value

    object.__setattr__(tool, "_arun", run)
    return tool
