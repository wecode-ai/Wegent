# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Converter between ExecutionRequest and OpenAI Responses API format.

This module provides bidirectional conversion between:
- ExecutionRequest (internal format used by backend, executor, etc.)
- OpenAI Responses API format (standard format for OpenAI client consumption)

Usage:
    # Backend: Convert ExecutionRequest to OpenAI format for sending to chat_shell
    openai_request = OpenAIRequestConverter.from_execution_request(execution_request)

    # Chat Shell: Convert OpenAI format back to ExecutionRequest for processing
    execution_request = OpenAIRequestConverter.to_execution_request(openai_request)
"""

import logging
from dataclasses import asdict
from typing import Any, Optional

from .execution import ExecutionRequest

logger = logging.getLogger(__name__)


class OpenAIRequestConverter:
    """Converter between ExecutionRequest and OpenAI Responses API format.

    OpenAI Responses API format:
    {
        "model": "gpt-4",
        "input": "user message" or [{"role": "user", "content": "..."}],
        "instructions": "system prompt",
        "tools": [...],
        "stream": true,
        "metadata": {...}  # Custom extension for our internal data
    }
    """

    @staticmethod
    def from_execution_request(request: ExecutionRequest) -> dict[str, Any]:
        """Convert ExecutionRequest to OpenAI Responses API format.

        Args:
            request: ExecutionRequest object

        Returns:
            Dict in OpenAI Responses API format
        """
        # Build input - can be string or messages array
        input_data: Any = request.prompt
        if request.history:
            # If we have history, use messages format
            messages = []
            for msg in request.history:
                messages.append(msg)
            # Add current user message
            if request.prompt:
                messages.append({"role": "user", "content": request.prompt})
            input_data = messages

        # Build tools array
        tools = []
        if request.mcp_servers:
            for server in request.mcp_servers:
                tools.append(
                    {
                        "type": "mcp",
                        "server_label": server.get("name", ""),
                        "server_url": server.get("url", ""),
                        "require_approval": "never",
                    }
                )

        # Build the OpenAI format request
        openai_request: dict[str, Any] = {
            "model": request.model_config.get("model_id", ""),
            "input": input_data,
            "stream": True,
        }

        # Add instructions (system prompt)
        if request.system_prompt:
            openai_request["instructions"] = request.system_prompt

        # Add tools if any
        if tools:
            openai_request["tools"] = tools

        # Add metadata - this is our custom extension to pass internal data
        # Chat shell will extract this to reconstruct ExecutionRequest
        metadata = {
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
            "user": request.user,  # Include full user dict for executor_manager
            "user_id": request.user_id,
            "user_name": request.user_name,
            "team_id": request.team_id,
            "team_name": request.team_name,
            "team_namespace": request.team_namespace,
            "bot": request.bot,  # Include bot config with shell_type for executor
            "bot_name": request.bot_name,
            "bot_namespace": request.bot_namespace,
            "message_id": request.message_id,
            "user_message_id": request.user_message_id,
            "user_subtask_id": request.user_subtask_id,
            "is_group_chat": request.is_group_chat,
            "history_limit": request.history_limit,
            "enable_tools": request.enable_tools,
            "enable_web_search": request.enable_web_search,
            "enable_clarification": request.enable_clarification,
            "enable_deep_thinking": request.enable_deep_thinking,
            "search_engine": request.search_engine,
            "skill_names": request.skill_names,
            "skill_configs": request.skill_configs,
            "preload_skills": request.preload_skills,
            "user_selected_skills": request.user_selected_skills,
            "knowledge_base_ids": request.knowledge_base_ids,
            "document_ids": request.document_ids,
            "is_user_selected_kb": request.is_user_selected_kb,
            "table_contexts": request.table_contexts,
            "task_data": request.task_data,
            "auth_token": request.auth_token,
            "task_token": request.task_token,
            "backend_url": request.backend_url,
            "workspace": request.workspace,
            "is_subscription": request.is_subscription,
            "request_id": request.request_id,
            "executor_name": request.executor_name,
        }
        openai_request["metadata"] = metadata

        # Add model_config as a separate field for chat_shell to use
        openai_request["model_config"] = request.model_config

        return openai_request

    @staticmethod
    def to_execution_request(openai_request: dict[str, Any]) -> ExecutionRequest:
        """Convert OpenAI Responses API format back to ExecutionRequest.

        Args:
            openai_request: Dict in OpenAI Responses API format

        Returns:
            ExecutionRequest object
        """
        metadata = openai_request.get("metadata", {})
        model_config = openai_request.get("model_config", {})

        # Extract prompt from input
        input_data = openai_request.get("input", "")
        prompt = ""
        history = []

        if isinstance(input_data, str):
            prompt = input_data
        elif isinstance(input_data, list):
            # Messages format - extract last user message as prompt
            for msg in input_data:
                if isinstance(msg, dict):
                    if msg.get("role") == "user":
                        prompt = msg.get("content", "")
                    history.append(msg)
            # Remove the last user message from history since it's the prompt
            if history and history[-1].get("role") == "user":
                history = history[:-1]

        # Extract MCP servers from tools
        mcp_servers = []
        tools = openai_request.get("tools", [])
        for tool in tools:
            if isinstance(tool, dict) and tool.get("type") == "mcp":
                mcp_servers.append(
                    {
                        "name": tool.get("server_label", ""),
                        "url": tool.get("server_url", ""),
                        "type": "streamable-http",
                    }
                )

        # Get user dict directly from metadata (passed from from_execution_request)
        user_dict = metadata.get("user", {})
        user_id = metadata.get("user_id", 0)
        user_name = metadata.get("user_name", "")

        # Ensure user_dict is a proper dict (handle None case)
        if user_dict is None:
            user_dict = {}
            print("[DEBUG to_execution_request] user_dict was None, using empty dict")
            logger.warning(
                "[to_execution_request] user_dict was None, using empty dict"
            )

        return ExecutionRequest(
            task_id=metadata.get("task_id", 0),
            subtask_id=metadata.get("subtask_id", 0),
            user=user_dict,
            user_id=user_id,
            user_name=user_name,
            team_id=metadata.get("team_id", 0),
            team_name=metadata.get("team_name", ""),
            team_namespace=metadata.get("team_namespace"),
            bot=metadata.get("bot", []),  # Bot config with shell_type for executor
            bot_name=metadata.get("bot_name", ""),
            bot_namespace=metadata.get("bot_namespace", ""),
            message_id=metadata.get("message_id"),
            user_message_id=metadata.get("user_message_id"),
            user_subtask_id=metadata.get("user_subtask_id"),
            is_group_chat=metadata.get("is_group_chat", False),
            history_limit=metadata.get("history_limit"),
            model_config=model_config,
            system_prompt=openai_request.get("instructions") or "",
            prompt=prompt,
            history=history,
            enable_tools=metadata.get("enable_tools", True),
            enable_web_search=metadata.get("enable_web_search", False),
            enable_clarification=metadata.get("enable_clarification", False),
            enable_deep_thinking=metadata.get("enable_deep_thinking", True),
            search_engine=metadata.get("search_engine"),
            skill_names=metadata.get("skill_names", []),
            skill_configs=metadata.get("skill_configs", []),
            preload_skills=metadata.get("preload_skills", []),
            user_selected_skills=metadata.get("user_selected_skills", []),
            mcp_servers=mcp_servers,
            knowledge_base_ids=metadata.get("knowledge_base_ids"),
            document_ids=metadata.get("document_ids"),
            is_user_selected_kb=metadata.get("is_user_selected_kb", True),
            table_contexts=metadata.get("table_contexts", []),
            task_data=metadata.get("task_data"),
            auth_token=metadata.get("auth_token", ""),
            task_token=metadata.get("task_token", ""),
            backend_url=metadata.get("backend_url", ""),
            workspace=metadata.get("workspace", {}),
            is_subscription=metadata.get("is_subscription", False),
            request_id=metadata.get("request_id", ""),
            executor_name=metadata.get("executor_name"),
        )


class OpenAIEventConverter:
    """Converter for OpenAI Responses API streaming events.

    Maps between OpenAI event types and internal EventType.
    """

    # OpenAI event type to internal EventType mapping
    EVENT_TYPE_MAP = {
        "response.output_text.delta": "chunk",
        "response.completed": "done",
        "response.incomplete": "cancelled",
        "error": "error",
        "response.function_call_arguments.delta": "tool_start",
        "response.function_call_arguments.done": "tool_result",
        "response.reasoning_summary_part.added": "thinking",
    }

    # Lifecycle events that should be skipped
    LIFECYCLE_EVENTS = {
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.output_item.done",
        "response.content_part.added",
        "response.content_part.done",
        "response.output_text.done",
    }

    @classmethod
    def get_internal_event_type(cls, openai_event_type: str) -> Optional[str]:
        """Get internal event type from OpenAI event type.

        Args:
            openai_event_type: OpenAI event type string

        Returns:
            Internal event type string or None if should be skipped
        """
        if openai_event_type in cls.LIFECYCLE_EVENTS:
            return None
        return cls.EVENT_TYPE_MAP.get(openai_event_type)

    @classmethod
    def is_lifecycle_event(cls, openai_event_type: str) -> bool:
        """Check if event is a lifecycle event that should be skipped.

        Args:
            openai_event_type: OpenAI event type string

        Returns:
            True if event should be skipped
        """
        return openai_event_type in cls.LIFECYCLE_EVENTS
