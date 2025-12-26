# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, NamedTuple, Optional, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Task, Team
from app.schemas.openapi_response import (
    InputItem,
    OutputMessage,
    OutputTextContent,
    ResponseCreateInput,
    ResponseDeletedObject,
    ResponseError,
    ResponseObject,
    WegentTool,
)
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.adapters.team_kinds import team_kinds_service

logger = logging.getLogger(__name__)

router = APIRouter()


def _wegent_status_to_openai_status(wegent_status: str) -> str:
    """Convert Wegent task status to OpenAI response status."""
    status_mapping = {
        "PENDING": "queued",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "failed",
        "CANCELLED": "cancelled",
        "CANCELLING": "in_progress",
        "DELETE": "failed",
    }
    return status_mapping.get(wegent_status, "incomplete")


def _subtask_status_to_message_status(subtask_status: str) -> str:
    """Convert subtask status to output message status."""
    status_mapping = {
        "PENDING": "in_progress",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "incomplete",
        "CANCELLED": "incomplete",
    }
    return status_mapping.get(subtask_status, "incomplete")


def _parse_model_string(model: str) -> Dict[str, Any]:
    """
    Parse model string to extract team namespace, team name, and optional model id.
    Format: namespace#team_name or namespace#team_name#model_id
    """
    parts = model.split("#")
    if len(parts) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model format: '{model}'. Expected format: 'namespace#team_name' or 'namespace#team_name#model_id'",
        )

    result = {
        "namespace": parts[0],
        "team_name": parts[1],
        "model_id": parts[2] if len(parts) > 2 else None,
    }
    return result


def _task_to_response_object(
    task_dict: Dict[str, Any],
    model_string: str,
    subtasks: list = None,
    previous_response_id: str = None,
) -> ResponseObject:
    """Convert task dictionary to ResponseObject."""
    task_id = task_dict.get("id")
    wegent_status = task_dict.get("status", "PENDING")
    created_at = task_dict.get("created_at")

    # Convert datetime to unix timestamp
    if isinstance(created_at, datetime):
        created_at_unix = int(created_at.timestamp())
    else:
        created_at_unix = int(datetime.now().timestamp())

    # Build output from subtasks
    output = []
    if subtasks:
        for subtask in subtasks:
            if subtask.role == SubtaskRole.USER:
                msg = OutputMessage(
                    id=f"msg_{subtask.id}",
                    status=_subtask_status_to_message_status(subtask.status.value),
                    content=[OutputTextContent(text=subtask.prompt)],
                    role="user",
                )
                output.append(msg)

            if subtask.role == SubtaskRole.ASSISTANT:
                result_text = ""
                if isinstance(subtask.result, dict):
                    result_text = subtask.result.get("value", str(subtask.result))
                elif isinstance(subtask.result, str):
                    result_text = subtask.result

                msg = OutputMessage(
                    id=f"msg_{subtask.id}",
                    status=_subtask_status_to_message_status(subtask.status.value),
                    content=[OutputTextContent(text=result_text)],
                    role="assistant",
                )
                output.append(msg)

    # Build error if failed
    error = None
    error_message = task_dict.get("error_message")
    if wegent_status == "FAILED" and error_message:
        error = ResponseError(code="task_failed", message=error_message)

    return ResponseObject(
        id=f"resp_{task_id}",
        created_at=created_at_unix,
        status=_wegent_status_to_openai_status(wegent_status),
        error=error,
        model=model_string,
        output=output,
        previous_response_id=previous_response_id,
    )


def _parse_wegent_tools(tools: Optional[List[WegentTool]]) -> Dict[str, Any]:
    """
    Parse Wegent custom tools from request.

    Args:
        tools: List of WegentTool objects

    Returns:
        Dict with parsed tool settings:
        - enable_deep_thinking: bool (also enables web search if WEB_SEARCH_ENABLED)
    """
    result = {
        "enable_deep_thinking": False,
    }
    if tools:
        for tool in tools:
            if tool.type == "wegent_deep_thinking":
                result["enable_deep_thinking"] = True
    return result


def _extract_input_text(input_data: Union[str, List[InputItem]]) -> str:
    """
    Extract the user input text from the input field.

    Args:
        input_data: Either a string or list of InputItem

    Returns:
        The user's input text
    """
    if isinstance(input_data, str):
        return input_data

    # For list input, get the last user message
    for item in reversed(input_data):
        if isinstance(item, InputItem) and item.role == "user":
            # content can be str or List[InputTextContent]
            if isinstance(item.content, str):
                return item.content
            elif isinstance(item.content, list):
                # Extract text from InputTextContent list
                texts = []
                for content_item in item.content:
                    if hasattr(content_item, "text"):
                        texts.append(content_item.text)
                    elif isinstance(content_item, dict) and "text" in content_item:
                        texts.append(content_item["text"])
                return " ".join(texts)
        elif isinstance(item, dict) and item.get("role") == "user":
            content = item.get("content", "")
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                # Extract text from content list
                texts = []
                for content_item in content:
                    if isinstance(content_item, dict) and "text" in content_item:
                        texts.append(content_item["text"])
                return " ".join(texts)

    # If no user message found, return empty string
    return ""


def _check_team_supports_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team supports direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.
    This is a simplified version of the check from chat.py.

    Args:
        db: Database session
        team: Team Kind object
        user_id: User ID for lookup

    Returns:
        True if team supports direct chat
    """
    from app.schemas.kind import Shell
    from app.services.chat_v2.utils.http import ChatServiceBase

    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        # Get shell type
        bot_crd = Bot.model_validate(bot.json)

        # Check user's custom shells first
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        # If not found, check public shells
        if not shell:
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == bot_crd.spec.shellRef.name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if not shell or not shell.json:
            return False

        shell_crd = Shell.model_validate(shell.json)
        shell_type = shell_crd.spec.shellType

        if not ChatServiceBase.is_direct_chat_shell(shell_type):
            return False

    return True


class ChatSessionSetup(NamedTuple):
    """Result of chat session setup."""

    task: Kind
    task_id: int
    assistant_subtask: Subtask
    existing_subtasks: List[Subtask]
    model_config: Any
    system_prompt: str
    bot_name: str  # First bot's name for MCP loading
    bot_namespace: str  # First bot's namespace for MCP loading


def _setup_chat_session(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_trusted_source: Optional[str] = None,
) -> ChatSessionSetup:
    """
    Set up chat session: build config, create task and subtasks.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        input_text: User input text
        tool_settings: Tool settings
        task_id: Optional existing task ID
        api_trusted_source: Optional API trusted source name (from wegent-source header)

    Returns:
        ChatSessionSetup with task, subtasks, and config
    """
    from app.services.chat_v2.config import ChatConfigBuilder

    # Build chat configuration
    config_builder = ChatConfigBuilder(
        db=db,
        team=team,
        user_id=user.id,
        user_name=user.user_name,
    )

    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)
    try:
        chat_config = config_builder.build(
            override_model_name=model_info.get("model_id"),
            force_override=model_info.get("model_id") is not None,
            enable_clarification=False,
            enable_deep_thinking=enable_deep_thinking,
            task_id=task_id or 0,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    model_config = chat_config.model_config
    system_prompt = chat_config.system_prompt

    # Get bot IDs from team members
    team_crd = Team.model_validate(team.json)
    if not team_crd.spec.members:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Team has no members configured",
        )

    bot_ids = []
    first_bot_name = ""
    first_bot_namespace = "default"
    for member in team_crd.spec.members:
        member_bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if member_bot:
            bot_ids.append(member_bot.id)
            # Capture first bot info for MCP loading
            if not first_bot_name:
                first_bot_name = member.botRef.name
                first_bot_namespace = member.botRef.namespace

    if not bot_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid bots found in team",
        )

    # Create or get task
    task = None
    if task_id:
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

    if not task:
        new_task_id = task_kinds_service.create_task_id(db, user.id)

        if not task_kinds_service.validate_task_id(db, new_task_id):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create task ID",
            )

        # Create workspace
        workspace_name = f"workspace-{new_task_id}"
        workspace_json = {
            "kind": "Workspace",
            "spec": {"repository": {}},
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        workspace = Kind(
            user_id=user.id,
            kind="Workspace",
            name=workspace_name,
            namespace="default",
            json=workspace_json,
            is_active=True,
        )
        db.add(workspace)

        # Create task
        title = input_text[:50] + "..." if len(input_text) > 50 else input_text
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": input_text,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": None,
            },
            "metadata": {
                "name": f"task-{new_task_id}",
                "namespace": "default",
                "labels": {
                    "type": "online",
                    "taskType": "chat",
                    "autoDeleteExecutor": "false",
                    "source": "chat_shell",
                    "is_api_call": "true",
                    **(
                        {"modelId": model_info.get("model_id")}
                        if model_info.get("model_id")
                        else {}
                    ),
                    **(
                        {"forceOverrideBotModel": "true"}
                        if model_info.get("model_id")
                        else {}
                    ),
                    **(
                        {"api_trusted_source": api_trusted_source}
                        if api_trusted_source
                        else {}
                    ),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = Kind(
            id=new_task_id,
            user_id=user.id,
            kind="Task",
            name=f"task-{new_task_id}",
            namespace="default",
            json=task_json,
            is_active=True,
        )
        db.add(task)
        task_id = new_task_id

    # Get existing subtasks
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == user.id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    # Create USER subtask
    user_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="User message",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=input_text,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
        sender_type=SenderType.USER,
        sender_user_id=user.id,
    )
    db.add(user_subtask)

    # Create ASSISTANT subtask
    assistant_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="Assistant response",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id + 1,
        parent_id=next_message_id,
        error_message="",
        result=None,
        completed_at=datetime.now(),
        sender_type=SenderType.TEAM,
        sender_user_id=0,
    )
    db.add(assistant_subtask)

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    db.refresh(assistant_subtask)

    return ChatSessionSetup(
        task=task,
        task_id=task_id,
        assistant_subtask=assistant_subtask,
        existing_subtasks=existing_subtasks,
        model_config=model_config,
        system_prompt=system_prompt,
        bot_name=first_bot_name,
        bot_namespace=first_bot_namespace,
    )


def _build_chat_history(existing_subtasks: List[Subtask]) -> List[Dict[str, str]]:
    """Build chat history from existing subtasks."""
    history = []
    sorted_subtasks = sorted(existing_subtasks, key=lambda s: s.message_id)
    for st in sorted_subtasks:
        if st.status == SubtaskStatus.COMPLETED:
            if st.role == SubtaskRole.USER and st.prompt:
                history.append({"role": "user", "content": st.prompt})
            elif st.role == SubtaskRole.ASSISTANT and st.result:
                if isinstance(st.result, dict):
                    content = st.result.get("value", "")
                    if content:
                        history.append({"role": "assistant", "content": content})
    return history


async def _load_mcp_tools(
    task_id: int, bot_name: str = "", bot_namespace: str = "default"
) -> Any:
    """
    Load MCP tools for a task, merging backend and bot configurations.

    This function is adapted from ChatService._load_mcp_tools for use in OpenAPI responses.

    Args:
        task_id: Task ID for session management
        bot_name: Bot name to query Ghost MCP configuration
        bot_namespace: Bot namespace for Ghost query

    Returns:
        MCPClient instance or None
    """
    import asyncio
    import json

    from app.core.config import settings

    try:
        from app.services.chat_v2.tools.mcp import MCPClient

        # Step 1: Load backend MCP configuration
        backend_servers = {}
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if mcp_servers_config:
            try:
                config_data = json.loads(mcp_servers_config)
                backend_servers = config_data.get("mcpServers", config_data)
            except json.JSONDecodeError as e:
                logger.warning(f"[OPENAPI_MCP] Failed to parse CHAT_MCP_SERVERS: {e}")

        # Step 2: Load bot's MCP configuration from Ghost CRD
        bot_servers = {}
        if bot_name and bot_namespace:
            try:
                bot_servers = await asyncio.wait_for(
                    _get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
                )
            except asyncio.TimeoutError:
                logger.warning(
                    f"[OPENAPI_MCP] Timeout querying bot MCP servers for {bot_namespace}/{bot_name}"
                )
            except Exception as e:
                logger.warning(
                    f"[OPENAPI_MCP] Failed to load bot MCP servers for {bot_namespace}/{bot_name}: {e}"
                )

        # Step 3: Merge configurations (bot config takes precedence)
        merged_servers = {**backend_servers, **bot_servers}

        if not merged_servers:
            logger.info(
                f"[OPENAPI_MCP] No MCP servers configured for task {task_id} (bot={bot_namespace}/{bot_name})"
            )
            return None

        # Step 4: Create MCP client with merged configuration
        client = MCPClient(merged_servers)
        try:
            await asyncio.wait_for(client.connect(), timeout=30.0)
            logger.info(
                f"[OPENAPI_MCP] Loaded {len(client.get_tools())} tools from {len(merged_servers)} MCP servers for task {task_id}"
            )
            return client
        except asyncio.TimeoutError:
            logger.error(
                f"[OPENAPI_MCP] Timeout connecting to MCP servers for task {task_id}"
            )
            return None
        except Exception as e:
            logger.error(
                f"[OPENAPI_MCP] Failed to connect to MCP servers for task {task_id}: {e}"
            )
            return None

    except Exception:
        logger.exception(
            f"[OPENAPI_MCP] Unexpected error loading MCP tools for task {task_id}"
        )
        return None


async def _get_bot_mcp_servers(bot_name: str, bot_namespace: str) -> Dict[str, Any]:
    """Query bot's Ghost CRD to get MCP server configuration."""
    import asyncio

    return await asyncio.to_thread(_get_bot_mcp_servers_sync, bot_name, bot_namespace)


def _get_bot_mcp_servers_sync(bot_name: str, bot_namespace: str) -> Dict[str, Any]:
    """Synchronous implementation of bot MCP servers query."""
    from app.db.session import SessionLocal
    from app.schemas.kind import Ghost

    db = SessionLocal()
    try:
        # Query bot Kind
        bot_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not bot_kind or not bot_kind.json:
            return {}

        # Parse Bot CRD to get ghostRef
        bot_crd = Bot.model_validate(bot_kind.json)
        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            return {}

        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace

        # Query Ghost Kind
        ghost_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not ghost_kind or not ghost_kind.json:
            return {}

        # Parse Ghost CRD to get mcpServers
        ghost_crd = Ghost.model_validate(ghost_kind.json)
        if not ghost_crd.spec or not ghost_crd.spec.mcpServers:
            return {}

        return ghost_crd.spec.mcpServers

    except Exception:
        logger.exception(
            f"[OPENAPI_MCP] Failed to query bot MCP servers for {bot_namespace}/{bot_name}"
        )
        return {}
    finally:
        db.close()


async def _create_streaming_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_trusted_source: Optional[str] = None,
) -> StreamingResponse:
    """
    Create a streaming response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_trusted_source: Optional API trusted source name (from wegent-source header)

    Returns:
        StreamingResponse with SSE events
    """
    from app.services.openapi.streaming import streaming_service

    # Set up chat session (config, task, subtasks)
    setup = _setup_chat_session(
        db, user, team, model_info, input_text, tool_settings, task_id, api_trusted_source
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id
    task_kind_id = setup.task_id

    # Capture tool settings for use in generator
    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)
    bot_name = setup.bot_name
    bot_namespace = setup.bot_namespace

    async def raw_chat_stream() -> AsyncGenerator[str, None]:
        """Generate raw text chunks from the LLM/Agent and update subtask."""
        import asyncio

        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        from app.api.dependencies import get_db as get_db_session
        from app.core.config import settings
        from app.services.chat_v2.messages import MessageConverter
        from app.services.chat_v2.models import LangChainModelFactory
        from app.services.chat_v2.storage import db_handler, session_manager

        accumulated_content = ""
        db_gen = next(get_db_session())
        mcp_client = None

        try:
            cancel_event = await session_manager.register_stream(assistant_subtask_id)
            await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

            # Build messages with history
            history = _build_chat_history(setup.existing_subtasks)
            messages = MessageConverter.build_messages(
                history=history,
                current_message=input_text,
                system_prompt=setup.system_prompt,
            )

            # Prepare extra tools (MCP and web search)
            extra_tools = []

            # Load MCP tools if system config enabled
            if settings.CHAT_MCP_ENABLED:
                try:
                    mcp_client = await _load_mcp_tools(
                        task_kind_id, bot_name, bot_namespace
                    )
                    if mcp_client:
                        extra_tools.extend(mcp_client.get_tools())
                        logger.info(
                            f"[OPENAPI] Loaded {len(mcp_client.get_tools())} MCP tools for task {task_kind_id}"
                        )
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to load MCP tools: {e}")

            # Add web search tool if deep thinking enabled and system config allows
            if enable_deep_thinking and settings.WEB_SEARCH_ENABLED:
                try:
                    from app.services.chat_v2.tools import WebSearchTool

                    extra_tools.append(WebSearchTool())
                    logger.info(
                        f"[OPENAPI] Added web search tool for task {task_kind_id}"
                    )
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to add web search tool: {e}")

            # Decide whether to use agent (with tools) or simple LLM
            use_agent = len(extra_tools) > 0

            if use_agent:
                # Use LangGraph agent for tool support
                from app.services.chat_v2.agents import LangGraphAgentBuilder
                from app.services.chat_v2.tools import ToolRegistry

                llm = LangChainModelFactory.create_from_config(
                    setup.model_config, streaming=True
                )

                tool_registry = ToolRegistry()
                for tool in extra_tools:
                    tool_registry.register(tool)

                agent = LangGraphAgentBuilder(
                    llm=llm,
                    tool_registry=tool_registry,
                    max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
                )

                # Stream tokens from agent with periodic saves
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()
                redis_save_interval = getattr(
                    settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0
                )
                db_save_interval = getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)

                async for token in agent.stream_tokens(
                    messages, cancel_event=cancel_event
                ):
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        assistant_subtask_id
                    ):
                        logger.info(
                            f"Stream cancelled for subtask {assistant_subtask_id}"
                        )
                        if accumulated_content:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                        break

                    accumulated_content += token
                    yield token

                    # Periodic saves (same as simple LLM mode)
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_redis_save >= redis_save_interval:
                        await session_manager.save_streaming_content(
                            assistant_subtask_id, accumulated_content
                        )
                        last_redis_save = current_time

                    if current_time - last_db_save >= db_save_interval:
                        await db_handler.save_partial_response(
                            assistant_subtask_id, accumulated_content
                        )
                        last_db_save = current_time
            else:
                # Simple LLM streaming without tools
                try:
                    llm = LangChainModelFactory.create_from_config(
                        setup.model_config, streaming=True
                    )
                except Exception as e:
                    logger.error(f"Failed to create LLM from model config: {e}")
                    await db_handler.update_subtask_status(
                        assistant_subtask_id, "FAILED", error=f"Failed to create LLM: {e}"
                    )
                    return

                # Convert to LangChain messages
                langchain_messages = []
                for msg in messages:
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    if role == "system":
                        langchain_messages.append(SystemMessage(content=content))
                    elif role == "user":
                        langchain_messages.append(HumanMessage(content=content))
                    elif role == "assistant":
                        langchain_messages.append(AIMessage(content=content))

                # Stream response with periodic saves
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()
                redis_save_interval = getattr(
                    settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0
                )
                db_save_interval = getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)

                async for chunk in llm.astream(langchain_messages):
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        assistant_subtask_id
                    ):
                        logger.info(
                            f"Stream cancelled for subtask {assistant_subtask_id}"
                        )
                        if accumulated_content:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                        break

                    if hasattr(chunk, "content") and chunk.content:
                        accumulated_content += chunk.content
                        yield chunk.content

                        current_time = asyncio.get_event_loop().time()
                        if current_time - last_redis_save >= redis_save_interval:
                            await session_manager.save_streaming_content(
                                assistant_subtask_id, accumulated_content
                            )
                            last_redis_save = current_time

                        if current_time - last_db_save >= db_save_interval:
                            await db_handler.save_partial_response(
                                assistant_subtask_id, accumulated_content
                            )
                            last_db_save = current_time

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

                # Update task status
                task_kind = db_gen.query(Kind).filter(Kind.id == task_kind_id).first()
                if task_kind:
                    task_crd = Task.model_validate(task_kind.json)
                    if task_crd.status:
                        task_crd.status.status = "COMPLETED"
                        task_crd.status.updatedAt = datetime.now()
                        task_crd.status.completedAt = datetime.now()
                        task_kind.json = task_crd.model_dump(mode="json")
                        from sqlalchemy.orm.attributes import flag_modified

                        flag_modified(task_kind, "json")
                        db_gen.commit()

        except Exception as e:
            logger.exception(f"Error in raw_chat_stream: {e}")
            try:
                await db_handler.update_subtask_status(
                    assistant_subtask_id, "FAILED", error=str(e)
                )
            except Exception:
                pass
            raise
        finally:
            # Cleanup MCP client if used
            if mcp_client:
                try:
                    await mcp_client.close()
                except Exception as e:
                    logger.warning(f"[OPENAPI] Failed to close MCP client: {e}")

            await session_manager.unregister_stream(assistant_subtask_id)
            await session_manager.delete_streaming_content(assistant_subtask_id)
            db_gen.close()

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


async def _create_sync_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_trusted_source: Optional[str] = None,
) -> ResponseObject:
    """
    Create a synchronous (blocking) response for Chat Shell type teams.

    Supports MCP tools and web search when enabled.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings (enable_mcp, enable_web_search, search_engine)
        task_id: Optional existing task ID for follow-up conversations
        api_trusted_source: Optional API trusted source name (from wegent-source header)

    Returns:
        ResponseObject with completed status and output
    """
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    from sqlalchemy.orm.attributes import flag_modified

    from app.core.config import settings
    from app.services.chat_v2.messages import MessageConverter
    from app.services.chat_v2.models import LangChainModelFactory
    from app.services.chat_v2.storage import db_handler, session_manager

    # Set up chat session (config, task, subtasks)
    setup = _setup_chat_session(
        db, user, team, model_info, input_text, tool_settings, task_id, api_trusted_source
    )

    response_id = f"resp_{setup.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = setup.assistant_subtask.id

    # Extract tool settings
    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)

    # Update subtask status to RUNNING
    await db_handler.update_subtask_status(assistant_subtask_id, "RUNNING")

    accumulated_content = ""
    mcp_client = None

    try:
        # Build messages with history
        history = _build_chat_history(setup.existing_subtasks)
        messages = MessageConverter.build_messages(
            history=history,
            current_message=input_text,
            system_prompt=setup.system_prompt,
        )

        # Prepare extra tools (MCP and web search)
        extra_tools = []

        # Load MCP tools if system config enabled
        if settings.CHAT_MCP_ENABLED:
            try:
                mcp_client = await _load_mcp_tools(
                    setup.task_id, setup.bot_name, setup.bot_namespace
                )
                if mcp_client:
                    extra_tools.extend(mcp_client.get_tools())
                    logger.info(
                        f"[OPENAPI_SYNC] Loaded {len(mcp_client.get_tools())} MCP tools for task {setup.task_id}"
                    )
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to load MCP tools: {e}")

        # Add web search tool if deep thinking enabled and system config allows
        if enable_deep_thinking and settings.WEB_SEARCH_ENABLED:
            try:
                from app.services.chat_v2.tools import WebSearchTool

                extra_tools.append(WebSearchTool())
                logger.info(
                    f"[OPENAPI_SYNC] Added web search tool for task {setup.task_id}"
                )
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to add web search tool: {e}")

        # Decide whether to use agent (with tools) or simple LLM
        use_agent = len(extra_tools) > 0

        if use_agent:
            # Use LangGraph agent for tool support
            from app.services.chat_v2.agents import LangGraphAgentBuilder
            from app.services.chat_v2.tools import ToolRegistry

            llm = LangChainModelFactory.create_from_config(
                setup.model_config, streaming=True
            )

            tool_registry = ToolRegistry()
            for tool in extra_tools:
                tool_registry.register(tool)

            agent = LangGraphAgentBuilder(
                llm=llm,
                tool_registry=tool_registry,
                max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
            )

            # Stream and accumulate tokens from agent (blocking until complete)
            async for token in agent.stream_tokens(messages):
                accumulated_content += token
        else:
            # Simple LLM streaming without tools
            llm = LangChainModelFactory.create_from_config(
                setup.model_config, streaming=True
            )

            # Convert to LangChain messages
            langchain_messages = []
            for msg in messages:
                role = msg.get("role", "")
                content = msg.get("content", "")
                if role == "system":
                    langchain_messages.append(SystemMessage(content=content))
                elif role == "user":
                    langchain_messages.append(HumanMessage(content=content))
                elif role == "assistant":
                    langchain_messages.append(AIMessage(content=content))

            # Stream and accumulate content (blocking until complete)
            async for chunk in llm.astream(langchain_messages):
                if hasattr(chunk, "content") and chunk.content:
                    accumulated_content += chunk.content

        # Update subtask to completed
        result = {"value": accumulated_content}
        await db_handler.update_subtask_status(
            assistant_subtask_id, "COMPLETED", result=result
        )

        # Save chat history
        await session_manager.append_user_and_assistant_messages(
            setup.task_id, input_text, accumulated_content
        )

        # Update task status
        task_crd = Task.model_validate(setup.task.json)
        if task_crd.status:
            task_crd.status.status = "COMPLETED"
            task_crd.status.updatedAt = datetime.now()
            task_crd.status.completedAt = datetime.now()
            task_crd.status.result = result
            setup.task.json = task_crd.model_dump(mode="json")
            setup.task.updated_at = datetime.now()
            flag_modified(setup.task, "json")
            db.commit()

    except Exception as e:
        logger.exception(f"Error in sync chat response: {e}")
        error_message = str(e)
        await db_handler.update_subtask_status(
            assistant_subtask_id, "FAILED", error=error_message
        )

        # Update task status to FAILED
        task_crd = Task.model_validate(setup.task.json)
        if task_crd.status:
            task_crd.status.status = "FAILED"
            task_crd.status.errorMessage = error_message
            task_crd.status.updatedAt = datetime.now()
            setup.task.json = task_crd.model_dump(mode="json")
            setup.task.updated_at = datetime.now()
            flag_modified(setup.task, "json")
            db.commit()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {error_message}",
        )
    finally:
        # Cleanup MCP client if used
        if mcp_client:
            try:
                await mcp_client.close()
            except Exception as e:
                logger.warning(f"[OPENAPI_SYNC] Failed to close MCP client: {e}")

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


@router.post("")
async def create_response(
    request_body: ResponseCreateInput,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
    wegent_source: Optional[str] = Depends(security.get_wegent_source_header),
):
    """
    Create a new response (execute a task).

    This endpoint is compatible with OpenAI's Responses API format.

    For Chat Shell type teams:
    - When stream=True: Returns SSE stream with OpenAI v1/responses compatible events.
    - When stream=False (default): Blocks until LLM completes, returns completed response.

    For non-Chat Shell type teams (Executor-based):
    - Returns response with status 'queued' immediately.
    - Use GET /api/v1/responses/{response_id} to poll for completion.

    Args:
        request_body: ResponseCreateInput containing:
        - model: Format "namespace#team_name" or "namespace#team_name#model_id"
        - input: The user prompt (string or list of messages)
        - stream: Whether to enable streaming output (default: False)
        - tools: Optional Wegent tools:
          - {"type": "wegent_deep_thinking"}: Enable deep thinking mode with web search
            (web search requires WEB_SEARCH_ENABLED=true in system config)
        - previous_response_id: Optional, for follow-up conversations

    Note:
        - MCP tools are automatically loaded when CHAT_MCP_ENABLED=true (no user tool needed)
        - Web search is enabled when wegent_deep_thinking is used AND WEB_SEARCH_ENABLED=true

    Returns:
        ResponseObject with status 'completed' (Chat Shell)
        or StreamingResponse with SSE events (Chat Shell + stream=true)
        or ResponseObject with status 'queued' (non-Chat Shell)
    """
    # Parse model string
    model_info = _parse_model_string(request_body.model)

    # Parse tools for settings
    tool_settings = _parse_wegent_tools(request_body.tools)

    # Extract input text
    input_text = _extract_input_text(request_body.input)

    # Determine task_id from previous_response_id if provided
    task_id = None
    previous_task_id = None
    if request_body.previous_response_id:
        # Extract task_id from resp_{task_id} format
        if request_body.previous_response_id.startswith("resp_"):
            try:
                previous_task_id = int(request_body.previous_response_id[5:])
                task_id = previous_task_id  # For follow-up, use the same task_id
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid previous_response_id format: '{request_body.previous_response_id}'",
                )

            # Verify previous task exists and belongs to the current user
            existing_task = (
                db.query(Kind)
                .filter(
                    Kind.id == previous_task_id,
                    Kind.kind == "Task",
                    Kind.is_active == True,
                )
                .first()
            )
            if not existing_task:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Previous response '{request_body.previous_response_id}' not found",
                )

    # Verify team exists and user has access
    team = team_kinds_service.get_team_by_name_and_namespace_with_public_group(
        db, model_info["team_name"], model_info["namespace"], current_user.id
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' not found or not accessible",
        )

    # If model_id is provided, verify that the model exists
    if model_info.get("model_id"):
        model_name = model_info["model_id"]
        model_namespace = model_info["namespace"]

        model_exists = False

        if model_namespace == "default":
            # First, query personal model (user's own model)
            personal_model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == current_user.id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if personal_model:
                model_exists = True
            else:
                # If personal model not found, query public model (user_id = 0)
                public_model = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == model_name,
                        Kind.namespace == model_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                if public_model:
                    model_exists = True
        else:
            # If namespace is not default, query group model
            group_model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if group_model:
                model_exists = True

        if not model_exists:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Model '{model_namespace}/{model_name}' not found",
            )
    else:
        # If model_id is not provided, verify that all team's bots have valid modelRef
        # Parse team JSON to Team CRD object
        team_crd = Team.model_validate(team.json)

        if not team_crd.spec.members:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' has no members configured",
            )

        # Validate all members' bots have valid modelRef
        for member in team_crd.spec.members:
            bot_ref = member.botRef
            bot_name = bot_ref.name
            bot_namespace = bot_ref.namespace

            if not bot_name:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' has invalid bot reference",
                )

            # Query the bot from Kind table
            bot_kind = (
                db.query(Kind)
                .filter(
                    Kind.name == bot_name,
                    Kind.namespace == bot_namespace,
                    Kind.kind == "Bot",
                    Kind.user_id == team.user_id,
                    Kind.is_active == True,
                )
                .first()
            )

            if not bot_kind:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Bot '{bot_namespace}/{bot_name}' not found",
                )

            # Parse bot JSON to Bot CRD object and check modelRef
            bot_crd = Bot.model_validate(bot_kind.json)

            # modelRef must exist and have non-empty name and namespace
            model_ref = bot_crd.spec.modelRef
            if not model_ref or not model_ref.name or not model_ref.namespace:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Bot '{bot_namespace}/{bot_name}' does not have a valid model configured. Please specify model_id in the request or configure modelRef for the bot.",
                )

    # Check if team supports direct chat (Chat Shell type)
    supports_direct_chat = _check_team_supports_direct_chat(db, team, current_user.id)

    if supports_direct_chat:
        # Chat Shell type: use direct LLM call (streaming or sync)
        if request_body.stream:
            return await _create_streaming_response(
                db=db,
                user=current_user,
                team=team,
                model_info=model_info,
                request_body=request_body,
                input_text=input_text,
                tool_settings=tool_settings,
                task_id=task_id,
                api_trusted_source=wegent_source,
            )
        else:
            return await _create_sync_response(
                db=db,
                user=current_user,
                team=team,
                model_info=model_info,
                request_body=request_body,
                input_text=input_text,
                tool_settings=tool_settings,
                task_id=task_id,
                api_trusted_source=wegent_source,
            )

    # Non-Chat Shell type (Executor-based): streaming not supported
    if request_body.stream:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Streaming is only supported for teams where all bots use Chat Shell type. "
            "Please set stream=false to use the queued response mode.",
        )

    # Non-Chat Shell type (Executor-based): create task and return queued response
    task_create = TaskCreate(
        prompt=input_text,
        team_name=model_info["team_name"],
        team_namespace=model_info["namespace"],
        task_type="chat",
        type="online",
        source="api",
        model_id=model_info.get("model_id"),
        force_override_bot_model=model_info.get("model_id") is not None,
        api_trusted_source=wegent_source,
    )

    try:
        task_dict = task_kinds_service.create_task_or_append(
            db, obj_in=task_create, user=current_user, task_id=task_id
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create task: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create task: {str(e)}",
        )

    # Build previous_response_id for the response
    prev_resp_id = None
    if previous_task_id:
        prev_resp_id = f"resp_{previous_task_id}"

    # Get subtasks for output
    subtasks = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_dict.get("id"), Subtask.user_id == current_user.id
        )
        .order_by(Subtask.message_id.asc())
        .all()
    )

    return _task_to_response_object(
        task_dict,
        request_body.model,
        subtasks,
        previous_response_id=prev_resp_id,
    )


@router.get("/{response_id}", response_model=ResponseObject)
async def get_response(
    response_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Retrieve a response by ID.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with current status and output
    """
    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'. Expected format: 'resp_{{task_id}}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task detail
    try:
        task_dict = task_kinds_service.get_task_by_id(
            db, task_id=task_id, user_id=current_user.id
        )
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Response '{response_id}' not found",
            )
        raise

    # Get subtasks for output
    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
        .order_by(Subtask.message_id.asc())
        .all()
    )

    # Reconstruct model string from task team reference
    task_kind = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    model_string = "unknown"
    if task_kind and task_kind.json:
        task_crd = Task.model_validate(task_kind.json)
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace
        model_id = (
            task_crd.metadata.labels.get("modelId")
            if task_crd.metadata.labels
            else None
        )
        if model_id:
            model_string = f"{team_namespace}#{team_name}#{model_id}"
        else:
            model_string = f"{team_namespace}#{team_name}"

    return _task_to_response_object(task_dict, model_string, subtasks=subtasks)


@router.post("/{response_id}/cancel", response_model=ResponseObject)
async def cancel_response(
    response_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Cancel a running response.

    For Chat Shell type tasks (source="chat_shell"), this will stop the model request
    and save partial content to the subtask result.

    For other task types (Executor-based), this will call the executor_manager to cancel.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with status 'cancelled' or current status
    """
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.chat_v2.storage import db_handler, session_manager

    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task to check if it's a Chat Shell type
    task_kind = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Response '{response_id}' not found",
        )

    # Check if this is a Chat Shell task (source="chat_shell")
    task_crd = Task.model_validate(task_kind.json)
    source_label = (
        task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
    )
    is_chat_shell = source_label == "chat_shell"

    logger.info(
        f"[CANCEL] task_id={task_id}, source={source_label}, is_chat_shell={is_chat_shell}"
    )

    if is_chat_shell:
        # For Chat Shell tasks, use session_manager to cancel the stream
        # Find running assistant subtask
        from app.models.subtask import SubtaskStatus

        running_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == current_user.id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status.in_(
                    [
                        SubtaskStatus.PENDING,
                        SubtaskStatus.RUNNING,
                    ]
                ),
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        if running_subtask:
            logger.info(
                f"[CANCEL] Found running subtask: id={running_subtask.id}, status={running_subtask.status}"
            )

            # Get partial content from Redis before cancelling
            partial_content = await session_manager.get_streaming_content(
                running_subtask.id
            )
            logger.info(
                f"[CANCEL] Got partial content from Redis: length={len(partial_content) if partial_content else 0}"
            )

            # Cancel the stream (this sets the cancel event)
            await session_manager.cancel_stream(running_subtask.id)
            logger.info(f"[CANCEL] Stream cancelled for subtask {running_subtask.id}")

            # Update subtask status to COMPLETED with partial content
            running_subtask.status = SubtaskStatus.COMPLETED
            running_subtask.progress = 100
            running_subtask.completed_at = datetime.now()
            running_subtask.updated_at = datetime.now()
            running_subtask.result = {"value": partial_content or ""}

            # Update task status to COMPLETED
            if task_crd.status:
                task_crd.status.status = "COMPLETED"
                task_crd.status.errorMessage = ""
                task_crd.status.updatedAt = datetime.now()
                task_crd.status.completedAt = datetime.now()
                task_crd.status.result =  {"value": partial_content or ""}

            task_kind.json = task_crd.model_dump(mode="json")
            task_kind.updated_at = datetime.now()
            flag_modified(task_kind, "json")

            db.commit()
            db.refresh(task_kind)
            db.refresh(running_subtask)

            logger.info(
                f"[CANCEL] Chat Shell task cancelled: task_id={task_id}, subtask_id={running_subtask.id}"
            )
        else:
            logger.info(f"[CANCEL] No running subtask found for task {task_id}")
    else:
        # For Executor-based tasks, use the existing cancel service
        try:
            await task_kinds_service.cancel_task(
                db=db,
                task_id=task_id,
                user_id=current_user.id,
                background_task_runner=background_tasks.add_task,
            )
        except HTTPException as e:
            if e.status_code == 404:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Response '{response_id}' not found",
                )
            raise

    # Get updated task data for response
    try:
        task_dict = task_kinds_service.get_task_by_id(
            db, task_id=task_id, user_id=current_user.id
        )
    except HTTPException:
        # If task not found after cancel, return minimal response
        return ResponseObject(
            id=response_id,
            created_at=int(datetime.now().timestamp()),
            status="cancelled",
            model="unknown",
            output=[],
        )

    # Get subtasks for output (to include partial content)
    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
        .order_by(Subtask.message_id.asc())
        .all()
    )

    # Reconstruct model string
    model_string = "unknown"
    if task_kind and task_kind.json:
        task_crd = Task.model_validate(task_kind.json)
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace
        model_id = (
            task_crd.metadata.labels.get("modelId")
            if task_crd.metadata.labels
            else None
        )
        if model_id:
            model_string = f"{team_namespace}#{team_name}#{model_id}"
        else:
            model_string = f"{team_namespace}#{team_name}"

    return _task_to_response_object(task_dict, model_string, subtasks=subtasks)


@router.delete("/{response_id}", response_model=ResponseDeletedObject)
async def delete_response(
    response_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Delete a response.

    For Chat Shell type tasks with running streams, this will stop the model request
    before deleting.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseDeletedObject confirming deletion
    """
    from app.services.chat_v2.storage import session_manager

    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task to check if it's a Chat Shell type with running stream
    task_kind = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if task_kind:
        # Check if this is a Chat Shell task (source="chat_shell")
        task_crd = Task.model_validate(task_kind.json)
        source_label = (
            task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
        )
        is_chat_shell = source_label == "chat_shell"

        if is_chat_shell:
            # For Chat Shell tasks, stop any running stream before deleting
            running_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.user_id == current_user.id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status.in_(
                        [
                            SubtaskStatus.PENDING,
                            SubtaskStatus.RUNNING,
                        ]
                    ),
                )
                .order_by(Subtask.id.desc())
                .first()
            )

            if running_subtask:
                logger.info(
                    f"[DELETE] Stopping running stream before delete: task_id={task_id}, subtask_id={running_subtask.id}"
                )
                # Cancel the stream (this sets the cancel event)
                await session_manager.cancel_stream(running_subtask.id)
                # Clean up streaming content from Redis
                await session_manager.delete_streaming_content(running_subtask.id)
                await session_manager.unregister_stream(running_subtask.id)
                logger.info(
                    f"[DELETE] Stream stopped for subtask {running_subtask.id}"
                )

    try:
        task_kinds_service.delete_task(db, task_id=task_id, user_id=current_user.id)
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Response '{response_id}' not found",
            )
        raise

    return ResponseDeletedObject(id=response_id)
