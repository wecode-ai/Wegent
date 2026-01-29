# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat response handlers for OpenAPI v1/responses endpoint.
Contains streaming and synchronous response implementations.
"""

import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.schemas.openapi_response import (
    OutputMessage,
    OutputTextContent,
    ResponseCreateInput,
    ResponseObject,
)
from app.services.openapi.chat_session import (
    build_chat_history,
    setup_chat_session,
)

logger = logging.getLogger(__name__)


async def create_streaming_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> StreamingResponse:
    """
    Create a streaming response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.
    Uses HTTP adapter to call remote chat_shell service.

    Note: This method closes the passed-in database session after setup
    to avoid holding connections during long-running LLM calls.

    Args:
        db: Database session (will be closed after setup)
        user: Current user object
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_key_name: Optional API key name

    Returns:
        StreamingResponse with SSE events
    """
    return await _create_streaming_response_http(
        db=db,
        user=user,
        team=team,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
    )


async def _create_streaming_response_http(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> StreamingResponse:
    """Create streaming response using HTTP adapter to call remote chat_shell service.

    This method closes the passed-in database session after setup to avoid holding
    connections during long-running LLM streaming calls.
    """
    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services.chat.adapters.http import HTTPAdapter
    from app.services.chat.adapters.interface import ChatEventType, ChatRequest
    from app.services.chat.storage import db_handler, session_manager
    from app.services.openapi.streaming import streaming_service

    # Extract user and team info for use after db is closed
    user_id = user.id
    user_name = user.user_name
    team_id = team.id
    team_name = team.name
    team_user_id = team.user_id

    try:
        # Set up chat session (config, task, subtasks)
        setup = setup_chat_session(
            db,
            user,
            team,
            model_info,
            input_text,
            tool_settings,
            task_id,
            api_key_name,
        )

        response_id = f"resp_{setup.task_id}"
        created_at = int(datetime.now().timestamp())
        assistant_subtask_id = setup.assistant_subtask.id
        user_subtask_id = (
            setup.user_subtask.id
        )  # User subtask ID for RAG result persistence
        user_message_id = (
            setup.user_subtask.message_id
        )  # User message_id for history exclusion
        task_kind_id = setup.task_id
        enable_chat_bot = tool_settings.get("enable_chat_bot", False)

        # Prepare MCP servers for HTTP mode
        # Only load MCP servers when tools are explicitly enabled via enable_chat_bot
        # This ensures /api/v1/responses without tools parameter doesn't auto-load tools
        mcp_servers_to_pass = []

        # 1. Load bot MCP servers from Ghost CRD
        if setup.bot_name:
            try:
                from app.services.openapi.mcp import _get_bot_mcp_servers_sync

                bot_mcp_servers = _get_bot_mcp_servers_sync(
                    team_user_id, setup.bot_name, setup.bot_namespace
                )
                if bot_mcp_servers:
                    # Convert to chat_shell expected format
                    for name, config in bot_mcp_servers.items():
                        if isinstance(config, dict):
                            server_entry = {
                                "name": name,
                                "url": config.get("url", ""),
                                "type": config.get("type", "streamable-http"),
                            }
                            if config.get("headers"):
                                server_entry["auth"] = config["headers"]
                            mcp_servers_to_pass.append(server_entry)
                    logger.info(
                        f"[OPENAPI_HTTP] Loaded {len(bot_mcp_servers)} bot MCP servers for HTTP mode: "
                        f"bot={setup.bot_namespace}/{setup.bot_name}"
                    )
            except Exception as e:
                logger.warning(f"[OPENAPI_HTTP] Failed to load bot MCP servers: {e}")

        # 2. Add custom MCP servers from API request
        custom_mcp_servers = tool_settings.get("mcp_servers", {})
        if custom_mcp_servers:
            for name, config in custom_mcp_servers.items():
                if isinstance(config, dict) and config.get("url"):
                    server_entry = {
                        "name": name,
                        "url": config.get("url", ""),
                        "type": config.get("type", "streamable-http"),
                    }
                    if config.get("headers"):
                        server_entry["auth"] = config["headers"]
                    mcp_servers_to_pass.append(server_entry)
            logger.info(
                f"[OPENAPI_HTTP] Added {len(custom_mcp_servers)} custom MCP servers from request"
            )

        # Build chat history while db is still open (before close)
        # This converts ORM objects to plain dicts, avoiding DetachedInstanceError
        chat_history = build_chat_history(setup.existing_subtasks)

        # Store setup data needed for streaming
        setup_data = {
            "system_prompt": setup.system_prompt,
            "chat_history": chat_history,  # Pre-built history (plain dicts, not ORM objects)
            "model_config": setup.model_config,
            "bot_name": setup.bot_name,
            "bot_namespace": setup.bot_namespace,
            "skill_names": setup.skill_names,
            "skill_configs": setup.skill_configs,
            "preload_skills": setup.preload_skills,
            "task_project_id": setup.task.project_id,
        }

    finally:
        # IMPORTANT: Close the database session before streaming starts
        # This prevents holding the db connection during long-running LLM calls
        try:
            db.rollback()
        except Exception:
            pass
        db.close()

    async def raw_chat_stream() -> AsyncGenerator[str, None]:
        """Generate raw text chunks from HTTP adapter."""
        accumulated_content = ""

        try:
            cancel_event = await session_manager.register_stream(assistant_subtask_id)
            await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

            # Search for relevant memories (with timeout, graceful degradation)
            # Only search if enable_chat_bot=True (wegent_chat_bot tool is enabled)
            relevant_memories = []
            if enable_chat_bot:
                from app.services.memory import get_memory_manager

                memory_manager = get_memory_manager()
                if memory_manager.is_enabled:
                    try:
                        logger.info(
                            "[OPENAPI_HTTP] Searching for relevant cross-conversation memories: user_id=%d, project_id=%s",
                            user_id,
                            setup_data["task_project_id"] or "None",
                        )
                        relevant_memories = await memory_manager.search_memories(
                            user_id=str(user_id),
                            query=input_text,
                            project_id=(
                                str(setup_data["task_project_id"])
                                if setup_data["task_project_id"]
                                else None
                            ),
                        )
                        logger.info(
                            "[OPENAPI_HTTP] Found %d relevant memories",
                            len(relevant_memories),
                        )
                    except Exception as e:
                        logger.error(
                            "[OPENAPI_HTTP] Failed to search memories: %s",
                            e,
                            exc_info=True,
                        )

            # Inject memories into system prompt if any found
            base_system_prompt = setup_data["system_prompt"]
            if relevant_memories:
                from app.services.memory import get_memory_manager

                memory_manager = get_memory_manager()
                base_system_prompt = memory_manager.inject_memories_to_prompt(
                    base_prompt=setup_data["system_prompt"], memories=relevant_memories
                )
                logger.info(
                    "[OPENAPI_HTTP] Injected %d memories into system prompt",
                    len(relevant_memories),
                )

            # Build system prompt with optional deep thinking enhancement
            from chat_shell.prompts import append_deep_thinking_prompt

            final_system_prompt = append_deep_thinking_prompt(
                base_system_prompt, enable_chat_bot
            )

            # Use pre-built chat history (already converted to dicts before db.close())
            history = setup_data["chat_history"]

            # Create HTTP adapter
            adapter = HTTPAdapter(
                base_url=settings.CHAT_SHELL_URL,
                token=settings.CHAT_SHELL_TOKEN,
            )

            # Build ChatRequest
            chat_request = ChatRequest(
                task_id=task_kind_id,
                subtask_id=assistant_subtask_id,
                user_subtask_id=user_subtask_id,  # For RAG result persistence
                user_message_id=user_message_id,  # For history exclusion (prevent duplicate messages)
                message=input_text,
                user_id=user_id,
                user_name=user_name or "",
                team_id=team_id,
                team_name=team_name,
                model_config=setup_data["model_config"],
                system_prompt=final_system_prompt,
                history=history,
                enable_deep_thinking=enable_chat_bot,
                enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
                bot_name=setup_data["bot_name"],
                bot_namespace=setup_data["bot_namespace"],
                mcp_servers=mcp_servers_to_pass,
                skill_names=setup_data["skill_names"],
                skill_configs=setup_data["skill_configs"],
                preload_skills=setup_data["preload_skills"],
            )

            # Stream from HTTP adapter
            async for event in adapter.chat(chat_request):
                if cancel_event.is_set() or await session_manager.is_cancelled(
                    assistant_subtask_id
                ):
                    logger.info(f"Stream cancelled for subtask {assistant_subtask_id}")
                    break

                if event.type == ChatEventType.CHUNK:
                    content = event.data.get("content", "")
                    if content:
                        accumulated_content += content
                        yield content
                elif event.type == ChatEventType.ERROR:
                    error_msg = event.data.get("error", "Unknown error")
                    logger.error(f"[OPENAPI_HTTP] Error from chat_shell: {error_msg}")
                    raise Exception(error_msg)
                elif event.type == ChatEventType.DONE:
                    logger.info(
                        f"[OPENAPI_HTTP] Stream completed for subtask {assistant_subtask_id}"
                    )

            # Stream completed (not cancelled)
            if not cancel_event.is_set() and not await session_manager.is_cancelled(
                assistant_subtask_id
            ):
                result = {"value": accumulated_content}
                await session_manager.save_streaming_content(
                    assistant_subtask_id, accumulated_content
                )
                await session_manager.append_user_and_assistant_messages(
                    task_kind_id, input_text, accumulated_content
                )
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "COMPLETED", result=result
                )

                # Update task status - create session only when needed
                stream_db = SessionLocal()
                try:
                    task_resource = (
                        stream_db.query(TaskResource)
                        .filter(TaskResource.id == task_kind_id)
                        .first()
                    )
                    if task_resource:
                        task_crd = Task.model_validate(task_resource.json)
                        if task_crd.status:
                            task_crd.status.status = "COMPLETED"
                            task_crd.status.updatedAt = datetime.now()
                            task_crd.status.completedAt = datetime.now()
                            task_resource.json = task_crd.model_dump(mode="json")
                            from sqlalchemy.orm.attributes import flag_modified

                            flag_modified(task_resource, "json")
                            stream_db.commit()
                finally:
                    stream_db.close()

        except Exception as e:
            logger.exception(f"Error in HTTP streaming: {e}")
            try:
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "FAILED", error=str(e)
                )
            except Exception:
                pass
            raise
        finally:
            await session_manager.unregister_stream(assistant_subtask_id)
            await session_manager.delete_streaming_content(assistant_subtask_id)

    async def generate():
        async for event in streaming_service.create_streaming_response(
            response_id=response_id,
            model_string=request_body.model,
            chat_stream=raw_chat_stream(),
            created_at=created_at,
            previous_response_id=request_body.previous_response_id,
        ):
            yield event

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def create_sync_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> ResponseObject:
    """
    Create a synchronous (blocking) response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.
    Uses HTTP adapter to call remote chat_shell service.

    Note: This method closes the passed-in database session after setup
    to avoid holding connections during long-running LLM calls.

    Args:
        db: Database session (will be closed after setup)
        user: Current user object
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_key_name: Optional API key name

    Returns:
        ResponseObject with completed status and output
    """
    return await _create_sync_response_http(
        db=db,
        user=user,
        team=team,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
    )


async def _create_sync_response_http(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> ResponseObject:
    """Create sync response using HTTP adapter to call remote chat_shell service.

    This method closes the passed-in database session after setup to avoid holding
    connections during long-running LLM calls.
    """
    from sqlalchemy.orm.attributes import flag_modified

    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services.chat.adapters.http import HTTPAdapter
    from app.services.chat.adapters.interface import ChatEventType, ChatRequest
    from app.services.chat.storage import db_handler, session_manager

    # Extract user and team info for use after db is closed
    user_id = user.id
    user_name = user.user_name
    team_id = team.id
    team_name = team.name
    team_user_id = team.user_id

    try:
        # Set up chat session (config, task, subtasks)
        setup = setup_chat_session(
            db,
            user,
            team,
            model_info,
            input_text,
            tool_settings,
            task_id,
            api_key_name,
        )

        response_id = f"resp_{setup.task_id}"
        created_at = int(datetime.now().timestamp())
        assistant_subtask_id = setup.assistant_subtask.id
        user_subtask_id = (
            setup.user_subtask.id
        )  # User subtask ID for RAG result persistence
        user_message_id = (
            setup.user_subtask.message_id
        )  # User message_id for history exclusion
        task_kind_id = setup.task_id
        enable_chat_bot = tool_settings.get("enable_chat_bot", False)

        # Prepare MCP servers for HTTP mode
        # Only load MCP servers when tools are explicitly enabled via enable_chat_bot
        # This ensures /api/v1/responses without tools parameter doesn't auto-load tools
        mcp_servers_to_pass = []

        # 1. Load bot MCP servers from Ghost CRD
        if setup.bot_name:
            try:
                from app.services.openapi.mcp import _get_bot_mcp_servers_sync

                bot_mcp_servers = _get_bot_mcp_servers_sync(
                    team_user_id, setup.bot_name, setup.bot_namespace
                )
                if bot_mcp_servers:
                    # Convert to chat_shell expected format
                    for name, config in bot_mcp_servers.items():
                        if isinstance(config, dict):
                            server_entry = {
                                "name": name,
                                "url": config.get("url", ""),
                                "type": config.get("type", "streamable-http"),
                            }
                            if config.get("headers"):
                                server_entry["auth"] = config["headers"]
                            mcp_servers_to_pass.append(server_entry)
                    logger.info(
                        f"[OPENAPI_HTTP_SYNC] Loaded {len(bot_mcp_servers)} bot MCP servers for HTTP mode: "
                        f"bot={setup.bot_namespace}/{setup.bot_name}"
                    )
            except Exception as e:
                logger.warning(
                    f"[OPENAPI_HTTP_SYNC] Failed to load bot MCP servers: {e}"
                )

        # 2. Add custom MCP servers from API request
        custom_mcp_servers = tool_settings.get("mcp_servers", {})
        if custom_mcp_servers:
            for name, config in custom_mcp_servers.items():
                if isinstance(config, dict) and config.get("url"):
                    server_entry = {
                        "name": name,
                        "url": config.get("url", ""),
                        "type": config.get("type", "streamable-http"),
                    }
                    if config.get("headers"):
                        server_entry["auth"] = config["headers"]
                    mcp_servers_to_pass.append(server_entry)
            logger.info(
                f"[OPENAPI_HTTP_SYNC] Added {len(custom_mcp_servers)} custom MCP servers from request"
            )

        # Build chat history while db is still open (before close)
        # This converts ORM objects to plain dicts, avoiding DetachedInstanceError
        chat_history = build_chat_history(setup.existing_subtasks)

        # Store setup data needed for LLM call
        setup_data = {
            "system_prompt": setup.system_prompt,
            "chat_history": chat_history,  # Pre-built history (plain dicts, not ORM objects)
            "model_config": setup.model_config,
            "bot_name": setup.bot_name,
            "bot_namespace": setup.bot_namespace,
            "skill_names": setup.skill_names,
            "skill_configs": setup.skill_configs,
            "preload_skills": setup.preload_skills,
            "task_project_id": setup.task.project_id,
        }

    finally:
        # IMPORTANT: Close the database session before LLM call starts
        # This prevents holding the db connection during long-running LLM calls
        try:
            db.rollback()
        except Exception:
            pass
        db.close()

    # Update subtask status to RUNNING
    await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

    accumulated_content = ""

    try:
        # Search for relevant memories (with timeout, graceful degradation)
        # Only search if enable_chat_bot=True (wegent_chat_bot tool is enabled)
        relevant_memories = []
        if enable_chat_bot:
            from app.services.memory import get_memory_manager

            memory_manager = get_memory_manager()
            if memory_manager.is_enabled:
                try:
                    logger.info(
                        "[OPENAPI_HTTP_SYNC] Searching for relevant cross-conversation memories: user_id=%d, project_id=%s",
                        user_id,
                        setup_data["task_project_id"] or "None",
                    )
                    relevant_memories = await memory_manager.search_memories(
                        user_id=str(user_id),
                        query=input_text,
                        project_id=(
                            str(setup_data["task_project_id"])
                            if setup_data["task_project_id"]
                            else None
                        ),
                    )
                    logger.info(
                        "[OPENAPI_HTTP_SYNC] Found %d relevant memories",
                        len(relevant_memories),
                    )
                except Exception as e:
                    logger.error(
                        "[OPENAPI_HTTP_SYNC] Failed to search memories: %s",
                        e,
                        exc_info=True,
                    )

        # Inject memories into system prompt if any found
        base_system_prompt = setup_data["system_prompt"]
        if relevant_memories:
            from app.services.memory import get_memory_manager

            memory_manager = get_memory_manager()
            base_system_prompt = memory_manager.inject_memories_to_prompt(
                base_prompt=setup_data["system_prompt"], memories=relevant_memories
            )
            logger.info(
                "[OPENAPI_HTTP_SYNC] Injected %d memories into system prompt",
                len(relevant_memories),
            )

        # Build system prompt with optional deep thinking enhancement
        from chat_shell.prompts import append_deep_thinking_prompt

        final_system_prompt = append_deep_thinking_prompt(
            base_system_prompt, enable_chat_bot
        )

        # Use pre-built chat history (already converted to dicts before db.close())
        history = setup_data["chat_history"]

        # Create HTTP adapter
        adapter = HTTPAdapter(
            base_url=settings.CHAT_SHELL_URL,
            token=settings.CHAT_SHELL_TOKEN,
        )

        # Build ChatRequest
        chat_request = ChatRequest(
            task_id=task_kind_id,
            subtask_id=assistant_subtask_id,
            user_subtask_id=user_subtask_id,  # For RAG result persistence
            user_message_id=user_message_id,  # For history exclusion (prevent duplicate messages)
            message=input_text,
            user_id=user_id,
            user_name=user_name or "",
            team_id=team_id,
            team_name=team_name,
            model_config=setup_data["model_config"],
            system_prompt=final_system_prompt,
            history=history,
            enable_deep_thinking=enable_chat_bot,
            enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
            bot_name=setup_data["bot_name"],
            bot_namespace=setup_data["bot_namespace"],
            mcp_servers=mcp_servers_to_pass,
            skill_names=setup_data["skill_names"],
            skill_configs=setup_data["skill_configs"],
            preload_skills=setup_data["preload_skills"],
        )

        # Stream from HTTP adapter and accumulate
        async for event in adapter.chat(chat_request):
            if event.type == ChatEventType.CHUNK:
                content = event.data.get("content", "")
                if content:
                    accumulated_content += content
            elif event.type == ChatEventType.ERROR:
                error_msg = event.data.get("error", "Unknown error")
                logger.error(f"[OPENAPI_HTTP_SYNC] Error from chat_shell: {error_msg}")
                raise Exception(error_msg)
            elif event.type == ChatEventType.DONE:
                logger.info(
                    f"[OPENAPI_HTTP_SYNC] Stream completed for subtask {assistant_subtask_id}"
                )

        # Update subtask to completed
        result = {"value": accumulated_content}
        await db_handler.update_subtask_status(
            assistant_subtask_id, "COMPLETED", result=result
        )

        # Save chat history
        await session_manager.append_user_and_assistant_messages(
            task_kind_id, input_text, accumulated_content
        )

        # Update task status using a new database session
        update_db = SessionLocal()
        try:
            task_resource = (
                update_db.query(TaskResource)
                .filter(TaskResource.id == task_kind_id)
                .first()
            )
            if task_resource:
                task_crd = Task.model_validate(task_resource.json)
                if task_crd.status:
                    task_crd.status.status = "COMPLETED"
                    task_crd.status.updatedAt = datetime.now()
                    task_crd.status.completedAt = datetime.now()
                    task_crd.status.result = result
                    task_resource.json = task_crd.model_dump(mode="json")
                    task_resource.updated_at = datetime.now()
                    flag_modified(task_resource, "json")
                    update_db.commit()
        finally:
            update_db.close()

    except Exception as e:
        logger.exception(f"Error in HTTP sync chat response: {e}")
        error_message = str(e)
        await db_handler.update_subtask_status(
            assistant_subtask_id, "FAILED", error=error_message
        )

        # Update task status to FAILED using a new database session
        error_db = SessionLocal()
        try:
            task_resource = (
                error_db.query(TaskResource)
                .filter(TaskResource.id == task_kind_id)
                .first()
            )
            if task_resource:
                task_crd = Task.model_validate(task_resource.json)
                if task_crd.status:
                    task_crd.status.status = "FAILED"
                    task_crd.status.errorMessage = error_message
                    task_crd.status.updatedAt = datetime.now()
                    task_resource.json = task_crd.model_dump(mode="json")
                    task_resource.updated_at = datetime.now()
                    flag_modified(task_resource, "json")
                    error_db.commit()
        finally:
            error_db.close()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {error_message}",
        )

    # Build response
    message_id = f"msg_{assistant_subtask_id}"

    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status="completed",
        model=request_body.model,
        output=[
            OutputMessage(
                id=message_id,
                status="completed",
                role="assistant",
                content=[OutputTextContent(text=accumulated_content)],
            )
        ],
        previous_response_id=request_body.previous_response_id,
    )
