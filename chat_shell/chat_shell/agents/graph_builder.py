# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph graph builder for agent workflows.

This module provides a simplified LangGraph agent implementation using:
- LangGraph's prebuilt create_react_agent for ReAct workflow
- LangChain's convert_to_messages for message format conversion
- Streaming support with cancellation
- State checkpointing for resumability
"""

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator
from typing import Any, Callable, Optional

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.messages.utils import convert_to_messages
from langchain_core.tools.base import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.prebuilt import create_react_agent
from opentelemetry import trace as otel_trace

from shared.telemetry.decorators import add_span_event, trace_sync

from ..core.config import settings
from ..llm_logging import env_bool as _env_bool
from ..llm_logging import log_direct_llm_request as _log_direct_llm_request
from ..llm_logging import log_direct_llm_response as _log_direct_llm_response
from ..llm_logging import log_llm_request_event as _log_llm_request_event
from ..llm_logging import log_llm_response_event as _log_llm_response_event
from ..tools.base import ToolRegistry
from ..tools.builtin.silent_exit import SilentExitException

logger = logging.getLogger(__name__)

# Message to send to model when tool call limit is reached
TOOL_LIMIT_REACHED_MESSAGE = """[SYSTEM NOTICE] Tool call limit reached. You have made too many tool calls in this conversation.

Please provide your final response to the user based on the information you have gathered so far. Do NOT attempt to call any more tools - simply summarize your findings and provide a helpful response."""

# Truncation detection constants
# These finish_reason values indicate content was truncated due to max_token limit
TRUNCATION_REASONS = frozenset({"length", "max_tokens", "MAX_TOKENS"})

# Special marker format for truncation info (similar to reasoning content markers)
TRUNCATED_MARKER_START = "__TRUNCATED__"
TRUNCATED_MARKER_END = "__END_TRUNCATED__"

# Error message to send to LLM when tool calls are truncated
TOOL_CALL_TRUNCATION_ERROR_TEMPLATE = """[SYSTEM ERROR] Your previous response was truncated due to reaching the maximum token limit before completing the tool call(s).

The incomplete tool call(s) could not be executed because the parameters were cut off.

Please adjust your approach:
- Use shorter or more concise parameters
- Break complex operations into smaller, separate tool calls
- Simplify your response to stay within token limits

Truncation reason: {reason}
Attempt: {attempt}/{max_attempts}

Please try again with a different approach."""


class ToolCallTruncatedError(Exception):
    """Exception raised when tool calls are truncated due to max_token limit."""

    def __init__(self, reason: str, has_tool_calls: bool = False):
        """Initialize the exception.

        Args:
            reason: The truncation reason from the model
            has_tool_calls: Whether incomplete tool calls were detected
        """
        self.reason = reason
        self.has_tool_calls = has_tool_calls
        super().__init__(f"Tool call truncated: {reason}")


class InvalidToolMessageSequenceError(ValueError):
    """Raised when tool-call linkage is invalid for any LLM protocol.

    The chat_shell internally uses OpenAI-style message dicts as the canonical
    representation before they are adapted to OpenAI Chat Completions,
    OpenAI Responses API, Anthropic Messages API, or Gemini API.
    """


def _require_non_empty_tool_id(tool_id: Any, context: str) -> str:
    """Return a validated tool ID or raise if it is missing/blank."""
    if tool_id is None:
        value = ""
    elif isinstance(tool_id, str):
        value = tool_id
    else:
        value = str(tool_id)

    if not value.strip():
        raise InvalidToolMessageSequenceError(f"{context} must be a non-empty string")

    return value


def _validate_tool_message_sequence(
    messages: list[dict[str, Any]], *, context: str
) -> None:
    """Validate tool-call / tool-result linkage before provider adaptation.

    This fail-fast check applies to all protocols because the canonical message
    sequence is shared before it is adapted for OpenAI Chat Completions,
    OpenAI Responses API, Anthropic Messages API, or Gemini API.
    """
    pending_tool_calls: dict[str, int] = {}

    for index, message in enumerate(messages):
        role = message.get("role")

        if role == "assistant":
            tool_calls = message.get("tool_calls") or []
            for tool_index, tool_call in enumerate(tool_calls):
                if not isinstance(tool_call, dict):
                    raise InvalidToolMessageSequenceError(
                        f"{context}: assistant message at index {index} has invalid "
                        f"tool_calls[{tool_index}] payload"
                    )

                tool_id = _require_non_empty_tool_id(
                    tool_call.get("id"),
                    f"{context}: assistant message at index {index} tool_calls[{tool_index}].id",
                )

                if tool_id in pending_tool_calls:
                    raise InvalidToolMessageSequenceError(
                        f"{context}: duplicate unresolved tool_call id {tool_id!r} "
                        f"at assistant message index {index}"
                    )

                pending_tool_calls[tool_id] = index

        elif role == "tool":
            tool_call_id = _require_non_empty_tool_id(
                message.get("tool_call_id"),
                f"{context}: tool message at index {index} tool_call_id",
            )

            if tool_call_id not in pending_tool_calls:
                raise InvalidToolMessageSequenceError(
                    f"{context}: tool message at index {index} references unknown "
                    f"tool_call_id {tool_call_id!r}"
                )

            del pending_tool_calls[tool_call_id]

    if pending_tool_calls:
        unresolved = ", ".join(repr(tool_id) for tool_id in pending_tool_calls)
        raise InvalidToolMessageSequenceError(
            f"{context}: assistant tool_calls without matching tool results: {unresolved}"
        )


def _convert_validated_messages(
    messages: list[dict[str, Any]], *, context: str
) -> list[BaseMessage]:
    """Validate canonical message linkage, then convert to LangChain messages."""
    _validate_tool_message_sequence(messages, context=context)
    return convert_to_messages(messages)


def _serialize_messages_chain(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    """Serialize LangChain messages to OpenAI-compatible dicts for history persistence.

    Converts AIMessage and ToolMessage objects produced during a single agent turn
    into a list of dicts that can be:
    1. Stored in ``subtask.result.messages_chain``
    2. Loaded back via ``langchain_core.messages.utils.convert_to_messages``

    Preserves tool_calls, tool results, and reasoning_content.
    """
    chain: list[dict[str, Any]] = []
    for msg in messages:
        if isinstance(msg, AIMessage):
            entry: dict[str, Any] = {"role": "assistant", "content": msg.content}
            if msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": _require_non_empty_tool_id(
                            tc.get("id"),
                            "serialized messages_chain: assistant tool_calls[].id",
                        ),
                        "type": "function",
                        "function": {
                            "name": tc.get("name", ""),
                            "arguments": (
                                json.dumps(tc.get("args", {}))
                                if isinstance(tc.get("args"), dict)
                                else str(tc.get("args", ""))
                            ),
                        },
                    }
                    for tc in msg.tool_calls
                ]
            # Preserve reasoning content (DeepSeek R1 and similar models)
            reasoning = msg.additional_kwargs.get("reasoning_content")
            if reasoning:
                entry.setdefault("additional_kwargs", {})[
                    "reasoning_content"
                ] = reasoning
            chain.append(entry)
        elif isinstance(msg, ToolMessage):
            entry = {
                "role": "tool",
                "content": (
                    msg.content
                    if isinstance(msg.content, str)
                    else json.dumps(msg.content)
                ),
                "tool_call_id": _require_non_empty_tool_id(
                    msg.tool_call_id,
                    "serialized messages_chain: tool message tool_call_id",
                ),
            }
            if msg.name:
                entry["name"] = msg.name
            chain.append(entry)
    return chain


def _serialize_validated_messages_chain(
    messages: list[BaseMessage],
) -> list[dict[str, Any]]:
    """Serialize a generated turn and fail fast on broken tool-call linkage."""
    chain = _serialize_messages_chain(messages)
    _validate_tool_message_sequence(chain, context="serialized messages_chain")
    return chain


class LangGraphAgentBuilder:
    """Builder for LangGraph-based agent workflows using prebuilt ReAct agent."""

    def __init__(
        self,
        llm: BaseChatModel,
        tool_registry: ToolRegistry | None = None,
        max_iterations: int = 10,
        enable_checkpointing: bool = False,
        max_truncation_retries: int | None = None,
    ):
        """Initialize agent builder.

        Args:
            llm: LangChain chat model instance
            tool_registry: Registry of available tools (optional)
            max_iterations: Maximum tool loop iterations
            enable_checkpointing: Enable state checkpointing for resumability
            max_truncation_retries: Maximum retry attempts when tool calls are truncated.
                If None, uses settings.MAX_TRUNCATION_RETRIES
        """
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_iterations = max_iterations
        self.enable_checkpointing = enable_checkpointing
        self.max_truncation_retries = (
            max_truncation_retries
            if max_truncation_retries is not None
            else settings.MAX_TRUNCATION_RETRIES
        )
        self._agent = None

        # Get all LangChain tools from registry
        self.tools: list[BaseTool] = []
        if self.tool_registry:
            self.tools = self.tool_registry.get_all()

        # Initialize all_tools (will be updated during agent build to include skill tools)
        self.all_tools: list[BaseTool] = self.tools

        # Messages chain produced by the last stream_tokens() call
        self._last_messages_chain: list[dict[str, Any]] = []

        # Automatically detect PromptModifierTool instances from registered tools
        self._prompt_modifier_tools = self._find_prompt_modifier_tools()

    async def _collect_final_state_from_events(
        self,
        *,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
        collect_all_events: bool = True,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Execute via astream_events and capture final state plus optional events."""

        agent = self._build_agent()
        lc_messages = _convert_validated_messages(
            messages,
            context="agent execution input messages",
        )
        exec_config = {"configurable": config} if config else None

        all_events: list[dict[str, Any]] = []
        final_state: dict[str, Any] = {}

        try:
            async for event in agent.astream_events(
                {"messages": lc_messages},
                config={
                    **(exec_config or {}),
                    "recursion_limit": self.max_iterations * 2 + 1,
                },
                version="v2",
            ):
                if cancel_event and cancel_event.is_set():
                    logger.info("Streaming cancelled by user")
                    break

                if collect_all_events:
                    all_events.append(event)

                kind = event.get("event", "")

                if kind == "on_chat_model_start":
                    _log_llm_request_event(
                        event,
                        tool_names=[
                            t.name for t in getattr(self, "all_tools", []) or []
                        ],
                    )
                elif kind == "on_chat_model_end":
                    _log_llm_response_event(
                        event,
                        tool_names=[
                            t.name for t in getattr(self, "all_tools", []) or []
                        ],
                    )

                if kind == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    run_id = event.get("run_id", "")
                    if on_tool_event:
                        on_tool_event(
                            "tool_start",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": event.get("data", {}),
                            },
                        )

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    run_id = event.get("run_id", "")
                    if on_tool_event:
                        on_tool_event(
                            "tool_end",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": event.get("data", {}),
                            },
                        )

                elif kind == "on_chain_end" and event.get("name") == "LangGraph":
                    data = event.get("data", {})
                    output = data.get("output", {})
                    if output:
                        final_state = output

            return final_state, all_events

        except SilentExitException:
            logger.info(
                "[collect_final_state_from_events] SilentExitException caught, re-raising for caller to handle"
            )
            raise

        except GraphRecursionError:
            logger.warning(
                "[collect_final_state_from_events] GraphRecursionError: Tool call limit reached (max_iterations=%d). "
                "Asking model to provide final response.",
                self.max_iterations,
            )

            limit_messages = list(lc_messages) + [
                HumanMessage(content=TOOL_LIMIT_REACHED_MESSAGE)
            ]

            try:
                _log_direct_llm_request(
                    messages=limit_messages,
                    tool_names=[t.name for t in getattr(self, "all_tools", []) or []],
                    request_name="tool_limit_recovery",
                )
                response = await self.llm.ainvoke(limit_messages)
                _log_direct_llm_response(
                    response=response,
                    request_name="tool_limit_recovery",
                    tool_names=[t.name for t in getattr(self, "all_tools", []) or []],
                )
                final_content = ""
                if hasattr(response, "content"):
                    if isinstance(response.content, str):
                        final_content = response.content
                    elif isinstance(response.content, list):
                        text_parts = []
                        for part in response.content:
                            if isinstance(part, str):
                                text_parts.append(part)
                            elif isinstance(part, dict) and part.get("type") == "text":
                                text_parts.append(part.get("text", ""))
                        final_content = "".join(text_parts)

                final_state = {
                    "messages": list(lc_messages) + [AIMessage(content=final_content)]
                }
                return final_state, all_events
            except Exception:
                logger.exception(
                    "Error generating final response after tool limit reached"
                )
                raise

        except Exception:
            logger.exception("Error while collecting final state from events")
            raise

    def _find_prompt_modifier_tools(self) -> list[Any]:
        """Find all tools that implement the PromptModifierTool protocol.

        Returns:
            List of tools that have get_prompt_modification method
        """
        from ..tools.base import PromptModifierTool

        modifier_tools = []
        for tool in self.tools:
            if isinstance(tool, PromptModifierTool):
                modifier_tools.append(tool)
                logger.debug(
                    "[LangGraphAgentBuilder] Found PromptModifierTool: %s",
                    tool.name,
                )
        return modifier_tools

    def _create_prompt_modifier(self) -> Callable | None:
        """Create a prompt modifier function for dynamic prompt injection.

        This function is called before each model invocation to inject
        prompt modifications from all PromptModifierTool instances.

        Returns:
            A callable that modifies the messages, or None if no modifier tools
        """
        if not self._prompt_modifier_tools:
            return None

        modifier_tools = self._prompt_modifier_tools

        def prompt_modifier(state: dict[str, Any]) -> list[BaseMessage]:
            """Modify messages to inject prompt modifications into system message.

            This function is called by LangGraph's create_react_agent before each
            model invocation. It collects prompt modifications from all
            PromptModifierTool instances and appends them to the system message.
            """
            messages = state.get("messages", [])
            if not messages:
                return messages

            # Collect prompt modifications from all modifier tools
            combined_modification = ""
            for tool in modifier_tools:
                modification = tool.get_prompt_modification()
                if modification:
                    combined_modification += modification

            if not combined_modification:
                # No modifications, return messages unchanged
                return messages

            # Find and update the system message
            new_messages = []
            system_updated = False

            for msg in messages:
                if isinstance(msg, SystemMessage) and not system_updated:
                    # Append modifications to existing system message.
                    # Content may be a string or a list of content blocks
                    # (e.g., when Anthropic cache_control breakpoints are set).
                    # Preserve the original format to keep cache markers intact.
                    if isinstance(msg.content, list):
                        # List of content blocks — append modification as a new
                        # text block so existing cache_control markers stay valid.
                        updated_content = msg.content + [
                            {"type": "text", "text": combined_modification}
                        ]
                    else:
                        updated_content = msg.content + combined_modification
                    new_messages.append(SystemMessage(content=updated_content))
                    system_updated = True

                    # Log the final system prompt metadata at INFO level
                    # Full content is only logged at DEBUG level to avoid leaking sensitive data
                    content_len = (
                        sum(
                            len(b.get("text", ""))
                            for b in updated_content
                            if isinstance(b, dict)
                        )
                        if isinstance(updated_content, list)
                        else len(updated_content)
                    )
                    logger.info(
                        "[prompt_modifier] Final system prompt (len=%d)",
                        content_len,
                    )
                    # logger.debug(
                    #     "[prompt_modifier] Final system prompt content:\n%s",
                    #     updated_content,
                    # )

                else:
                    new_messages.append(msg)

            # If no system message found, prepend one with modifications
            if not system_updated:
                new_messages.insert(0, SystemMessage(content=combined_modification))

            return new_messages

        return prompt_modifier

    def _detect_and_handle_truncation(
        self,
        finish_reason: str | None,
        output: Any,
        model_name: str,
        streamed_content: bool,
        detection_mode: str = "streaming",
    ) -> tuple[bool, bool]:
        """Detect truncation and check for tool calls in the output.

        This helper method consolidates truncation detection logic that was
        previously duplicated across streaming and non-streaming code paths.

        Args:
            finish_reason: The finish/stop reason from model response metadata
            output: The model output to check for tool calls (may be None for streaming)
            model_name: Name of the model for logging
            streamed_content: Whether content was streamed
            detection_mode: Context of detection ("streaming", "end_event", "non_streaming_fallback")

        Returns:
            Tuple of (has_truncation, has_tool_calls):
            - has_truncation: True if finish_reason indicates truncation
            - has_tool_calls: True if output contains tool calls (always False if output is None)
        """
        # Check if finish_reason indicates truncation
        if not finish_reason or finish_reason not in TRUNCATION_REASONS:
            return False, False

        # Check for tool calls in output (if output is provided)
        has_tool_calls = False
        if output is not None:
            if hasattr(output, "tool_calls"):
                has_tool_calls = bool(output.tool_calls)
            elif isinstance(output, dict):
                has_tool_calls = bool(output.get("tool_calls"))

        logger.warning(
            "[stream_tokens] Content truncated: "
            "reason=%s, model=%s, has_tool_calls=%s, mode=%s",
            finish_reason,
            model_name,
            has_tool_calls,
            detection_mode,
        )

        add_span_event(
            "truncation_detected",
            {
                "reason": finish_reason,
                "model_name": model_name,
                "has_tool_calls": has_tool_calls,
                "streamed_content": streamed_content,
                "detection_mode": detection_mode,
            },
        )

        return True, has_tool_calls

    def _find_load_skill_tool(self) -> Optional[Any]:
        """Find the LoadSkillTool from registered tools.

        Returns:
            LoadSkillTool instance or None if not found
        """
        from ..tools.builtin import LoadSkillTool

        for tool in self.tools:
            if isinstance(tool, LoadSkillTool):
                return tool
        return None

    def _create_model_configurator(self) -> tuple[Optional[Any], list[BaseTool]]:
        """Create a model configurator function for dynamic tool selection.

        This function is called before each model invocation to dynamically
        select which tools are available based on loaded skills.

        Returns:
            A tuple of (callable that configures the model with tools, all tools for execution)
            Returns (None, self.tools) if no dynamic tools
        """
        load_skill_tool = self._find_load_skill_tool()
        if not load_skill_tool:
            return None, self.tools

        # Get all registered skill tools
        all_skill_tools = load_skill_tool.get_all_registered_tools()
        if not all_skill_tools:
            return None, self.tools

        # Create a set of skill tool names for quick lookup
        skill_tool_names = {t.name for t in all_skill_tools}

        # Separate base tools (non-skill tools) from skill tools
        base_tools = [t for t in self.tools if t.name not in skill_tool_names]

        # All tools = base tools + all skill tools (for execution)
        # This ensures all tools are available for execution when model calls them
        all_tools = base_tools + all_skill_tools

        llm = self.llm

        def configure_model(state: dict[str, Any], config: Any) -> Any:
            """Configure the model with tools based on loaded skills.

            This function dynamically selects tools based on which skills
            have been loaded via load_skill tool.

            Args:
                state: The current agent state
                config: Runtime configuration from LangGraph
            """
            # Get currently available skill tools (only for loaded skills)
            available_skill_tools = load_skill_tool.get_available_tools()

            # Combine base tools with available skill tools
            selected_tools = base_tools + available_skill_tools

            logger.debug(
                "[configure_model] Selected %d tools: base=%d, skill=%d, loaded_skills=%s",
                len(selected_tools),
                len(base_tools),
                len(available_skill_tools),
                list(load_skill_tool.get_loaded_skills()),
            )

            return llm.bind_tools(selected_tools)

        return configure_model, all_tools

    @trace_sync(
        span_name="agent_builder.build_agent",
        tracer_name="chat_shell.agents",
        extract_attributes=lambda self, *args, **kwargs: {
            "agent.tools_count": len(self.tools),
            "agent.max_iterations": self.max_iterations,
            "agent.enable_checkpointing": self.enable_checkpointing,
        },
    )
    def _build_agent(self):
        """Build the LangGraph ReAct agent lazily."""
        if self._agent is not None:
            add_span_event("agent_already_built")
            return self._agent

        add_span_event("building_new_agent")

        # Use LangGraph's prebuilt create_react_agent
        checkpointer = MemorySaver() if self.enable_checkpointing else None
        add_span_event(
            "checkpointer_created", {"has_checkpointer": checkpointer is not None}
        )

        # Create prompt modifier for dynamic skill prompt injection
        prompt_modifier = self._create_prompt_modifier()
        add_span_event(
            "prompt_modifier_created",
            {"has_modifier": prompt_modifier is not None},
        )

        # Create model configurator for dynamic tool selection
        model_configurator, all_tools = self._create_model_configurator()
        add_span_event(
            "model_configurator_created",
            {
                "has_configurator": model_configurator is not None,
                "all_tools_count": len(all_tools),
            },
        )

        # Store all_tools for external access (e.g., for display_name lookup)
        self.all_tools = all_tools

        # Add llm built-in tools if supported (currently none)
        model_with_tools: BaseChatModel | Callable = self.llm
        # If we have a model configurator, use it for dynamic tool selection
        # Note: all_tools includes ALL possible tools (base + all skill tools) for execution
        # while model_configurator controls which tools the model sees at each step
        if model_configurator:
            self._agent = create_react_agent(
                model=model_configurator,
                tools=all_tools,
                checkpointer=checkpointer,
                prompt=prompt_modifier,
            )
        else:
            self._agent = create_react_agent(
                model=model_with_tools,
                tools=all_tools,
                checkpointer=checkpointer,
                prompt=prompt_modifier,
            )
        add_span_event("react_agent_created")

        return self._agent

    async def execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """Execute agent workflow (non-streaming).

        Args:
            messages: Initial conversation messages (OpenAI format)
            config: Optional configuration (thread_id for checkpointing)
            cancel_event: Optional cancellation event (not used in non-streaming)

        Returns:
            Final agent state with response
        """
        result, _events = await self._collect_final_state_from_events(
            messages=messages,
            config=config,
            cancel_event=cancel_event,
            collect_all_events=False,
        )
        return result

    async def stream_execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream agent workflow execution.

        Args:
            messages: Initial conversation messages
            config: Optional configuration (thread_id for checkpointing)
            cancel_event: Optional cancellation event

        Yields:
            State updates as they occur
        """
        agent = self._build_agent()
        lc_messages = _convert_validated_messages(
            messages,
            context="stream_execute input messages",
        )

        exec_config = {"configurable": config} if config else None

        _log_direct_llm_request(
            messages=lc_messages,
            tool_names=[t.name for t in getattr(self, "all_tools", []) or []],
            request_name="stream_execute",
        )

        async for event in agent.astream(
            {"messages": lc_messages},
            config={
                **(exec_config or {}),
                "recursion_limit": self.max_iterations * 2 + 1,
            },
        ):
            # Check cancellation
            if cancel_event and cancel_event.is_set():
                logger.info("Streaming cancelled by user")
                return
            yield event

    async def stream_tokens(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
        _truncation_retry_count: int = 0,
    ) -> AsyncGenerator[str, None]:
        """Stream tokens from agent execution.

        Uses LangGraph's astream_events API for token-level streaming.
        For models that don't support streaming, falls back to extracting
        final content from on_chain_end event.

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional callback for tool events (kind, event_data)

        Yields:
            Content tokens as they are generated
        """
        add_span_event("stream_tokens_started", {"message_count": len(messages)})

        add_span_event("building_agent_started")
        agent = self._build_agent()
        add_span_event("building_agent_completed")

        add_span_event("convert_to_messages_started", {"message_count": len(messages)})
        lc_messages = _convert_validated_messages(
            messages,
            context="stream_tokens input messages",
        )
        add_span_event(
            "convert_to_messages_completed", {"lc_message_count": len(lc_messages)}
        )

        exec_config = {"configurable": config} if config else None

        event_count = 0
        streamed_content = False  # Track if we've streamed any content
        final_content = ""  # Store final content for non-streaming fallback

        # Truncation detection state
        truncation_detected = False
        truncation_reason = ""

        # Collect the complete LangGraph state messages for history persistence
        _collected_state_messages: list[BaseMessage] = []

        # TTFT tracking variables
        first_token_received = False
        llm_request_start_time: float | None = None
        ttft_ms: float | None = None  # Time to first token in milliseconds

        # Get tracer for LLM request span
        tracer = otel_trace.get_tracer("chat_shell.agents")

        add_span_event("astream_events_starting")
        try:
            async for event in agent.astream_events(
                {"messages": lc_messages},
                config={
                    **(exec_config or {}),
                    "recursion_limit": self.max_iterations * 2 + 1,
                },
                version="v2",
            ):
                event_count += 1
                # Check cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info("Streaming cancelled by user")
                    return

                # Handle token streaming events
                kind = event.get("event", "")

                # Track LLM request start
                if kind == "on_chat_model_start":
                    llm_request_start_time = time.perf_counter()
                    first_token_received = False
                    add_span_event(
                        "llm_request_started",
                        {"model_name": event.get("name", "unknown")},
                    )

                    # Log the full JSON-like request structure sent to the model.
                    # This is best-effort and may include large payloads (e.g., base64 images).
                    _log_llm_request_event(
                        event,
                        tool_names=[
                            t.name for t in getattr(self, "all_tools", []) or []
                        ],
                    )

                # Log streaming completion event (much less verbose)
                if kind == "on_chat_model_stream":
                    # Calculate TTFT on first token
                    if not first_token_received and llm_request_start_time is not None:
                        ttft_ms = (time.perf_counter() - llm_request_start_time) * 1000
                        first_token_received = True
                        add_span_event(
                            "first_token_received",
                            {"ttft_ms": round(ttft_ms, 2)},
                        )
                        logger.info(
                            "[stream_tokens] TTFT: %.2fms",
                            ttft_ms,
                        )

                    data = event.get("data", {})
                    chunk = data.get("chunk")

                    # Log chunk details for debugging
                    if chunk:
                        logger.debug(
                            "[stream_tokens] on_chat_model_stream: chunk_type=%s, has_content=%s, content_type=%s",
                            type(chunk).__name__,
                            hasattr(chunk, "content"),
                            (
                                type(chunk.content).__name__
                                if hasattr(chunk, "content")
                                else "N/A"
                            ),
                        )

                    # Check for reasoning_content (DeepSeek R1 and similar reasoning models)
                    # reasoning_content may be in additional_kwargs or as a direct attribute
                    if chunk:
                        reasoning_content = None
                        # Try additional_kwargs first (LangChain's standard location for extra data)
                        if hasattr(chunk, "additional_kwargs"):
                            reasoning_content = chunk.additional_kwargs.get(
                                "reasoning_content"
                            )
                        # Also check direct attribute (some providers may use this)
                        if not reasoning_content and hasattr(
                            chunk, "reasoning_content"
                        ):
                            reasoning_content = chunk.reasoning_content

                        if reasoning_content:
                            logger.debug(
                                "[stream_tokens] Yielding reasoning_content: %s...",
                                (
                                    reasoning_content[:50]
                                    if len(reasoning_content) > 50
                                    else reasoning_content
                                ),
                            )
                            # Use special prefix to mark reasoning content
                            # Format: __REASONING__<content>__END_REASONING__
                            yield f"__REASONING__{reasoning_content}__END_REASONING__"

                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        # Handle different content types
                        if isinstance(content, str) and content:
                            logger.debug(
                                "[stream_tokens] Yielding string content: %s...",
                                content[:50] if len(content) > 50 else content,
                            )
                            streamed_content = True
                            yield content
                        elif isinstance(content, list):
                            # Handle list content (e.g., multimodal, tool calls,
                            # or Claude thinking blocks)
                            for part in content:
                                if isinstance(part, str) and part:
                                    logger.debug(
                                        "[stream_tokens] Yielding list string: %s...",
                                        part[:50] if len(part) > 50 else part,
                                    )
                                    streamed_content = True
                                    yield part
                                elif isinstance(part, dict):
                                    part_type = part.get("type", "")
                                    # Claude thinking blocks: route through
                                    # reasoning markers for frontend display
                                    if part_type == "thinking":
                                        thinking_text = part.get("thinking", "")
                                        if thinking_text:
                                            logger.debug(
                                                "[stream_tokens] Yielding Claude thinking: %s...",
                                                (
                                                    thinking_text[:50]
                                                    if len(thinking_text) > 50
                                                    else thinking_text
                                                ),
                                            )
                                            yield f"__REASONING__{thinking_text}__END_REASONING__"
                                    elif part_type == "reasoning":
                                        # OpenAI Responses API reasoning blocks:
                                        # {"type": "reasoning", "summary": [{"type": "summary_text", "text": "..."}]}
                                        for item in part.get("summary") or []:
                                            if (
                                                isinstance(item, dict)
                                                and item.get("type") == "summary_text"
                                            ):
                                                summary_text = item.get("text", "")
                                                if summary_text:
                                                    logger.debug(
                                                        "[stream_tokens] Yielding Responses API reasoning: %s...",
                                                        (
                                                            summary_text[:50]
                                                            if len(summary_text) > 50
                                                            else summary_text
                                                        ),
                                                    )
                                                    yield f"__REASONING__{summary_text}__END_REASONING__"
                                    else:
                                        # Extract text from dict format
                                        text = part.get("text", "")
                                        if text:
                                            logger.debug(
                                                "[stream_tokens] Yielding dict text: %s...",
                                                text[:50] if len(text) > 50 else text,
                                            )
                                            streamed_content = True
                                            yield text
                        # Log when content is empty or unexpected type
                        elif content:
                            logger.debug(
                                "[stream_tokens] Unexpected content type: %s, value: %s",
                                type(content).__name__,
                                str(content)[:100],
                            )
                        # Log empty content case
                        else:
                            logger.debug("[stream_tokens] Empty content in chunk")

                    # Check for truncation due to max_token limit
                    # Different LLM providers use different field names and values:
                    # - GPT (OpenAI): finish_reason="length"
                    # - Claude (Anthropic): stop_reason="max_tokens" (mapped to finish_reason by LangChain)
                    # - Gemini (Google): finish_reason="MAX_TOKENS"
                    if chunk and hasattr(chunk, "response_metadata"):
                        metadata = chunk.response_metadata or {}
                        finish_reason = metadata.get("finish_reason") or metadata.get(
                            "stop_reason"
                        )

                        # Use helper method to detect truncation
                        # Note: output=None since we're in streaming mode, tool call check happens later
                        model_name = event.get("name", "unknown")
                        has_truncation, _ = self._detect_and_handle_truncation(
                            finish_reason,
                            output=None,
                            model_name=model_name,
                            streamed_content=streamed_content,
                            detection_mode="streaming",
                        )

                        if has_truncation:
                            # Record truncation detection - will check for tool calls at end
                            truncation_detected = True
                            truncation_reason = finish_reason

                elif kind == "on_chat_model_end":
                    _log_llm_response_event(
                        event,
                        tool_names=[
                            t.name for t in getattr(self, "all_tools", []) or []
                        ],
                    )
                    # Track LLM request completion
                    if llm_request_start_time is not None:
                        total_llm_time_ms = (
                            time.perf_counter() - llm_request_start_time
                        ) * 1000
                        add_span_event(
                            "llm_request_completed",
                            {
                                "total_time_ms": round(total_llm_time_ms, 2),
                                "ttft_ms": round(ttft_ms, 2) if ttft_ms else None,
                            },
                        )
                        logger.info(
                            "[stream_tokens] LLM request completed: total=%.2fms, ttft=%.2fms",
                            total_llm_time_ms,
                            ttft_ms or 0,
                        )
                        # Reset for potential next LLM call (e.g., after tool execution)
                        llm_request_start_time = None

                    # Check if truncation was detected earlier
                    # If yes, check if the final output contains tool calls
                    if truncation_detected:
                        output = event.get("data", {}).get("output")
                        has_tool_calls = False

                        # Check for tool calls in the output
                        if hasattr(output, "tool_calls"):
                            has_tool_calls = bool(output.tool_calls)
                        elif isinstance(output, dict):
                            has_tool_calls = bool(output.get("tool_calls"))

                        logger.warning(
                            "[stream_tokens] Truncation + tool calls check: "
                            "has_tool_calls=%s, reason=%s",
                            has_tool_calls,
                            truncation_reason,
                        )

                        if has_tool_calls:
                            # Tool calls present with truncation - raise exception for recovery
                            add_span_event(
                                "tool_call_truncated",
                                {
                                    "reason": truncation_reason,
                                    "has_tool_calls": True,
                                },
                            )
                            raise ToolCallTruncatedError(
                                reason=truncation_reason, has_tool_calls=True
                            )
                        else:
                            # Regular content truncation without tool calls
                            # Yield truncation marker
                            add_span_event(
                                "content_truncated",
                                {
                                    "reason": truncation_reason,
                                    "has_tool_calls": False,
                                },
                            )
                            yield f"{TRUNCATED_MARKER_START}{truncation_reason}{TRUNCATED_MARKER_END}"

                        # Reset truncation flag
                        truncation_detected = False
                        truncation_reason = ""

                    # Fallback truncation detection for non-streaming models
                    # When model doesn't emit on_chat_model_stream events, check final output
                    if not streamed_content:
                        output = event.get("data", {}).get("output")
                        metadata = {}
                        if hasattr(output, "response_metadata"):
                            metadata = output.response_metadata or {}
                        elif isinstance(output, dict):
                            metadata = output.get("response_metadata") or output.get(
                                "generation_info", {}
                            )
                        finish_reason = metadata.get("finish_reason") or metadata.get(
                            "stop_reason"
                        )

                        # Use helper method to detect truncation with tool call check
                        model_name = event.get("name", "unknown")
                        has_truncation, has_tool_calls = (
                            self._detect_and_handle_truncation(
                                finish_reason,
                                output=output,
                                model_name=model_name,
                                streamed_content=streamed_content,
                                detection_mode="non_streaming_fallback",
                            )
                        )

                        if has_truncation:
                            # If tool calls are truncated, raise exception to trigger recovery
                            if has_tool_calls:
                                raise ToolCallTruncatedError(
                                    reason=finish_reason, has_tool_calls=True
                                )

                            # Otherwise, just yield truncation marker for regular content
                            yield f"{TRUNCATED_MARKER_START}{finish_reason}{TRUNCATED_MARKER_END}"

                elif kind == "on_chain_end" and event.get("name") == "LangGraph":
                    # Extract final content from the top-level LangGraph chain end
                    # This is useful for non-streaming models
                    data = event.get("data", {})
                    output = data.get("output", {})
                    messages_output = output.get("messages", [])

                    if messages_output:
                        # Capture the most complete messages list for history
                        if len(messages_output) >= len(_collected_state_messages):
                            _collected_state_messages = list(messages_output)

                        # Get the last AI message
                        for msg in reversed(messages_output):
                            if isinstance(msg, AIMessage):
                                if isinstance(msg.content, str):
                                    final_content = msg.content
                                elif isinstance(msg.content, list):
                                    # Handle multimodal responses
                                    text_parts = []
                                    for part in msg.content:
                                        if (
                                            isinstance(part, dict)
                                            and part.get("type") == "text"
                                        ):
                                            text_parts.append(part.get("text", ""))
                                        elif isinstance(part, str):
                                            text_parts.append(part)
                                    final_content = "".join(text_parts)
                                break

                elif kind == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    # Get run_id to track tool execution pairs
                    run_id = event.get("run_id", "")
                    # Get tool input data from event
                    tool_input_data = event.get("data", {})
                    # Notify callback if provided
                    if on_tool_event:
                        on_tool_event(
                            "tool_start",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": tool_input_data,
                            },
                        )
                        # Yield empty string to trigger _emit_pending_events() in chat_service
                        # This ensures tool events are sent immediately instead of being buffered
                        yield ""

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    # Get run_id to match with tool_start
                    run_id = event.get("run_id", "")
                    # Get tool output for logging
                    tool_data = event.get("data", {})
                    # Notify callback if provided
                    if on_tool_event:
                        on_tool_event(
                            "tool_end",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": tool_data,
                            },
                        )
                        # Yield empty string to trigger _emit_pending_events() in chat_service
                        # This ensures tool events are sent immediately instead of being buffered
                        yield ""

            # If no content was streamed but we have final content, yield it
            # This handles non-streaming models
            if not streamed_content and final_content:
                logger.debug(
                    "[stream_tokens] No streaming content, yielding final content: len=%d",
                    len(final_content),
                )
                yield final_content

            # Serialize collected messages chain for history persistence
            # Only keep new messages generated in this turn (skip input messages)
            if _collected_state_messages:
                new_msgs = _collected_state_messages[len(lc_messages) :]
                self._last_messages_chain = _serialize_validated_messages_chain(
                    new_msgs
                )
            else:
                self._last_messages_chain = []

            logger.debug(
                "[stream_tokens] Streaming completed: total_events=%d, streamed=%s, messages_chain_len=%d",
                event_count,
                streamed_content,
                len(self._last_messages_chain),
            )

        except ToolCallTruncatedError as e:
            # Tool call was truncated - report error to LLM for recovery
            logger.warning(
                "[stream_tokens] ToolCallTruncatedError: Tool calls truncated (reason=%s, retry_count=%d/%d). "
                "Reporting error to LLM for recovery.",
                e.reason,
                _truncation_retry_count,
                self.max_truncation_retries,
            )

            # Check if we've exceeded retry limit
            if _truncation_retry_count >= self.max_truncation_retries:
                logger.error(
                    "[stream_tokens] Max truncation retries exceeded (%d). "
                    "Yielding final truncation warning.",
                    self.max_truncation_retries,
                )
                # Yield truncation marker to show warning in UI
                yield f"{TRUNCATED_MARKER_START}{e.reason}{TRUNCATED_MARKER_END}"
                return

            # Construct error message for LLM
            error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
                reason=e.reason,
                attempt=_truncation_retry_count + 1,
                max_attempts=self.max_truncation_retries,
            )

            # Add error message to conversation history
            recovery_messages = list(lc_messages) + [
                HumanMessage(content=error_message)
            ]

            # Retry with the error context
            logger.info(
                "[stream_tokens] Retrying with truncation error context (attempt %d/%d)",
                _truncation_retry_count + 1,
                self.max_truncation_retries,
            )

            # Recursively call stream_tokens with incremented retry count
            # This allows LLM to adjust its strategy based on the error
            async for token in self.stream_tokens(
                messages=[
                    (
                        msg.model_dump()
                        if hasattr(msg, "model_dump")
                        else msg.dict() if hasattr(msg, "dict") else msg
                    )
                    for msg in recovery_messages
                ],
                config=config,
                cancel_event=cancel_event,
                on_tool_event=on_tool_event,
                _truncation_retry_count=_truncation_retry_count + 1,
            ):
                yield token

        except SilentExitException:
            # Silent exit requested by tool - re-raise to be handled by caller
            # This is not an error, just a signal to terminate silently
            logger.info(
                "[stream_tokens] SilentExitException caught, re-raising for caller to handle"
            )
            # Persist partial messages chain before re-raising
            if _collected_state_messages:
                new_msgs = _collected_state_messages[len(lc_messages) :]
                self._last_messages_chain = _serialize_validated_messages_chain(
                    new_msgs
                )
            raise

        except GraphRecursionError as e:
            # Tool call limit reached - ask model to provide final response
            logger.warning(
                "[stream_tokens] GraphRecursionError: Tool call limit reached (max_iterations=%d). "
                "Asking model to provide final response.",
                self.max_iterations,
            )

            # Persist messages chain from iterations before the limit
            if _collected_state_messages:
                new_msgs = _collected_state_messages[len(lc_messages) :]
                self._last_messages_chain = _serialize_validated_messages_chain(
                    new_msgs
                )

            # Build messages with the limit reached notice
            # Add a human message to prompt the model to provide final response
            limit_messages = list(lc_messages) + [
                HumanMessage(content=TOOL_LIMIT_REACHED_MESSAGE)
            ]

            # Call the LLM directly (without tools) to get final response
            try:
                _log_direct_llm_request(
                    messages=limit_messages,
                    tool_names=[t.name for t in getattr(self, "all_tools", []) or []],
                    request_name="tool_limit_recovery_stream",
                )
                async for chunk in self.llm.astream(limit_messages):
                    if hasattr(chunk, "content"):
                        content = chunk.content
                        if isinstance(content, str) and content:
                            yield content
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, str) and part:
                                    yield part
                                elif isinstance(part, dict):
                                    text = part.get("text", "")
                                    if text:
                                        yield text

                logger.info(
                    "[stream_tokens] Final response generated after tool limit reached"
                )
            except Exception as recovery_error:
                logger.exception(
                    "Error generating final response after tool limit reached"
                )
                raise

        except Exception as e:
            logger.exception("Error in stream_tokens")
            raise

    def get_final_content(self, state: dict[str, Any]) -> str:
        """Extract final content from agent state.

        Args:
            state: Final agent state from execute()

        Returns:
            Final response content
        """
        messages: list[BaseMessage] = state.get("messages", [])
        if not messages:
            return ""

        # Find the last AI message
        for msg in reversed(messages):
            if isinstance(msg, AIMessage):
                if isinstance(msg.content, str):
                    return msg.content
                elif isinstance(msg.content, list):
                    # Handle multimodal responses
                    text_parts = []
                    for part in msg.content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                        elif isinstance(part, str):
                            text_parts.append(part)
                    return "".join(text_parts)

        return ""

    def has_tool_calls(self, state: dict[str, Any]) -> bool:
        """Check if state has pending tool calls.

        Args:
            state: Agent state

        Returns:
            True if there are pending tool calls
        """
        messages: list[BaseMessage] = state.get("messages", [])
        if not messages:
            return False

        last_message = messages[-1]
        return hasattr(last_message, "tool_calls") and bool(last_message.tool_calls)

    async def stream_events_with_state(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Stream events and return final state with all events.

        This method is designed for scenarios like correction evaluation where:
        1. We need to capture tool events for progress updates
        2. We need the final state to extract structured results
        3. We want to avoid executing the agent twice

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional async callback for tool events (kind, event_data)

        Returns:
            Tuple of (final_state, all_events)
        """
        final_state, all_events = await self._collect_final_state_from_events(
            messages=messages,
            config=config,
            cancel_event=cancel_event,
            on_tool_event=on_tool_event,
            collect_all_events=True,
        )
        logger.debug(
            "[stream_events_with_state] Completed: total_events=%d",
            len(all_events),
        )
        return final_state, all_events
