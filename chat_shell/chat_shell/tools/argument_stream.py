# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Track streamed tool-call arguments from LangChain message chunks."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from shared.utils.tool_arguments import sanitize_tool_arguments


@dataclass
class ToolArgumentFinalizeResult:
    """Result of reconciling streamed arguments with a real tool start."""

    tool_use_id: str
    arguments_summary: dict[str, Any]
    was_streamed: bool


@dataclass
class _ToolArgumentState:
    tool_use_id: str
    stream_index: int | None
    tool_name: str = "unknown"
    args_text: str = ""
    started: bool = False


class ToolCallStreamTracker:
    """Emit UI-safe lifecycle events while a model streams tool arguments."""

    def __init__(
        self,
        *,
        emitter: Any | None = None,
        on_tool_event: Callable[[str, dict[str, Any]], None] | None = None,
    ):
        self.emitter = emitter
        self.on_tool_event = on_tool_event
        self._states: dict[str, _ToolArgumentState] = {}
        self._index_to_key: dict[int, str] = {}

    async def process_tool_call_chunks(self, chunks: Any) -> None:
        """Process LangChain ``tool_call_chunks`` from a streamed AI chunk."""
        if not chunks:
            return

        for raw_chunk in chunks:
            chunk = self._normalize_chunk(raw_chunk)
            stream_index = chunk.get("index")
            tool_use_id = chunk.get("id")
            key = self._state_key(tool_use_id, stream_index)
            if key is None:
                continue

            state = self._states.get(key)
            if state is None:
                state = _ToolArgumentState(
                    tool_use_id=key,
                    stream_index=(
                        stream_index if isinstance(stream_index, int) else None
                    ),
                    tool_name=chunk.get("name") or "unknown",
                )
                self._states[key] = state
                if isinstance(stream_index, int):
                    self._index_to_key[stream_index] = key

            if chunk.get("name"):
                state.tool_name = chunk["name"]

            if not state.started:
                await self._emit_start(state)
                state.started = True

            args_delta = chunk.get("args")
            if args_delta is None:
                continue
            if not isinstance(args_delta, str):
                args_delta = json.dumps(args_delta, ensure_ascii=False)
            state.args_text += args_delta
            await self._emit_delta(state, args_delta)

    async def finalize(
        self,
        *,
        call_id: str,
        tool_name: str,
        arguments: dict[str, Any] | None,
        stream_index: int | None = None,
    ) -> ToolArgumentFinalizeResult:
        """Finalize streamed arguments when LangGraph reports ``on_tool_start``."""
        key = self._find_key(call_id, stream_index, tool_name, arguments or {})
        state = self._states.get(key) if key else None
        tool_use_id = state.tool_use_id if state else call_id
        summary = sanitize_tool_arguments(tool_name, arguments or {})

        if state:
            state.tool_name = tool_name or state.tool_name
            await self._emit_done(tool_use_id, tool_name or state.tool_name, summary)
            self._consume_state(key, state)
            return ToolArgumentFinalizeResult(
                tool_use_id=tool_use_id,
                arguments_summary=summary,
                was_streamed=True,
            )

        return ToolArgumentFinalizeResult(
            tool_use_id=tool_use_id,
            arguments_summary=summary,
            was_streamed=False,
        )

    def _find_key(
        self,
        call_id: str,
        stream_index: int | None,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> str | None:
        if call_id in self._states:
            return call_id
        if stream_index is not None and stream_index in self._index_to_key:
            return self._index_to_key[stream_index]
        argument_matched_key = self._find_key_by_arguments(tool_name, arguments)
        if argument_matched_key is not None:
            return argument_matched_key
        for key, state in self._states.items():
            if state.tool_name == tool_name:
                return key
        return None

    def _find_key_by_arguments(
        self, tool_name: str, arguments: dict[str, Any]
    ) -> str | None:
        for key, state in self._states.items():
            if state.tool_name != tool_name:
                continue
            parsed = self._parse_args_text(state.args_text)
            if not isinstance(parsed, dict):
                continue
            if self._arguments_match(parsed, arguments):
                return key
        return None

    def _arguments_match(
        self, streamed_arguments: dict[str, Any], final_arguments: dict[str, Any]
    ) -> bool:
        for field_name in ("file_path", "path", "filename", "name"):
            streamed_value = streamed_arguments.get(field_name)
            final_value = final_arguments.get(field_name)
            if streamed_value and final_value and streamed_value == final_value:
                return True
        return False

    def _consume_state(self, key: str | None, state: _ToolArgumentState) -> None:
        if key is not None:
            self._states.pop(key, None)
        if state.stream_index is not None:
            self._index_to_key.pop(state.stream_index, None)

    def _state_key(self, tool_use_id: Any, stream_index: Any) -> str | None:
        if isinstance(tool_use_id, str) and tool_use_id.strip():
            return tool_use_id
        if isinstance(stream_index, int):
            return (
                self._index_to_key.get(stream_index) or f"stream_index:{stream_index}"
            )
        return None

    def _normalize_chunk(self, chunk: Any) -> dict[str, Any]:
        if isinstance(chunk, dict):
            return dict(chunk)
        return {
            "index": getattr(chunk, "index", None),
            "id": getattr(chunk, "id", None),
            "name": getattr(chunk, "name", None),
            "args": getattr(chunk, "args", None),
        }

    async def _emit_start(self, state: _ToolArgumentState) -> None:
        payload = {
            "call_id": state.tool_use_id,
            "name": state.tool_name,
            "arguments_summary": {},
        }
        if self.emitter is not None:
            await self.emitter.tool_argument_start(**payload)
        if self.on_tool_event is not None:
            self.on_tool_event("tool_argument_start", payload)

    async def _emit_delta(self, state: _ToolArgumentState, args_delta: str) -> None:
        payload = {
            "call_id": state.tool_use_id,
            "name": state.tool_name,
            "arguments_delta": args_delta,
            "arguments_summary": self._partial_summary(state),
        }
        if self.emitter is not None:
            await self.emitter.tool_argument_delta(
                call_id=state.tool_use_id,
                arguments_delta=args_delta,
                arguments_summary=payload["arguments_summary"],
            )
        if self.on_tool_event is not None:
            self.on_tool_event("tool_argument_delta", payload)

    async def _emit_done(
        self, tool_use_id: str, tool_name: str, arguments_summary: dict[str, Any]
    ) -> None:
        payload = {
            "call_id": tool_use_id,
            "name": tool_name,
            "arguments_summary": arguments_summary,
        }
        if self.emitter is not None:
            await self.emitter.tool_argument_done(
                call_id=tool_use_id,
                arguments_summary=arguments_summary,
            )
        if self.on_tool_event is not None:
            self.on_tool_event("tool_argument_done", payload)

    def _partial_summary(self, state: _ToolArgumentState) -> dict[str, Any]:
        parsed = self._parse_args_text(state.args_text)
        if not isinstance(parsed, dict):
            return {}
        return sanitize_tool_arguments(state.tool_name, parsed)

    def _parse_args_text(self, args_text: str) -> Any:
        try:
            return json.loads(args_text)
        except (json.JSONDecodeError, TypeError):
            return None
