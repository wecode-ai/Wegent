#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Any, Optional

from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter
from shared.status import TaskStatus

logger = setup_logger("codex_event_mapper")


class CodeXEventMapper:
    """Translate Codex SDK notifications to Wegent Responses API events."""

    def __init__(self, emitter: ResponsesAPIEmitter):
        self.emitter = emitter
        self.final_text = ""
        self.usage: Optional[dict[str, Any]] = None
        self._saw_delta = False

    async def handle(self, event: Any) -> Optional[TaskStatus]:
        method = getattr(event, "method", "")
        payload = getattr(event, "payload", None)

        if method == "item/agentMessage/delta":
            delta = str(getattr(payload, "delta", "") or "")
            if delta:
                self.final_text += delta
                self._saw_delta = True
                await self.emitter.text_delta(delta)
            return None

        if method == "item/completed":
            self._handle_completed_item(payload)
            return None

        if method == "thread/tokenUsage/updated":
            self._handle_usage(payload)
            return None

        if method == "turn/completed":
            return await self._handle_turn_completed(payload)

        return None

    def _handle_completed_item(self, payload: Any) -> None:
        item = getattr(payload, "item", None)
        root = getattr(item, "root", None)
        if getattr(root, "type", None) != "agentMessage":
            return
        text = str(getattr(root, "text", "") or "")
        if text and not self._saw_delta:
            self.final_text = text

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
