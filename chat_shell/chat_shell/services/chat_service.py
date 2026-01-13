# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service - Main entry point for chat operations.

This service handles:
- Chat message processing with streaming SSE responses
- Resume functionality for reconnection
- Cancellation support
- Integration with LangGraph-based ChatAgent
"""

import asyncio
import logging
from typing import Any, AsyncIterator, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from chat_shell.core.config import settings
from chat_shell.core.database import get_db
from chat_shell.interface import ChatEvent, ChatEventType, ChatInterface, ChatRequest
from chat_shell.services.storage.session import session_manager
from chat_shell.services.streaming.core import (
    StreamingConfig,
    StreamingCore,
    StreamingState,
)
from chat_shell.services.streaming.emitters import SSEEmitter
from chat_shell.tools.events import create_tool_event_handler

logger = logging.getLogger(__name__)


class ChatService(ChatInterface):
    """Chat service implementing the unified ChatInterface.

    This service provides the full chat functionality for Chat Shell,
    including streaming responses, tool execution, and cancellation.
    """

    def __init__(self):
        """Initialize chat service."""
        self._storage = session_manager

    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Process a chat request and stream events.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events during chat processing
        """
        emitter = SSEEmitter()
        state = StreamingState(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            user_id=request.user_id,
            user_name=request.user_name,
            is_group_chat=request.is_group_chat,
            message_id=request.message_id,
            shell_type="Chat",
        )

        core = StreamingCore(
            emitter=emitter,
            state=state,
            config=StreamingConfig(),
            storage_handler=self._storage,
        )

        try:
            # Acquire resources
            logger.debug("[CHAT_SERVICE] Acquiring resources...")
            if not await core.acquire_resources():
                # Emit error event if resources couldn't be acquired
                logger.warning("[CHAT_SERVICE] Failed to acquire resources!")
                async for event in self._emit_pending_events(emitter):
                    yield event
                return

            logger.debug("[CHAT_SERVICE] Resources acquired, emitting start event...")
            # Emit start event
            async for event in self._emit_pending_events(emitter):
                yield event

            # Process chat with the agent
            logger.debug("[CHAT_SERVICE] Starting _process_chat...")
            async for event in self._process_chat(request, core, state, emitter):
                yield event

        except Exception as e:
            logger.exception("[CHAT_SERVICE] Exception in chat(): %s", e)
            await core.handle_error(e)
            async for event in self._emit_pending_events(emitter):
                yield event
        finally:
            logger.debug("[CHAT_SERVICE] Releasing resources...")
            await core.release_resources()

    async def _process_chat(
        self,
        request: ChatRequest,
        core: StreamingCore,
        state: StreamingState,
        emitter: SSEEmitter,
    ) -> AsyncIterator[ChatEvent]:
        """Process chat request with agent streaming."""
        from chat_shell import AgentConfig, create_chat_agent
        from chat_shell.history import get_chat_history
        from chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools
        from chat_shell.tools.mcp.loader import load_mcp_tools
        from chat_shell.tools.skill_factory import (
            prepare_load_skill_tool,
            prepare_skill_tools,
        )

        try:
            logger.debug(
                "[CHAT_SERVICE] Processing chat: task_id=%d, subtask_id=%d",
                request.task_id,
                request.subtask_id,
            )

            # Load chat history (automatically uses remote API in HTTP mode)
            logger.debug(
                "[CHAT_SERVICE] >>> Loading history: task_id=%d, message_id=%s",
                request.task_id,
                request.message_id,
            )
            history = await get_chat_history(
                task_id=request.task_id,
                is_group_chat=request.is_group_chat,
                exclude_after_message_id=request.message_id,
            )
            logger.debug(
                "[CHAT_SERVICE] <<< History loaded: %d messages",
                len(history),
            )

            # Get database session for other operations (tools, skills, etc.)
            async for db in get_db():
                try:
                    # Create the agent (note: web search is handled separately below)
                    agent = create_chat_agent(
                        workspace_root=settings.WORKSPACE_ROOT,
                        enable_skills=settings.ENABLE_SKILLS,
                        enable_web_search=False,  # We'll add it manually if needed
                        enable_checkpointing=settings.ENABLE_CHECKPOINTING,
                    )

                    # Prepare extra tools
                    extra_tools = (
                        list(request.extra_tools) if request.extra_tools else []
                    )

                    # Add web search tool if enabled by request
                    if request.enable_web_search:
                        from chat_shell.tools.builtin import WebSearchTool

                        default_max_results = getattr(
                            settings, "WEB_SEARCH_DEFAULT_MAX_RESULTS", 5
                        )
                        search_engine = request.search_engine
                        extra_tools.append(
                            WebSearchTool(
                                engine_name=search_engine,
                                default_max_results=default_max_results,
                            )
                        )
                        logger.debug(
                            "[CHAT_SERVICE] Added WebSearchTool: engine=%s, max_results=%d",
                            search_engine,
                            default_max_results,
                        )

                    # Prepare knowledge base tools if knowledge_base_ids provided
                    system_prompt = request.system_prompt or ""
                    if request.knowledge_base_ids:
                        # Get context_window from model_config (extracted from Model CRD)
                        context_window = (
                            request.model_config.get("context_window")
                            if request.model_config
                            else None
                        )
                        kb_tools, system_prompt = await prepare_knowledge_base_tools(
                            knowledge_base_ids=request.knowledge_base_ids,
                            user_id=request.user_id,
                            db=db,
                            base_system_prompt=system_prompt,
                            task_id=request.task_id,
                            user_subtask_id=request.subtask_id,
                            document_ids=request.document_ids,
                            context_window=context_window,
                        )
                        extra_tools.extend(kb_tools)

                    # Prepare table tools if table_contexts provided
                    logger.debug(
                        "[CHAT_SERVICE] Checking table_contexts: has_table_contexts=%s, count=%d, content=%s",
                        bool(request.table_contexts),
                        len(request.table_contexts) if request.table_contexts else 0,
                        request.table_contexts,
                    )
                    if request.table_contexts:
                        from chat_shell.tools.builtin import DataTableTool

                        data_table_tool = DataTableTool(
                            table_contexts=request.table_contexts,
                            user_id=request.user_id,
                            user_name=request.user_name,
                            db_session=db,
                        )
                        extra_tools.append(data_table_tool)
                        logger.info(
                            "[CHAT_SERVICE] Added DataTableTool with %d table context(s)",
                            len(request.table_contexts),
                        )

                    # Prepare load_skill_tool if skills are configured
                    load_skill_tool = None
                    if request.skill_names:
                        load_skill_tool = prepare_load_skill_tool(
                            skill_names=request.skill_names,
                            user_id=request.user_id,
                            skill_configs=request.skill_configs,
                        )

                    # Prepare skill tools from skill_configs
                    if request.skill_configs:
                        skill_tools = await prepare_skill_tools(
                            task_id=request.task_id,
                            subtask_id=request.subtask_id,
                            user_id=request.user_id,
                            skill_configs=request.skill_configs,
                            load_skill_tool=load_skill_tool,
                            user_name=request.user_name,
                        )
                        extra_tools.extend(skill_tools)

                    # Load MCP tools - prefer request-provided servers, fallback to settings
                    mcp_client = None
                    mcp_summary = []  # Collect MCP connection summaries
                    if request.mcp_servers:
                        # Use MCP servers from request (HTTP mode)
                        from chat_shell.tools.mcp import MCPClient

                        logger.debug(
                            "[CHAT_SERVICE] Loading %d MCP servers from request for task %d",
                            len(request.mcp_servers),
                            request.task_id,
                        )
                        for server in request.mcp_servers:
                            try:
                                server_name = server.get("name", "server")
                                # Support transport type from server config, default to streamable-http
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
                                    extra_tools.extend(tools)
                                    mcp_summary.append(f"{server_name}({len(tools)})")
                                else:
                                    logger.warning(
                                        "[CHAT_SERVICE] MCP server %s connected but not ready",
                                        server_name,
                                    )
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
                                logger.warning(
                                    "[CHAT_SERVICE] Failed to load MCP server %s: %s",
                                    server.get("name"),
                                    error_msg,
                                )

                        # Log MCP summary
                        if mcp_summary:
                            logger.info(
                                "[CHAT_SERVICE] Connected %d MCP servers: %s",
                                len(mcp_summary),
                                ", ".join(mcp_summary),
                            )
                    else:
                        # No MCP servers in request - chat_shell does NOT auto-load tools
                        # All tools must be explicitly passed by the caller
                        logger.debug(
                            "[CHAT_SERVICE] No MCP servers in request, skipping MCP loading"
                        )

                    # Build agent configuration
                    logger.debug(
                        "[CHAT_SERVICE] Building agent config: extra_tools=%d, enable_web_search=%s",
                        len(extra_tools),
                        request.enable_web_search,
                    )
                    if extra_tools:
                        logger.debug(
                            "[CHAT_SERVICE] Extra tools: %s",
                            [t.name for t in extra_tools],
                        )
                    agent_config = AgentConfig(
                        model_config=request.model_config or {"model": "gpt-4"},
                        system_prompt=system_prompt,
                        max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
                        extra_tools=extra_tools if extra_tools else None,
                        load_skill_tool=load_skill_tool,
                        streaming=True,
                        enable_clarification=request.enable_clarification,
                        enable_deep_thinking=request.enable_deep_thinking,
                        skills=request.skills,
                    )

                    # Build messages for the agent
                    model_id = (
                        request.model_config.get("model")
                        if request.model_config
                        else None
                    )
                    messages = agent.build_messages(
                        history=history,
                        current_message=request.message,
                        system_prompt=system_prompt,
                        username=request.user_name if request.is_group_chat else None,
                        config=agent_config,
                        model_id=model_id,
                    )

                    # Create tool event handler using the agent builder
                    agent_builder = agent.create_agent_builder(agent_config)
                    on_tool_event = create_tool_event_handler(
                        state, emitter, agent_builder
                    )
                    logger.debug(
                        "[CHAT_SERVICE] Created tool event handler, agent_builder=%s",
                        type(agent_builder).__name__,
                    )

                    # Stream tokens from agent
                    async for token in agent.stream(
                        messages=messages,
                        config=agent_config,
                        cancel_event=core.cancel_event,
                        on_tool_event=on_tool_event,
                    ):
                        if core.is_cancelled():
                            break

                        if not await core.process_token(token):
                            break

                        # Yield any pending events
                        async for event in self._emit_pending_events(emitter):
                            yield event

                    # Finalize if not cancelled
                    if not core.is_cancelled():
                        await core.finalize()

                    # Yield remaining events
                    async for event in self._emit_pending_events(emitter):
                        yield event

                    # Cleanup MCP client if used
                    if mcp_client:
                        try:
                            await mcp_client.close()
                        except Exception as e:
                            logger.warning(
                                "[CHAT_SERVICE] Failed to close MCP client: %s", e
                            )

                finally:
                    # Database session is managed by context manager
                    pass

        except Exception as e:
            logger.exception("[CHAT_SERVICE] Error processing chat: %s", e)
            raise

    async def _emit_pending_events(
        self, emitter: SSEEmitter
    ) -> AsyncIterator[ChatEvent]:
        """Convert SSE emitter events to ChatEvents."""
        import json

        events = emitter.get_all_events()
        if events:
            logger.debug(
                "[CHAT_SERVICE] _emit_pending_events: got %d events", len(events)
            )
        for sse_data in events:
            # Parse SSE data line
            if sse_data.startswith("data: "):
                json_str = sse_data[6:].strip()
                if json_str:
                    try:
                        data = json.loads(json_str)
                        event_type = data.pop("type", "chunk")
                        # Log if this event has result.thinking
                        result = data.get("result")
                        yield ChatEvent(
                            type=ChatEventType(event_type),
                            data=data,
                        )
                    except json.JSONDecodeError:
                        continue

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Resume a streaming session from a given offset.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        logger.info(
            "[CHAT_SERVICE] Resuming stream: subtask_id=%d, offset=%d",
            subtask_id,
            offset,
        )

        # Get cached content from Redis
        cached_content = await self._storage.get_streaming_content(subtask_id)

        if cached_content and offset < len(cached_content):
            # Send remaining cached content
            remaining = cached_content[offset:]
            yield ChatEvent(
                type=ChatEventType.CHUNK,
                data={
                    "content": remaining,
                    "offset": offset,
                    "subtask_id": subtask_id,
                },
            )

        # Subscribe to streaming channel for real-time updates
        # This would be implemented with Redis Pub/Sub in the full version

    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        logger.info(
            "[CHAT_SERVICE] Cancelling stream: subtask_id=%d",
            subtask_id,
        )

        return await self._storage.cancel_stream(subtask_id)


# Global chat service instance
chat_service = ChatService()
