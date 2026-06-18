# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""In-memory streaming snapshot helpers for executor runtime caches."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from .blocks import BlockStatus, create_tool_block
from .responses_api import ResponsesAPIStreamEvents

RUNTIME_STREAM_CACHE_SOURCE = "executor"


def runtime_stream_cache_capability() -> dict[str, Any]:
    """Return the runtime cache capability marker."""

    return {"enabled": True}


@dataclass
class RuntimeStreamSnapshot:
    """Serializable in-memory stream snapshot."""

    task_id: int
    subtask_id: int
    content: str = ""
    blocks: list[dict[str, Any]] = field(default_factory=list)
    context_metrics: Optional[dict[str, Any]] = None
    offset: int = 0
    started_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)
    terminal: bool = False
    source: str = RUNTIME_STREAM_CACHE_SOURCE

    def to_dict(self) -> dict[str, Any]:
        """Convert the snapshot to a JSON-serializable dictionary."""

        payload = {
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "content": self.content,
            "blocks": [dict(block) for block in self.blocks],
            "offset": self.offset,
            "started_at": self.started_at,
            "last_activity_at": self.last_activity_at,
            "terminal": self.terminal,
            "source": self.source,
        }
        if self.context_metrics is not None:
            payload["context_metrics"] = dict(self.context_metrics)
        return payload


class RuntimeStreamAccumulator:
    """Accumulate Responses API stream events into a refreshable snapshot."""

    def __init__(self, task_id: int, subtask_id: int) -> None:
        self.snapshot = RuntimeStreamSnapshot(task_id=task_id, subtask_id=subtask_id)
        self._current_thinking_block_id: Optional[str] = None
        self._tool_contexts: dict[str, dict[str, Any]] = {}

    def apply_event(self, event_type: str, data: Optional[dict[str, Any]]) -> None:
        """Apply one Responses API event payload to the snapshot."""

        payload = data or {}
        self.snapshot.last_activity_at = time.time()

        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            self._append_text(payload.get("delta", ""))
            return

        if event_type in (
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
            ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
        ):
            reasoning_content = self._extract_reasoning_content(event_type, payload)
            if reasoning_content:
                self._append_thinking(reasoning_content)
            return

        if event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            self._handle_output_item_added(payload)
            return

        if event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value:
            self._handle_function_arguments_delta(payload)
            return

        if event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            self._handle_function_arguments_done(payload)
            return

        if event_type == ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DONE.value:
            self._handle_mcp_arguments_done(payload)
            return

        if event_type in (
            ResponsesAPIStreamEvents.MCP_CALL_COMPLETED.value,
            ResponsesAPIStreamEvents.MCP_CALL_FAILED.value,
        ):
            self._handle_mcp_call_done(event_type, payload)
            return

        if event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value:
            self._handle_output_item_done(payload)
            return

        if event_type == ResponsesAPIStreamEvents.BLOCK_CREATED.value:
            self._add_custom_block(payload.get("block"))
            return

        if event_type == ResponsesAPIStreamEvents.BLOCK_UPDATED.value:
            self._update_custom_block(payload.get("block_id"), payload.get("updates"))
            return

        if event_type == ResponsesAPIStreamEvents.STATUS_UPDATED.value:
            self._update_context_metrics(payload)
            return

        if event_type in (
            ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
            ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
            ResponsesAPIStreamEvents.ERROR.value,
        ):
            self.mark_terminal()

    def mark_terminal(self) -> None:
        """Mark the snapshot terminal and finalize open text-like blocks."""

        self._finalize_current_thinking_block()
        self.snapshot.terminal = True
        self.snapshot.last_activity_at = time.time()

    def to_snapshot(self) -> RuntimeStreamSnapshot:
        """Return a copy-like serializable snapshot object."""

        source = self.snapshot
        return RuntimeStreamSnapshot(
            task_id=source.task_id,
            subtask_id=source.subtask_id,
            content=source.content,
            blocks=[dict(block) for block in source.blocks],
            context_metrics=(
                dict(source.context_metrics)
                if isinstance(source.context_metrics, dict)
                else None
            ),
            offset=source.offset,
            started_at=source.started_at,
            last_activity_at=source.last_activity_at,
            terminal=source.terminal,
            source=source.source,
        )

    def _append_text(self, content: str) -> None:
        if not content:
            return

        self.snapshot.content += content
        self.snapshot.offset = len(self.snapshot.content)

    def _append_thinking(self, content: str) -> None:
        if not content:
            return

        block = self._ensure_current_thinking_block()
        block["content"] = str(block.get("content", "")) + content
        block["status"] = BlockStatus.STREAMING.value

    def _ensure_current_thinking_block(self) -> dict[str, Any]:
        if self._current_thinking_block_id:
            block = self._find_block(self._current_thinking_block_id)
            if block is not None:
                return block

        block_id = f"thinking-{uuid.uuid4().hex[:12]}"
        block = {
            "id": block_id,
            "type": "thinking",
            "content": "",
            "status": BlockStatus.STREAMING.value,
            "timestamp": int(time.time() * 1000),
        }
        self.snapshot.blocks.append(block)
        self._current_thinking_block_id = block_id
        return block

    def _finalize_current_thinking_block(self) -> None:
        if not self._current_thinking_block_id:
            return
        block = self._find_block(self._current_thinking_block_id)
        if block is not None:
            block["status"] = BlockStatus.DONE.value
        self._current_thinking_block_id = None

    def _handle_output_item_added(self, data: dict[str, Any]) -> None:
        item = data.get("item")
        if not isinstance(item, dict):
            return

        item_type = item.get("type")
        if item_type == "function_call":
            tool_use_id = str(item.get("call_id") or item.get("id") or "")
            tool_name = str(item.get("name") or "")
            tool_input = self._resolve_tool_input(
                data.get("arguments_summary"), item.get("arguments")
            )
            self._tool_contexts[tool_use_id] = {
                "protocol": "function_call",
                "name": tool_name,
                "arguments": tool_input,
            }
            status = (
                "generating_arguments"
                if data.get("argument_status") == "streaming"
                else BlockStatus.PENDING.value
            )
            self._upsert_tool_block(
                tool_use_id=tool_use_id,
                tool_name=tool_name,
                tool_input=tool_input,
                display_name=data.get("display_name"),
                tool_protocol="function_call",
                status=status,
            )
            return

        if item_type == "mcp_call":
            tool_use_id = str(item.get("id") or "")
            tool_name = str(item.get("name") or "")
            server_label = item.get("server_label")
            self._tool_contexts[tool_use_id] = {
                "protocol": "mcp_call",
                "name": tool_name,
                "server_label": server_label,
            }
            self._upsert_tool_block(
                tool_use_id=tool_use_id,
                tool_name=tool_name,
                tool_protocol="mcp_call",
                server_label=server_label,
            )
            return

        if item_type == "shell_call":
            tool_use_id = str(item.get("call_id") or item.get("id") or "")
            tool_name = str(item.get("name") or item.get("command") or "shell")
            tool_input = self._extract_shell_call_input(item)
            self._tool_contexts[tool_use_id] = {
                "protocol": "shell_call",
                "name": tool_name,
                "arguments": tool_input,
            }
            self._upsert_tool_block(
                tool_use_id=tool_use_id,
                tool_name=tool_name,
                tool_input=tool_input,
                display_name=data.get("display_name"),
                tool_protocol="shell_call",
            )

    def _handle_function_arguments_delta(self, data: dict[str, Any]) -> None:
        tool_use_id = str(data.get("call_id") or data.get("item_id") or "")
        if not tool_use_id:
            return

        tool_context = self._tool_contexts.setdefault(
            tool_use_id,
            {"protocol": "function_call", "name": ""},
        )
        tool_input = data.get("arguments_summary")
        if isinstance(tool_input, dict):
            tool_context["arguments"] = tool_input
        else:
            tool_input = tool_context.get("arguments")
        self._update_tool_block(
            tool_use_id,
            status="generating_arguments",
            tool_input=tool_input if isinstance(tool_input, dict) else None,
        )

    def _handle_function_arguments_done(self, data: dict[str, Any]) -> None:
        tool_use_id = str(data.get("call_id") or data.get("item_id") or "")
        if not tool_use_id:
            return

        tool_context = self._tool_contexts.setdefault(
            tool_use_id,
            {"protocol": "function_call", "name": ""},
        )
        tool_input = self._resolve_tool_input(
            data.get("arguments_summary"), data.get("arguments")
        )
        if tool_input:
            tool_context["arguments"] = tool_input
        else:
            tool_input = tool_context.get("arguments")
        self._update_tool_block(
            tool_use_id,
            status=BlockStatus.PENDING.value,
            tool_input=tool_input if isinstance(tool_input, dict) else None,
        )

    def _handle_mcp_arguments_done(self, data: dict[str, Any]) -> None:
        tool_use_id = str(data.get("item_id") or "")
        if not tool_use_id:
            return
        tool_input = self._parse_json_object(data.get("arguments"))
        context = self._tool_contexts.setdefault(
            tool_use_id,
            {"protocol": "mcp_call", "name": ""},
        )
        context["arguments"] = tool_input
        self._update_tool_block(tool_use_id, tool_input=tool_input)

    def _handle_mcp_call_done(self, event_type: str, data: dict[str, Any]) -> None:
        tool_use_id = str(data.get("item_id") or "")
        if not tool_use_id:
            return

        context = self._tool_contexts.pop(tool_use_id, {})
        failed = event_type == ResponsesAPIStreamEvents.MCP_CALL_FAILED.value
        self._update_tool_block(
            tool_use_id,
            status=BlockStatus.ERROR.value if failed else BlockStatus.DONE.value,
            tool_input=context.get("arguments"),
            tool_output=data.get("failure_reason") if failed else data.get("output"),
            tool_protocol="mcp_call",
            server_label=context.get("server_label"),
        )

    def _handle_output_item_done(self, data: dict[str, Any]) -> None:
        item = data.get("item")
        if not isinstance(item, dict):
            return

        item_type = item.get("type")
        if item_type == "function_call":
            tool_use_id = str(item.get("call_id") or item.get("id") or "")
            context = self._tool_contexts.pop(tool_use_id, {})
            tool_input = context.get("arguments")
            if not isinstance(tool_input, dict):
                tool_input = self._parse_json_object(item.get("arguments"))
            failed = item.get("status") == "failed"
            self._update_tool_block(
                tool_use_id,
                status=BlockStatus.ERROR.value if failed else BlockStatus.DONE.value,
                tool_input=tool_input,
                tool_output=item.get("output"),
                tool_protocol="function_call",
            )
            return

        if item_type == "shell_call":
            tool_use_id = str(item.get("call_id") or item.get("id") or "")
            context = self._tool_contexts.pop(tool_use_id, {})
            tool_input = self._extract_shell_call_input(item) or context.get(
                "arguments"
            )
            failed = item.get("status") == "failed"
            self._update_tool_block(
                tool_use_id,
                status=BlockStatus.ERROR.value if failed else BlockStatus.DONE.value,
                tool_input=tool_input,
                tool_output=item.get("output"),
                tool_protocol="shell_call",
            )

    def _add_custom_block(self, block: Any) -> None:
        if not isinstance(block, dict):
            return

        self._finalize_current_thinking_block()
        block_to_store = dict(block)
        block_to_store.setdefault("id", f"block-{uuid.uuid4().hex[:12]}")
        block_to_store.setdefault("timestamp", int(time.time() * 1000))
        self._upsert_block(block_to_store)

    def _update_custom_block(self, block_id: Any, updates: Any) -> None:
        if not block_id or not isinstance(updates, dict):
            return

        block = self._find_block(str(block_id))
        if block is None:
            return
        block.update(updates)

    def _update_context_metrics(self, data: dict[str, Any]) -> None:
        phase = data.get("phase")
        context_metrics = data.get("context_metrics")
        if not phase or not isinstance(context_metrics, dict):
            return

        self.snapshot.context_metrics = {
            "task_id": self.snapshot.task_id,
            "subtask_id": self.snapshot.subtask_id,
            "phase": phase,
            "context_metrics": context_metrics,
        }

    def _upsert_tool_block(
        self,
        *,
        tool_use_id: str,
        tool_name: str,
        tool_input: Optional[dict[str, Any]] = None,
        display_name: Optional[str] = None,
        tool_protocol: Optional[str] = None,
        server_label: Optional[str] = None,
        status: Optional[str] = None,
        tool_output: Optional[str] = None,
    ) -> None:
        if not tool_use_id:
            return

        self._finalize_current_thinking_block()
        block = create_tool_block(
            tool_use_id=tool_use_id,
            tool_name=tool_name,
            tool_input=tool_input,
            display_name=display_name,
            tool_protocol=tool_protocol,
            server_label=server_label,
        )
        if status is not None:
            block["status"] = status
        if tool_output is not None:
            block["tool_output"] = tool_output
        self._upsert_block(block)

    def _update_tool_block(
        self,
        tool_use_id: str,
        *,
        status: Optional[str] = None,
        tool_input: Optional[dict[str, Any]] = None,
        tool_output: Optional[str] = None,
        tool_protocol: Optional[str] = None,
        server_label: Optional[str] = None,
    ) -> None:
        block = self._find_tool_block(tool_use_id)
        if block is None:
            return
        if status is not None:
            block["status"] = status
        if tool_input is not None:
            block["tool_input"] = tool_input
        if tool_output is not None:
            block["tool_output"] = tool_output
        if tool_protocol is not None:
            block["tool_protocol"] = tool_protocol
        if server_label is not None:
            block["server_label"] = server_label

    def _upsert_block(self, block: dict[str, Any]) -> None:
        block_id = block.get("id")
        if not block_id:
            block_id = f"block-{uuid.uuid4().hex[:12]}"
            block["id"] = block_id

        existing = self._find_block(str(block_id))
        if existing is None:
            self.snapshot.blocks.append(block)
            return

        existing.clear()
        existing.update(block)

    def _find_block(self, block_id: str) -> Optional[dict[str, Any]]:
        for block in self.snapshot.blocks:
            if block.get("id") == block_id:
                return block
        return None

    def _find_tool_block(self, tool_use_id: str) -> Optional[dict[str, Any]]:
        for block in self.snapshot.blocks:
            if block.get("type") == "tool" and block.get("tool_use_id") == tool_use_id:
                return block
        return None

    @staticmethod
    def _extract_reasoning_content(event_type: str, data: dict[str, Any]) -> str:
        if event_type == ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value:
            return str(data.get("delta") or "")

        part = data.get("part")
        if not isinstance(part, dict):
            return ""
        if part.get("type") != "summary_text":
            return ""
        return str(part.get("text") or "")

    @staticmethod
    def _resolve_tool_input(summary: Any, arguments: Any) -> dict[str, Any]:
        if isinstance(summary, dict):
            return summary
        return RuntimeStreamAccumulator._parse_json_object(arguments)

    @staticmethod
    def _parse_json_object(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if not isinstance(value, str) or not value:
            return {}
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _extract_shell_call_input(item: dict[str, Any]) -> dict[str, Any]:
        for key in ("input", "arguments"):
            parsed = RuntimeStreamAccumulator._parse_json_object(item.get(key))
            if parsed:
                return parsed

        command = item.get("command")
        if isinstance(command, str) and command:
            return {"command": command}
        return {}
