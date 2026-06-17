# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Summary-based history compaction primitives.

This module provides the compact-task building blocks for the next context
governance phase:

1. ask the current model to summarize the current model-visible history
2. retry with ``remove_oldest`` when the compact task itself hits context limits
3. build a compact replacement history consisting of:
   - optional initial system context
   - recent real user messages
   - one compact summary message
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from chat_shell.compression.token_counter import TokenCounter

SUMMARY_PREFIX = "[COMPACT SUMMARY]"
SUMMARY_COMPACTED_FLAG = "compacted"
SUMMARY_METADATA_FLAG = "summary_compacted"
SUMMARY_COMPACT_VERSION = 1
DEFAULT_RECENT_USER_TOKEN_LIMIT = 20_000

COMPACT_TASK_INSTRUCTION = """You are generating a compact handoff summary for a follow-up model.

Output only the compact summary body in the exact structure below.
Do not add commentary or markdown outside the structure.

Current objective:
<current user goal and active task>

Key completed work:
<important actions already completed>

Important findings:
<facts, paths, parameters, constraints, tool findings that matter>

Next step:
<the most important next action to continue the task>
"""


@dataclass
class SummaryCompactResult:
    """Result of a successful summary compact operation."""

    summary_text: str
    replacement_history: list[BaseMessage]
    removed_history_items: int


def _message_to_counter_dict(message: BaseMessage) -> dict[str, Any]:
    role = "user"
    if isinstance(message, SystemMessage):
        role = "system"
    elif isinstance(message, AIMessage):
        role = "assistant"
    elif message.__class__.__name__ == "ToolMessage":
        role = "tool"

    payload: dict[str, Any] = {"role": role, "content": message.content}
    name = getattr(message, "name", None)
    if name:
        payload["name"] = name
    tool_call_id = getattr(message, "tool_call_id", None)
    if tool_call_id:
        payload["tool_call_id"] = tool_call_id
    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls:
        payload["tool_calls"] = tool_calls
    return payload


def _extract_text(message: BaseMessage) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                text_parts.append(part)
            elif isinstance(part, dict):
                text = part.get("text") or part.get("thinking") or ""
                if text:
                    text_parts.append(str(text))
        return "".join(text_parts)
    return str(content)


def _is_context_too_long_error(exc: Exception) -> bool:
    """Best-effort classifier for compact-task overflow failures."""
    text = " ".join(
        part for part in (str(exc), getattr(exc, "message", None)) if part
    ).lower()
    markers = (
        "context_length_exceeded",
        "context length exceeded",
        "prompt is too long",
        "input is too long",
        "maximum context length",
        "request too large",
        "maximum number of tokens",
        "token limit exceeded",
    )
    return any(marker in text for marker in markers)


class SummaryCompactor:
    """Generate compact summaries and replacement histories."""

    def __init__(
        self,
        *,
        llm: BaseChatModel,
        token_counter: TokenCounter,
        recent_user_token_limit: int = DEFAULT_RECENT_USER_TOKEN_LIMIT,
    ) -> None:
        self._llm = llm
        self._token_counter = token_counter
        self._recent_user_token_limit = recent_user_token_limit

    async def compact(
        self,
        messages: list[BaseMessage],
        *,
        preserve_initial_context: bool,
    ) -> SummaryCompactResult:
        """Run compact task with codex-style ``remove_oldest`` self-retry."""
        working_messages = list(messages)
        removed = 0
        current_user = self._find_current_user_message(working_messages)

        while True:
            try:
                summary_body = await self._generate_summary(working_messages)
                break
            except Exception as exc:
                if not _is_context_too_long_error(
                    exc
                ) or not self._remove_oldest_history_item(
                    working_messages,
                    current_user=current_user,
                ):
                    raise
                removed += 1

        replacement_history = self._build_replacement_history(
            working_messages,
            summary_body=summary_body,
            preserve_initial_context=preserve_initial_context,
        )
        return SummaryCompactResult(
            summary_text=summary_body,
            replacement_history=replacement_history,
            removed_history_items=removed,
        )

    async def _generate_summary(self, messages: list[BaseMessage]) -> str:
        prompt_messages: list[BaseMessage] = [
            SystemMessage(content=COMPACT_TASK_INSTRUCTION),
            *messages,
            HumanMessage(content="Produce the compact summary now."),
        ]
        result = await self._llm.ainvoke(prompt_messages)
        return _extract_text(result).strip()

    def _build_replacement_history(
        self,
        messages: list[BaseMessage],
        *,
        summary_body: str,
        preserve_initial_context: bool,
    ) -> list[BaseMessage]:
        replacement: list[BaseMessage] = []

        if preserve_initial_context:
            replacement.extend(
                message for message in messages if isinstance(message, SystemMessage)
            )

        replacement.extend(self._select_recent_user_messages(messages))
        replacement.append(
            HumanMessage(
                content=f"{SUMMARY_PREFIX}\n\n{summary_body}",
                additional_kwargs={
                    SUMMARY_COMPACTED_FLAG: True,
                    SUMMARY_METADATA_FLAG: True,
                    "summary_compact_version": SUMMARY_COMPACT_VERSION,
                },
            )
        )
        return replacement

    def _select_recent_user_messages(
        self, messages: list[BaseMessage]
    ) -> list[HumanMessage]:
        selected: list[HumanMessage] = []
        used_tokens = 0

        for message in reversed(messages):
            if not isinstance(message, HumanMessage):
                continue
            kwargs = getattr(message, "additional_kwargs", {}) or {}
            if kwargs.get(SUMMARY_METADATA_FLAG) is True:
                continue
            message_tokens = self._token_counter.count_messages(
                [_message_to_counter_dict(message)]
            )
            remaining_budget = self._recent_user_token_limit - used_tokens
            if remaining_budget <= 0:
                break

            if message_tokens <= remaining_budget:
                selected.append(message)
                used_tokens += message_tokens
                continue

            truncated = self._truncate_user_message(message, remaining_budget)
            if truncated is not None:
                selected.append(truncated)
                break

        selected.reverse()
        return selected

    def _truncate_user_message(
        self,
        message: HumanMessage,
        token_budget: int,
    ) -> HumanMessage | None:
        if token_budget <= 0:
            return None

        text = _extract_text(message)
        if not text:
            return HumanMessage(
                content="",
                additional_kwargs=deepcopy(
                    getattr(message, "additional_kwargs", {}) or {}
                ),
            )

        token_ids = self._token_counter.encoding.encode(text, disallowed_special=())
        if len(token_ids) <= token_budget:
            return message
        if token_budget <= 0:
            return None

        truncated_text = self._token_counter.encoding.decode(token_ids[:token_budget])
        return HumanMessage(
            content=truncated_text,
            additional_kwargs=deepcopy(getattr(message, "additional_kwargs", {}) or {}),
        )

    @staticmethod
    def _find_current_user_message(
        messages: list[BaseMessage],
    ) -> HumanMessage | None:
        for message in reversed(messages):
            if not isinstance(message, HumanMessage):
                continue
            kwargs = getattr(message, "additional_kwargs", {}) or {}
            if kwargs.get(SUMMARY_METADATA_FLAG) is True:
                continue
            return message
        return None

    @staticmethod
    def _remove_oldest_history_item(
        messages: list[BaseMessage],
        *,
        current_user: HumanMessage | None,
    ) -> bool:
        for index, message in enumerate(messages):
            if isinstance(message, SystemMessage):
                continue
            if current_user is not None and message is current_user:
                continue
            del messages[index]
            return True
        return False
