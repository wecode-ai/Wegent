# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Context - Manages chat context preparation and cleanup.

This module provides the ChatContext class that handles:
- Parallel loading of chat history, tools, and MCP connections
- Resource lifecycle management (preparation and cleanup)
- Tool aggregation from various sources (builtin, KB, skills, MCP, etc.)

Note: Agent creation is NOT handled here - it belongs to the service layer.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from shared.telemetry.decorators import add_span_event, trace_async
from sqlalchemy.ext.asyncio import AsyncSession

from chat_shell.core.config import settings
from chat_shell.core.database import get_db_context
from chat_shell.interface import ChatRequest

logger = logging.getLogger(__name__)


@dataclass
class ChatContextResult:
    """Result of chat context preparation.

    Attributes:
        history: Chat history messages
        extra_tools: All tools including builtin tools (LoadSkillTool, WebSearchTool, etc.)
        system_prompt: System prompt (may be updated by KB tools)
        mcp_clients: MCP clients for cleanup
    """

    history: list = field(default_factory=list)
    extra_tools: list = field(default_factory=list)
    system_prompt: str = ""
    mcp_clients: list = field(default_factory=list)


class ChatContext:
    """Manages chat context preparation and cleanup.

    This class handles the lifecycle of chat resources:
    - Parallel initialization of history and tools
    - MCP server connections
    - Resource cleanup after chat completion

    Note: Agent creation is NOT handled here - it belongs to the service layer.

    Performance optimizations:
    - All independent async operations run in parallel using asyncio.gather
    - History loading, KB tools, skill tools, and MCP connections
      all execute concurrently
    """

    def __init__(self, request: ChatRequest):
        """Initialize chat context.

        Args:
            request: The chat request containing all configuration
        """
        self._request = request
        self._mcp_clients: list = []
        self._db_session: AsyncSession | None = None
        self._load_skill_tool: Any = None

    @trace_async(
        span_name="chat_context.prepare",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, *args, **kwargs: {
            "context.task_id": self._request.task_id,
            "context.subtask_id": self._request.subtask_id,
            "context.user_id": self._request.user_id,
            "context.has_skill_names": bool(self._request.skill_names),
            "context.has_kb_ids": bool(self._request.knowledge_base_ids),
            "context.has_mcp_servers": bool(self._request.mcp_servers),
        },
    )
    async def prepare(self) -> ChatContextResult:
        """Prepare all chat context resources in parallel.

        Returns:
            ChatContextResult containing all prepared resources
        """
        from chat_shell.tools.skill_factory import prepare_load_skill_tool

        add_span_event("context_prepare_started", {"task_id": self._request.task_id})

        logger.debug(
            "[CHAT_CONTEXT] Preparing context: task_id=%d, subtask_id=%d",
            self._request.task_id,
            self._request.subtask_id,
        )

        # Prepare load_skill_tool synchronously (fast, needed by skill_tools task)
        # This is a builtin tool that will be added to extra_tools
        if self._request.skill_names:
            add_span_event(
                "preparing_load_skill_tool",
                {"skill_count": len(self._request.skill_names)},
            )
            self._load_skill_tool = prepare_load_skill_tool(
                skill_names=self._request.skill_names,
                user_id=self._request.user_id,
                skill_configs=self._request.skill_configs,
            )

        # Use context manager for database session
        async with get_db_context() as db:
            self._db_session = db
            add_span_event("db_session_acquired")
            logger.debug(
                "[CHAT_CONTEXT] >>> Starting parallel initialization tasks",
            )

            # Execute all independent tasks in parallel
            # Note: Agent creation is NOT done here - it belongs to the service layer
            add_span_event("parallel_tasks_started")
            (
                history,
                kb_result,
                skill_tools,
                mcp_result,
            ) = await asyncio.gather(
                self._load_chat_history(),
                self._prepare_kb_tools(db),
                self._prepare_skill_tools(self._load_skill_tool),
                self._connect_mcp_servers(),
            )

            add_span_event(
                "parallel_tasks_completed",
                {
                    "history_count": len(history),
                    "kb_tools_count": len(kb_result[0]) if kb_result else 0,
                    "skill_tools_count": len(skill_tools),
                    "mcp_tools_count": len(mcp_result[0]) if mcp_result else 0,
                },
            )
            logger.debug(
                "[CHAT_CONTEXT] <<< Parallel tasks complete: history=%d messages",
                len(history),
            )

            # Build extra_tools from all sources (including builtin tools)
            add_span_event("building_extra_tools")
            extra_tools = self._build_extra_tools(kb_result, skill_tools, mcp_result)

            # Process KB tools result for system prompt
            system_prompt = self._request.system_prompt or ""
            kb_tools, updated_system_prompt = kb_result
            if kb_tools:
                system_prompt = updated_system_prompt

            # Track MCP clients for cleanup
            _, mcp_clients = mcp_result
            self._mcp_clients = mcp_clients

            add_span_event(
                "context_prepare_completed",
                {
                    "total_extra_tools": len(extra_tools),
                    "mcp_clients_count": len(mcp_clients),
                },
            )

            return ChatContextResult(
                history=history,
                extra_tools=extra_tools,
                system_prompt=system_prompt,
                mcp_clients=mcp_clients,
            )

    @trace_async(
        span_name="chat_context.cleanup",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, *args, **kwargs: {
            "context.mcp_clients_count": len(self._mcp_clients),
        },
    )
    async def cleanup(self) -> None:
        """Clean up all chat context resources.

        This method should be called after chat completion to release resources.
        """
        add_span_event("cleanup_started", {"mcp_clients_count": len(self._mcp_clients)})
        if self._mcp_clients:
            logger.debug(
                "[CHAT_CONTEXT] Cleaning up %d MCP clients", len(self._mcp_clients)
            )
            await asyncio.gather(
                *[self._close_mcp_client(c) for c in self._mcp_clients if c],
                return_exceptions=True,
            )
            self._mcp_clients = []
        add_span_event("cleanup_completed")

    @trace_async(
        span_name="chat_context.load_chat_history",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, *args, **kwargs: {
            "context.task_id": self._request.task_id,
            "context.is_group_chat": self._request.is_group_chat,
        },
    )
    async def _load_chat_history(self) -> list:
        """Load chat history asynchronously."""
        from chat_shell.history import get_chat_history

        # Use user_message_id to exclude current user message (and all messages after it)
        # Fall back to message_id if user_message_id is not provided
        exclude_message_id = self._request.user_message_id or self._request.message_id

        add_span_event("loading_chat_history")
        logger.debug(
            "[CHAT_CONTEXT] >>> Loading history: task_id=%d, exclude_message_id=%s (user_message_id=%s, message_id=%s)",
            self._request.task_id,
            exclude_message_id,
            self._request.user_message_id,
            self._request.message_id,
        )
        history = await get_chat_history(
            task_id=self._request.task_id,
            is_group_chat=self._request.is_group_chat,
            exclude_after_message_id=exclude_message_id,
        )
        add_span_event("chat_history_loaded", {"message_count": len(history)})
        return history

    @trace_async(
        span_name="chat_context.prepare_kb_tools",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, db, *args, **kwargs: {
            "context.kb_ids_count": len(self._request.knowledge_base_ids or []),
        },
    )
    async def _prepare_kb_tools(self, db: AsyncSession) -> tuple[list, str]:
        """Prepare knowledge base tools asynchronously."""
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        base_system_prompt = self._request.system_prompt or ""
        if not self._request.knowledge_base_ids:
            add_span_event("no_kb_ids_skipped")
            return [], base_system_prompt

        add_span_event(
            "preparing_kb_tools",
            {"kb_ids_count": len(self._request.knowledge_base_ids)},
        )
        context_window = (
            self._request.model_config.get("context_window")
            if self._request.model_config
            else None
        )
        result = await prepare_knowledge_base_tools(
            knowledge_base_ids=self._request.knowledge_base_ids,
            user_id=self._request.user_id,
            db=db,
            base_system_prompt=base_system_prompt,
            task_id=self._request.task_id,
            user_subtask_id=self._request.user_subtask_id,  # Use user_subtask_id for RAG persistence
            is_user_selected=self._request.is_user_selected_kb,
            document_ids=self._request.document_ids,
            context_window=context_window,
        )
        add_span_event("kb_tools_prepared", {"tools_count": len(result[0])})
        return result

    @trace_async(
        span_name="chat_context.prepare_skill_tools",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, load_skill_tool, *args, **kwargs: {
            "context.skill_configs_count": len(self._request.skill_configs or []),
            "context.has_load_skill_tool": load_skill_tool is not None,
        },
    )
    async def _prepare_skill_tools(self, load_skill_tool) -> list:
        """Prepare skill tools asynchronously.

        This method also handles preloading skill prompts for skills
        specified in request.preload_skills.
        """
        from chat_shell.tools.skill_factory import prepare_skill_tools

        if not self._request.skill_configs:
            add_span_event("no_skill_configs_skipped")
            return []

        add_span_event(
            "preparing_skill_tools",
            {"skill_configs_count": len(self._request.skill_configs)},
        )
        tools = await prepare_skill_tools(
            task_id=self._request.task_id,
            subtask_id=self._request.subtask_id,
            user_id=self._request.user_id,
            skill_configs=self._request.skill_configs,
            load_skill_tool=load_skill_tool,
            preload_skills=self._request.preload_skills,
            user_name=self._request.user_name,
        )
        add_span_event("skill_tools_prepared", {"tools_count": len(tools)})
        return tools

    @trace_async(
        span_name="chat_context.connect_single_mcp_server",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, server, *args, **kwargs: {
            "mcp.server_name": server.get("name", "server"),
            "mcp.transport_type": server.get("type", "streamable-http"),
        },
    )
    async def _connect_single_mcp_server(self, server: dict) -> dict:
        """Connect to a single MCP server."""
        from chat_shell.tools.mcp import MCPClient

        server_name = server.get("name", "server")
        add_span_event("connecting_mcp_server", {"server_name": server_name})
        try:
            transport_type = server.get("type", "streamable-http")
            server_url = server.get("url", "")
            server_config = {
                server_name: {
                    "type": transport_type,
                    "url": server_url,
                }
            }
            auth = server.get("auth")
            if auth:
                server_config[server_name]["headers"] = auth

            client = MCPClient(server_config)
            await client.connect()
            if client.is_connected:
                tools = client.get_tools()
                add_span_event(
                    "mcp_server_connected",
                    {"server_name": server_name, "tools_count": len(tools)},
                )
                return {
                    "success": True,
                    "tools": tools,
                    "client": client,
                    "summary": f"{server_name}({len(tools)})",
                }
            else:
                add_span_event("mcp_server_not_ready", {"server_name": server_name})
                logger.warning(
                    "[CHAT_CONTEXT] MCP server %s connected but not ready",
                    server_name,
                )
                return {"success": False, "client": client}
        except Exception as e:
            error_msg = str(e)
            if hasattr(e, "exceptions"):
                for exc in e.exceptions:
                    if hasattr(exc, "exceptions"):
                        for sub_exc in exc.exceptions:
                            error_msg = str(sub_exc)
                            break
                    else:
                        error_msg = str(exc)
                    break
            add_span_event(
                "mcp_server_connection_failed",
                {"server_name": server_name, "error": error_msg},
            )
            logger.warning(
                "[CHAT_CONTEXT] Failed to load MCP server %s: %s",
                server_name,
                error_msg,
            )
            return {"success": False, "client": None}

    @trace_async(
        span_name="chat_context.connect_mcp_servers",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, *args, **kwargs: {
            "context.mcp_servers_count": len(self._request.mcp_servers or []),
        },
    )
    async def _connect_mcp_servers(self) -> tuple[list, list]:
        """Connect to all MCP servers using a single MultiServerMCPClient.

        This approach leverages the SDK's internal parallelization via asyncio.gather
        for optimal performance.
        """
        from chat_shell.tools.mcp import MCPClient

        if not self._request.mcp_servers:
            add_span_event("no_mcp_servers_skipped")
            return [], []

        add_span_event(
            "connecting_mcp_servers",
            {"servers_count": len(self._request.mcp_servers)},
        )
        logger.debug(
            "[CHAT_CONTEXT] Loading %d MCP servers from request for task %d",
            len(self._request.mcp_servers),
            self._request.task_id,
        )

        # Build unified config for all MCP servers
        add_span_event("building_unified_mcp_config")
        unified_config: dict = {}
        for server in self._request.mcp_servers:
            server_name = server.get("name", "server")
            transport_type = server.get("type", "streamable-http")
            server_url = server.get("url", "")
            unified_config[server_name] = {
                "type": transport_type,
                "url": server_url,
            }
            auth = server.get("auth")
            if auth:
                unified_config[server_name]["headers"] = auth

        add_span_event(
            "unified_config_built",
            {"server_names": list(unified_config.keys())},
        )

        # Use single MCPClient with all servers - SDK handles parallel internally
        mcp_tools = []
        mcp_clients = []
        mcp_summary = []

        try:
            client = MCPClient(unified_config)
            add_span_event("mcp_client_created")

            await client.connect()

            if client.is_connected:
                tools = client.get_tools()
                mcp_tools.extend(tools)
                mcp_clients.append(client)
                mcp_summary = [f"{name}(*)" for name in unified_config.keys()]
                add_span_event(
                    "mcp_servers_connected",
                    {
                        "connected_count": len(unified_config),
                        "total_tools": len(tools),
                    },
                )
            else:
                add_span_event("mcp_client_not_ready")
                logger.warning(
                    "[CHAT_CONTEXT] MCP client connected but not ready",
                )
                mcp_clients.append(client)
        except Exception as e:
            error_msg = str(e)
            if hasattr(e, "exceptions"):
                for exc in e.exceptions:
                    if hasattr(exc, "exceptions"):
                        for sub_exc in exc.exceptions:
                            error_msg = str(sub_exc)
                            break
                    else:
                        error_msg = str(exc)
                    break
            add_span_event(
                "mcp_connection_failed",
                {"error": error_msg},
            )
            logger.warning(
                "[CHAT_CONTEXT] Failed to load MCP servers: %s",
                error_msg,
            )

        if mcp_summary:
            logger.info(
                "[CHAT_CONTEXT] Connected %d MCP servers: %s (total %d tools)",
                len(mcp_summary),
                ", ".join(mcp_summary),
                len(mcp_tools),
            )

        return mcp_tools, mcp_clients

    async def _close_mcp_client(self, client) -> None:
        """Close a single MCP client safely."""
        try:
            await client.disconnect()
        except Exception as e:
            logger.warning("[CHAT_CONTEXT] Failed to close MCP client: %s", e)

    def _build_extra_tools(
        self,
        kb_result: tuple[list, str],
        skill_tools: list,
        mcp_result: tuple[list, list],
    ) -> list:
        """Build the complete list of extra tools from all sources.

        This includes builtin tools (LoadSkillTool, WebSearchTool, DataTableTool),
        KB tools, skill tools, and MCP tools.

        Args:
            kb_result: Tuple of (kb_tools, updated_system_prompt)
            skill_tools: List of skill tools
            mcp_result: Tuple of (mcp_tools, mcp_clients)

        Returns:
            Complete list of extra tools
        """
        extra_tools = (
            list(self._request.extra_tools) if self._request.extra_tools else []
        )

        # === Builtin Tools ===

        # Add LoadSkillTool if available (builtin tool for on-demand skill loading)
        if self._load_skill_tool:
            extra_tools.append(self._load_skill_tool)
            logger.debug(
                "[CHAT_CONTEXT] Added LoadSkillTool with %d skills",
                len(self._request.skill_names or []),
            )

        # Add WebSearchTool if enabled
        if self._request.enable_web_search:
            from chat_shell.tools.builtin import WebSearchTool

            default_max_results = getattr(settings, "WEB_SEARCH_DEFAULT_MAX_RESULTS", 5)
            search_engine = self._request.search_engine
            extra_tools.append(
                WebSearchTool(
                    engine_name=search_engine,
                    default_max_results=default_max_results,
                )
            )
            logger.debug(
                "[CHAT_CONTEXT] Added WebSearchTool: engine=%s, max_results=%d",
                search_engine,
                default_max_results,
            )

        # Add DataTableTool if table_contexts provided
        logger.debug(
            "[CHAT_CONTEXT] Checking table_contexts: has_table_contexts=%s, count=%d",
            bool(self._request.table_contexts),
            len(self._request.table_contexts) if self._request.table_contexts else 0,
        )
        if self._request.table_contexts:
            from chat_shell.tools.builtin import DataTableTool

            data_table_tool = DataTableTool(
                table_contexts=self._request.table_contexts,
                user_id=self._request.user_id,
                user_name=self._request.user_name,
            )
            extra_tools.append(data_table_tool)
            logger.info(
                "[CHAT_CONTEXT] Added DataTableTool with %d table context(s)",
                len(self._request.table_contexts),
            )

        # === External Tools ===

        # Add KB tools
        kb_tools, _ = kb_result
        if kb_tools:
            extra_tools.extend(kb_tools)

        # Add skill tools (dynamically created from skill configs)
        if skill_tools:
            extra_tools.extend(skill_tools)

        # Add MCP tools
        mcp_tools, _ = mcp_result
        if mcp_tools:
            extra_tools.extend(mcp_tools)

        return extra_tools
