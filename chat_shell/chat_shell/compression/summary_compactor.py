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

import asyncio
import logging
import math
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.compression.tool_sanitizer import sanitize_tool_pairs

logger = logging.getLogger(__name__)

SUMMARY_PREFIX = (
    "[COMPACT SUMMARY] Another model worked on this task and produced the summary "
    "below. Use it to continue the work and avoid repeating completed steps."
)
SUMMARY_COMPACTED_FLAG = "compacted"
SUMMARY_METADATA_FLAG = "summary_compacted"
# Marks a raw user message retained into the compaction checkpoint. The turn
# serializer persists messages carrying this flag (see graph_builder), so the
# checkpoint chain is self-contained ([retained user] + [summary] + [suffix]).
CHECKPOINT_RETAINED_FLAG = "checkpoint_retained"
SUMMARY_COMPACT_VERSION = 1
DEFAULT_RECENT_USER_TOKEN_LIMIT = 20_000

# Overflow-retry policy for the summary request. Codex retries this call
# unboundedly, shedding a single oldest item each time, because in codex that
# loop is the *only* overflow defense for summarization. Here it is not: the
# guard runs a deterministic non-LLM fallback (``_apply_compression_pass`` /
# emergency pass) whenever ``compact()`` raises, and ``_trim_to_budget`` already
# trims proactively before the first call. So we cap the retries and shed a
# *batch* each pass (converging in a few calls on a mis-estimate), then defer to
# the guard fallback instead of grinding one item at a time.
MAX_SUMMARY_OVERFLOW_RETRIES = 3
SUMMARY_OVERFLOW_TRIM_FRACTION = 0.25

COMPACT_TASK_INSTRUCTION = """You are performing a CONTEXT CHECKPOINT COMPACTION. \
Create a handoff summary for another model that will resume this task.

Include:
- Current objective and active task
- Progress and key decisions made so far
- Important context, constraints, user preferences
- Critical facts, paths, parameters, and tool findings needed to continue
- The most important next step

Output ONLY the summary content itself. Do NOT restate this instruction, and do \
NOT add any preamble or meta-commentary (no "The user wants…", no "Let me \
summarize…", no "Here is the summary"). Start directly with the current \
objective. Be concise, structured, and focused on helping the next model \
seamlessly continue the work."""


@dataclass
class SummaryCompactResult:
    """Result of a successful summary compact operation."""

    summary_text: str
    replacement_history: list[BaseMessage]
    removed_history_items: int


class SummaryCompactNotApplicable(RuntimeError):
    """Raised when summary compact cannot help after trimming to the floor."""


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


def _is_summary_message(message: BaseMessage) -> bool:
    """True for a compaction summary message.

    Recognized only by the trusted ``summary_compacted`` marker. In package mode
    it rides in ``additional_kwargs`` directly; in HTTP mode the backend forwards
    it via a controlled ``metadata`` whitelist that the loader restores into
    ``additional_kwargs``. Content is never used to infer type — a user could
    legitimately send text starting with the summary prefix, and misclassifying
    it would drop their real request.
    """
    kwargs = getattr(message, "additional_kwargs", {}) or {}
    return kwargs.get(SUMMARY_METADATA_FLAG) is True


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
    """Best-effort classifier for compact-task overflow failures.

    Matches by HTTP status (400/413), English markers, and common Chinese /
    heteroglyph phrasings from non-OpenAI providers.
    """
    # 413 (payload too large) is unconditionally an overflow. A bare 400 is
    # ambiguous (invalid params, bad model config, malformed request), so it
    # only counts as overflow when a length marker is also present — otherwise a
    # non-overflow 400 would trigger a remove-one-message-and-retry storm.
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status == 413:
        return True
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
        "输入长度超过",
        "输入过长",
        "请求体过大",
        "token 数量超过",
        "上下文长度",
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
        max_compact_input_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> None:
        self._llm = llm
        self._token_counter = token_counter
        self._recent_user_token_limit = recent_user_token_limit
        self._max_compact_input_tokens = max_compact_input_tokens
        self._request_timeout = request_timeout

    async def compact(
        self,
        messages: list[BaseMessage],
        *,
        preserve_initial_context: bool,
    ) -> SummaryCompactResult:
        """Run compact task with a bounded, batched overflow self-retry."""
        # Sanitize up front so the budget reflects what will actually be sent
        # (orphan tool messages and unresolved tool_calls are dropped), rather
        # than over-counting raw messages that sanitize would remove anyway.
        working_messages = self._sanitize_tool_message_sequence(list(messages))
        current_user = self._find_current_user_message(working_messages)
        logger.info(
            "[SummaryCompact] compact() start: messages=%d "
            "max_compact_input_tokens=%s",
            len(working_messages),
            self._max_compact_input_tokens,
        )

        # Proactive budget trim runs once: it is a complete single pass, so a
        # later re-trim would be a no-op. The loop below only handles the case
        # where the provider still rejects our (estimated) request as too long.
        trim_started = time.perf_counter()
        removed = self._trim_to_budget(working_messages, current_user=current_user)
        if removed:
            logger.info(
                "[SummaryCompact] budget trim removed=%d remaining_messages=%d "
                "elapsed_ms=%.1f",
                removed,
                len(working_messages),
                (time.perf_counter() - trim_started) * 1000,
            )

        overflow_retries = 0
        while True:
            try:
                summary_body = await self._generate_summary(
                    self._sanitize_tool_message_sequence(working_messages)
                )
                break
            except Exception as exc:
                if not _is_context_too_long_error(exc):
                    raise
                if overflow_retries >= MAX_SUMMARY_OVERFLOW_RETRIES:
                    # Hand the still-too-large request to the guard's
                    # deterministic fallback instead of grinding further.
                    raise
                removable = len(
                    self._removable_history_indices(
                        working_messages, current_user=current_user
                    )
                )
                step = max(1, math.ceil(removable * SUMMARY_OVERFLOW_TRIM_FRACTION))
                dropped = self._remove_oldest_history_items(
                    working_messages, current_user=current_user, count=step
                )
                if not dropped:
                    raise
                overflow_retries += 1
                removed += dropped
                logger.info(
                    "[SummaryCompact] retry-trim after context-length failure: "
                    "retry=%d step=%d dropped=%d removed_total=%d "
                    "remaining_messages=%d",
                    overflow_retries,
                    step,
                    dropped,
                    removed,
                    len(working_messages),
                )

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
        # Instruction is the final user turn (recency), so the model summarizes
        # rather than continuing/answering the last question in the history.
        prompt_messages: list[BaseMessage] = [
            *messages,
            HumanMessage(content=COMPACT_TASK_INSTRUCTION),
        ]
        prompt_tokens = self._token_counter.count_messages(
            [_message_to_counter_dict(message) for message in prompt_messages]
        )
        logger.info(
            "[SummaryCompact] issuing summary request: messages=%d counted_tokens=%d",
            len(prompt_messages),
            prompt_tokens,
        )
        request_started = time.perf_counter()
        try:
            if self._request_timeout is not None:
                # asyncio.wait_for (not asyncio.timeout, which is 3.11+) keeps the
                # chat_shell >=3.10 support floor.
                result = await asyncio.wait_for(
                    self._llm.ainvoke(prompt_messages), self._request_timeout
                )
            else:
                result = await self._llm.ainvoke(prompt_messages)
        except BaseException as exc:
            # BaseException so a CancelledError (task/timeout cancellation) is
            # surfaced here rather than vanishing silently at the hang point.
            logger.warning(
                "[SummaryCompact] summary request ended after %.1fms: %s: %s",
                (time.perf_counter() - request_started) * 1000,
                type(exc).__name__,
                exc,
            )
            raise
        logger.info(
            "[SummaryCompact] summary request returned in %.1fms",
            (time.perf_counter() - request_started) * 1000,
        )
        summary_text = _extract_text(result).strip()
        if not summary_text:
            raise SummaryCompactNotApplicable(
                "Summary compact returned an empty summary."
            )
        return summary_text

    def _trim_to_budget(
        self,
        messages: list[BaseMessage],
        *,
        current_user: HumanMessage | None,
    ) -> int:
        """Drop oldest removable messages in one O(n) pass to fit the budget.

        Token counts are computed once per message (not re-summed per removal).
        System messages and the current user message are never dropped. Callers
        pass an already-sanitized list so the estimate matches the sent prompt.

        Per-message cost excludes the counter's one-time reply-priming so the sum
        does not inflate by ~priming*N; the priming is added back exactly once via
        ``framing``. The result equals a single ``count_messages`` over the full
        compact prompt.
        """
        if self._max_compact_input_tokens is None:
            return 0

        priming = self._token_counter.count_messages([])
        counts = [
            self._token_counter.count_messages([_message_to_counter_dict(m)]) - priming
            for m in messages
        ]
        framing = self._token_counter.count_messages(
            [
                _message_to_counter_dict(
                    HumanMessage(content=COMPACT_TASK_INSTRUCTION)
                ),
            ]
        )
        total = sum(counts) + framing
        budget = self._max_compact_input_tokens
        if total <= budget:
            return 0

        drop: set[int] = set()
        for i, message in enumerate(messages):
            if total <= budget:
                break
            if isinstance(message, SystemMessage):
                continue
            if current_user is not None and message is current_user:
                continue
            drop.add(i)
            total -= counts[i]

        if total > budget:
            raise SummaryCompactNotApplicable(
                "Summary compact cannot reduce the request because the remaining "
                "floor still exceeds the compact-task input budget."
            )

        messages[:] = [m for i, m in enumerate(messages) if i not in drop]
        return len(drop)

    def _sanitize_tool_message_sequence(
        self, messages: list[BaseMessage]
    ) -> list[BaseMessage]:
        """Drop orphan tool messages and strip unresolved assistant tool calls."""
        return sanitize_tool_pairs(messages)

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

    @staticmethod
    def _clone_retained_user(message: HumanMessage) -> HumanMessage:
        """Clone a retained user message with a fresh id + checkpoint marker.

        A fresh id keeps the clone out of the turn's input-id set so
        ``_new_messages_from_state`` treats it as generated-this-turn; the marker
        makes the turn serializer persist it into ``messages_chain``.
        """
        kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
        kwargs[CHECKPOINT_RETAINED_FLAG] = True
        return HumanMessage(
            content=message.content, id=str(uuid4()), additional_kwargs=kwargs
        )

    def _select_recent_user_messages(
        self, messages: list[BaseMessage]
    ) -> list[HumanMessage]:
        selected: list[HumanMessage] = []
        used_tokens = 0

        for message in reversed(messages):
            if not isinstance(message, HumanMessage):
                continue
            if _is_summary_message(message):
                continue
            message_tokens = self._token_counter.count_messages(
                [_message_to_counter_dict(message)]
            )
            remaining_budget = self._recent_user_token_limit - used_tokens
            if remaining_budget <= 0:
                break

            if message_tokens <= remaining_budget:
                selected.append(self._clone_retained_user(message))
                used_tokens += message_tokens
                continue

            truncated = self._truncate_user_message(message, remaining_budget)
            if truncated is not None:
                selected.append(self._clone_retained_user(truncated))
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
            if _is_summary_message(message):
                continue
            return message
        return None

    @staticmethod
    def _removable_history_indices(
        messages: list[BaseMessage],
        *,
        current_user: HumanMessage | None,
    ) -> list[int]:
        """Indices eligible for overflow trimming, oldest first.

        System messages and the current user turn are always protected. When no
        current user turn exists, the newest removable message is also protected
        so at least one non-system message always survives.
        """
        removable = [
            index
            for index, message in enumerate(messages)
            if not isinstance(message, SystemMessage)
            and not (current_user is not None and message is current_user)
        ]
        if current_user is None and removable:
            removable = removable[:-1]
        return removable

    @classmethod
    def _remove_oldest_history_items(
        cls,
        messages: list[BaseMessage],
        *,
        current_user: HumanMessage | None,
        count: int,
    ) -> int:
        """Drop up to ``count`` oldest removable items; return how many went."""
        if count <= 0:
            return 0
        to_drop = set(
            cls._removable_history_indices(messages, current_user=current_user)[:count]
        )
        if not to_drop:
            return 0
        messages[:] = [
            message for index, message in enumerate(messages) if index not in to_drop
        ]
        return len(to_drop)
