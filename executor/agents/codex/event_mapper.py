#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import time
import uuid
from typing import Any, Optional

from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter
from shared.status import TaskStatus

logger = setup_logger("codex_event_mapper")
DEFAULT_AGENT_MESSAGE_ID = "__default_agent_message__"


class CodeXEventMapper:
    """Translate Codex SDK notifications to Wegent Responses API events."""

    def __init__(self, emitter: ResponsesAPIEmitter):
        self.emitter = emitter
        self.final_text = ""
        self.usage: Optional[dict[str, Any]] = None
        self._saw_delta = False
        self._agent_message_phases: dict[str, str] = {}
        self._commentary_delta_texts: dict[str, str] = {}
        self._commentary_block_ids: dict[str, str] = {}
        self._pending_agent_delta_text = ""
        self._pending_agent_deltas: dict[str, str] = {}
        self._tool_contexts: dict[str, dict[str, Any]] = {}

    async def handle(self, event: Any) -> Optional[TaskStatus]:
        method = getattr(event, "method", "")
        payload = getattr(event, "payload", None)

        if method == "item/agentMessage/delta":
            delta = str(getattr(payload, "delta", "") or "")
            if delta:
                item_id = self._agent_message_item_id(payload)
                phase = self._normalize_type(
                    self._get(payload, "phase")
                    or self._agent_message_phases.get(item_id)
                )
                if phase == "commentary":
                    await self._append_commentary_delta(item_id, delta)
                    return None
                if phase in {"finalanswer", "final_answer"}:
                    self.final_text += delta
                    self._saw_delta = True
                    await self.emitter.text_delta(delta)
                    return None
                self._pending_agent_deltas[item_id] = (
                    self._pending_agent_deltas.get(item_id, "") + delta
                )
                self._pending_agent_delta_text += delta
                return None
            return None

        if method == "item/started":
            await self._handle_started_item(payload)
            return None

        if method == "item/completed":
            await self._handle_completed_item(payload)
            return None

        if method == "thread/tokenUsage/updated":
            self._handle_usage(payload)
            return None

        if method == "turn/completed":
            return await self._handle_turn_completed(payload)

        return None

    async def _handle_started_item(self, payload: Any) -> None:
        item = self._notification_item(payload)
        item_type = self._normalize_type(self._get(item, "type"))

        if item_type in {"agentmessage", "message"}:
            item_id = self._agent_message_item_id(item)
            phase = self._normalize_type(self._get(item, "phase"))
            if phase:
                self._agent_message_phases[item_id] = phase
            return

        if item_type == "commandexecution":
            await self._handle_command_execution_start(item)

    async def _handle_completed_item(self, payload: Any) -> None:
        item = self._notification_item(payload)
        item_type = self._normalize_type(self._get(item, "type"))

        if item_type in {"agentmessage", "message"}:
            await self._handle_completed_message(item)
            return

        if item_type in {"functioncall", "function_call"}:
            await self._handle_function_call(item)
            return

        if item_type in {"functioncalloutput", "function_call_output"}:
            await self._handle_function_call_output(item)
            return

        if item_type == "commandexecution":
            await self._handle_command_execution_done(item)

    async def _handle_completed_message(self, item: Any) -> None:
        if self._get(item, "role") not in (None, "assistant"):
            return

        item_id = self._agent_message_item_id(item)
        phase_value = self._get(item, "phase")
        stored_phase = self._agent_message_phases.pop(item_id, "")
        phase = self._normalize_type(phase_value or stored_phase)
        if phase == "commentary":
            text = (
                self._extract_message_text(item)
                or self._commentary_delta_texts.get(item_id, "")
                or self._pending_agent_deltas.get(item_id, "")
            )
            self._pending_agent_delta_text = ""
            self._pending_agent_deltas.pop(item_id, None)
            if not text:
                return
            await self._complete_commentary_block(item_id, text)
            return

        if phase in {"finalanswer", "final_answer"} or not phase:
            text = (
                self._extract_message_text(item)
                or self._pending_agent_deltas.get(item_id, "")
                or self._pending_agent_delta_text
            )
            if not text:
                return
            self._pending_agent_delta_text = ""
            self._pending_agent_deltas.pop(item_id, None)
            if not self._saw_delta:
                self.final_text += text
                self._saw_delta = True
                await self.emitter.text_delta(text)
            else:
                self.final_text = text

    async def _handle_function_call(self, item: Any) -> None:
        call_id = self._call_id(item)
        if not call_id:
            logger.warning("Skipping Codex function_call without call_id")
            return

        name = str(self._get(item, "name") or "")
        arguments = self._parse_arguments(self._get(item, "arguments"))
        normalized_name, normalized_arguments, display_name = self._normalize_tool(
            name, arguments
        )
        self._tool_contexts[call_id] = {
            "name": normalized_name,
            "arguments": normalized_arguments,
        }
        await self.emitter.tool_start(
            call_id=call_id,
            name=normalized_name,
            arguments=normalized_arguments,
            display_name=display_name,
            tool_protocol="function_call",
        )

    async def _handle_function_call_output(self, item: Any) -> None:
        call_id = self._call_id(item)
        if not call_id:
            logger.warning("Skipping Codex function_call_output without call_id")
            return

        context = self._tool_contexts.pop(call_id, {})
        output = self._get(item, "output")
        await self.emitter.tool_done(
            call_id=call_id,
            name=str(context.get("name") or ""),
            arguments=context.get("arguments"),
            output=self._stringify_output(output),
            tool_protocol="function_call",
        )

    async def _handle_command_execution_start(self, item: Any) -> None:
        call_id = self._call_id(item)
        if not call_id or call_id in self._tool_contexts:
            return
        arguments = self._command_execution_arguments(item)
        self._tool_contexts[call_id] = {
            "name": "bash",
            "arguments": arguments,
        }
        await self.emitter.tool_start(
            call_id=call_id,
            name="bash",
            arguments=arguments,
            display_name="Shell",
            tool_protocol="function_call",
        )

    async def _handle_command_execution_done(self, item: Any) -> None:
        call_id = self._call_id(item)
        if not call_id:
            return
        if call_id not in self._tool_contexts:
            await self._handle_command_execution_start(item)
        context = self._tool_contexts.pop(call_id, {})
        status = self._command_execution_status(item)
        await self.emitter.tool_done(
            call_id=call_id,
            name=str(context.get("name") or "bash"),
            arguments=(
                context.get("arguments") or self._command_execution_arguments(item)
            ),
            output=self._stringify_output(
                self._get(item, "aggregated_output")
                or self._get(item, "aggregatedOutput")
            ),
            tool_protocol="function_call",
            status=status,
        )

    async def _append_commentary_delta(self, item_id: str, delta: str) -> None:
        block_id = self._commentary_block_ids.get(item_id)
        if not block_id:
            block_id = f"codex-commentary-{uuid.uuid4().hex[:12]}"
            self._commentary_block_ids[item_id] = block_id
            await self._emit_commentary_block(
                block_id=block_id,
                content="",
                status="streaming",
            )

        content = self._commentary_delta_texts.get(item_id, "") + delta
        self._commentary_delta_texts[item_id] = content
        await self.emitter.block_updated(
            block_id,
            {
                "content": content,
                "status": "streaming",
            },
        )

    async def _complete_commentary_block(self, item_id: str, content: str) -> None:
        block_id = self._commentary_block_ids.get(item_id)
        if not block_id:
            block_id = f"codex-commentary-{uuid.uuid4().hex[:12]}"
            await self._emit_commentary_block(
                block_id=block_id,
                content=content,
                status="done",
            )
        else:
            await self.emitter.block_updated(
                block_id,
                {
                    "content": content,
                    "status": "done",
                },
            )
        self._commentary_delta_texts.pop(item_id, None)
        self._commentary_block_ids.pop(item_id, None)

    async def _emit_commentary_block(
        self,
        block_id: str,
        content: str,
        status: str,
    ) -> None:
        await self.emitter.block_created(
            {
                "id": block_id,
                "type": "thinking",
                "content": content,
                "status": status,
                "timestamp": int(time.time() * 1000),
            }
        )

    def _handle_usage(self, payload: Any) -> None:
        token_usage = getattr(payload, "token_usage", None)
        if token_usage is None:
            token_usage = getattr(payload, "tokenUsage", None)
        if token_usage is None:
            return
        try:
            self.usage = token_usage.model_dump(mode="json", by_alias=True)
        except AttributeError:
            self.usage = token_usage if isinstance(token_usage, dict) else None

    async def _handle_turn_completed(self, payload: Any) -> TaskStatus:
        turn = getattr(payload, "turn", None)
        status_value = getattr(getattr(turn, "status", None), "value", None)

        if status_value == "completed":
            await self.emitter.done(content=self.final_text, usage=self.usage)
            return TaskStatus.COMPLETED

        if status_value == "interrupted":
            await self.emitter.incomplete(reason="cancelled", content=self.final_text)
            return TaskStatus.CANCELLED

        error_message = self._extract_error_message(turn)
        await self.emitter.error(error_message, "execution_error")
        return TaskStatus.FAILED

    @staticmethod
    def _extract_error_message(turn: Any) -> str:
        error = getattr(turn, "error", None)
        if error is None:
            return "Codex turn failed"
        message = getattr(error, "message", None)
        if message:
            return str(message)
        return str(error)

    @classmethod
    def _notification_item(cls, payload: Any) -> Any:
        item = cls._get(payload, "item")
        root = cls._get(item, "root")
        return root or item or payload

    @staticmethod
    def _get(source: Any, key: str, default: Any = None) -> Any:
        if source is None:
            return default
        if isinstance(source, dict):
            return source.get(key, default)
        return getattr(source, key, default)

    @staticmethod
    def _normalize_type(value: Any) -> str:
        raw_value = getattr(value, "value", value)
        return str(raw_value or "").replace("-", "_").lower()

    @classmethod
    def _extract_message_text(cls, item: Any) -> str:
        direct_text = cls._get(item, "text")
        if direct_text:
            return str(direct_text)

        content = cls._get(item, "content")
        if not isinstance(content, list):
            return ""

        parts: list[str] = []
        for block in content:
            block_type = cls._normalize_type(cls._get(block, "type"))
            if block_type not in {"output_text", "text", ""}:
                continue
            text = cls._get(block, "text")
            if text:
                parts.append(str(text))
        return "".join(parts)

    @classmethod
    def _call_id(cls, item: Any) -> str:
        value = cls._get(item, "call_id") or cls._get(item, "callId") or cls._get(
            item, "id"
        )
        return str(value or "")

    @classmethod
    def _agent_message_item_id(cls, source: Any) -> str:
        value = (
            cls._get(source, "item_id")
            or cls._get(source, "itemId")
            or cls._get(source, "id")
        )
        return str(value or DEFAULT_AGENT_MESSAGE_ID)

    @classmethod
    def _parse_arguments(cls, value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, str) and value:
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                return {"arguments": value}
            return parsed if isinstance(parsed, dict) else {"arguments": parsed}
        return {}

    @staticmethod
    def _normalize_tool(
        name: str, arguments: dict[str, Any]
    ) -> tuple[str, dict[str, Any], Optional[str]]:
        if name == "exec_command":
            normalized_arguments = dict(arguments)
            command = normalized_arguments.pop("cmd", None)
            workdir = normalized_arguments.pop("workdir", None)
            if command is not None:
                normalized_arguments["command"] = command
            if workdir is not None:
                normalized_arguments["cwd"] = workdir
            return "bash", normalized_arguments, "Shell"
        return name, arguments, None

    @classmethod
    def _command_execution_arguments(cls, item: Any) -> dict[str, Any]:
        arguments: dict[str, Any] = {}
        command = cls._get(item, "command")
        cwd = cls._get(item, "cwd")
        if command is not None:
            arguments["command"] = str(command)
        if cwd is not None:
            arguments["cwd"] = str(cwd)
        return arguments

    @classmethod
    def _command_execution_status(cls, item: Any) -> str:
        status = cls._normalize_type(cls._get(item, "status"))
        if status in {"failed", "declined", "error"}:
            return "failed"
        exit_code = cls._get(item, "exit_code")
        if exit_code is None:
            exit_code = cls._get(item, "exitCode")
        if isinstance(exit_code, int) and exit_code != 0:
            return "failed"
        return "completed"

    @staticmethod
    def _stringify_output(output: Any) -> Optional[str]:
        if output is None:
            return None
        if isinstance(output, str):
            return output
        return json.dumps(output, ensure_ascii=False)
