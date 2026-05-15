# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.

This module uses the unified trigger architecture:
- setup_chat_session: Creates task and subtasks
- build_execution_request: Builds ExecutionRequest using TaskRequestBuilder
- execution_dispatcher.dispatch: Unified dispatch with SSEResultEmitter for streaming
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.core.rate_limit import get_limiter
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Task, Team
from app.schemas.openapi_response import (
    ResponseCreateInput,
    ResponseDeletedObject,
    ResponseError,
    ResponseObject,
)
from app.services.adapters.task_kinds import task_kinds_service
from app.services.chat.preprocessing.contexts import link_contexts_to_subtask
from app.services.chat.trigger.lifecycle import (
    collect_completed_result,
    persist_completed_result,
)
from app.services.openapi.helpers import (
    extract_input_text,
    parse_model_string,
    parse_wegent_tools,
    wegent_status_to_openai_status,
)
from app.services.openapi.output_builder import build_response_output
from app.services.readers.kinds import KindType, kindReader

logger = logging.getLogger(__name__)

router = APIRouter()

# Get rate limiter instance
limiter = get_limiter()


class _DispatchWithoutTerminalError(RuntimeError):
    """Raised when dispatch fails before any terminal event is emitted."""


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

    output = []
    if subtasks:
        output = build_response_output(subtasks)

    # Build error if failed
    error = None
    error_message = task_dict.get("error_message")
    if wegent_status == "FAILED" and error_message:
        error = ResponseError(code="task_failed", message=error_message)

    return ResponseObject(
        id=f"resp_{task_id}",
        created_at=created_at_unix,
        status=wegent_status_to_openai_status(wegent_status),
        error=error,
        model=model_string,
        output=output,
        previous_response_id=previous_response_id,
    )


def _filter_current_assistant_turn(
    subtasks: list[Subtask],
    assistant_subtask_id: int,
) -> list[Subtask]:
    return [subtask for subtask in subtasks if subtask.id == assistant_subtask_id]


async def _persist_terminal_failure(
    *,
    subtask_id: int,
    task_id: int,
    error_message: str,
    error_code: Optional[str] = None,
) -> None:
    """Persist a terminal FAILED result when execution aborts before emitting one."""
    result = await collect_completed_result(
        subtask_id,
        status="FAILED",
        error_message=error_message,
        error_code=error_code,
    )
    await persist_completed_result(
        subtask_id=subtask_id,
        task_id=task_id,
        status="FAILED",
        result=result,
        error=error_message,
    )


@router.post("")
@limiter.limit(settings.RATE_LIMIT_CREATE_RESPONSE)
async def create_response(
    request: Request,
    request_body: ResponseCreateInput,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """
    Create a new response (execute a task).

    This endpoint is compatible with OpenAI's Responses API format.

    For Chat Shell type teams:
    - When stream=True: Returns SSE stream with OpenAI v1/responses compatible events.
    - When stream=False (default): Blocks until LLM completes, returns completed response.
    - When background=True: Returns immediately with status 'in_progress', task runs asynchronously.

    For non-Chat Shell type teams (Executor-based):
    - Returns response with status 'queued' immediately.
    - Use GET /api/v1/responses/{response_id} to poll for completion.

    Args:
        request_body: ResponseCreateInput containing:
        - model: Format "namespace#team_name" or "namespace#team_name#model_id"
        - input: The user prompt (string or list of messages)
        - stream: Whether to enable streaming output (default: False)
        - background: Whether to run in background mode (default: False).
          When true, the request returns immediately with status 'in_progress'
          and the task runs asynchronously. Use GET /responses/{response_id} to poll.
        - tools: Optional Wegent tools to enable server-side capabilities:
          - {"type": "wegent_chat_bot"}: Enable all server-side capabilities
            (deep thinking with web search, server MCP tools, message enhancement)
        - previous_response_id: Optional, for follow-up conversations

    Note:
        - By default, API calls use "clean mode" without server-side enhancements
        - Bot/Ghost MCP tools are always available (configured in the bot's Ghost CRD)
        - Use wegent_chat_bot to enable full server-side capabilities
        - background=True and stream=True are mutually exclusive; background takes precedence

    Returns:
        ResponseObject with status 'completed' (Chat Shell sync mode)
        or StreamingResponse with SSE events (Chat Shell + stream=true)
        or ResponseObject with status 'in_progress' (background=true)
        or ResponseObject with status 'queued' (non-Chat Shell)
    """
    # Extract user and api_key_name from auth context
    current_user = auth_context.user
    api_key_name = auth_context.api_key_name

    # Parse model string
    model_info = parse_model_string(request_body.model)

    # Parse tools for settings
    tool_settings = parse_wegent_tools(request_body.tools)

    # Extract input text
    input_text = extract_input_text(request_body.input)

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
                db.query(TaskResource)
                .filter(
                    TaskResource.id == previous_task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active == TaskResource.STATE_ACTIVE,
                )
                .first()
            )
            if not existing_task:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Previous response '{request_body.previous_response_id}' not found",
                )

    # Verify team exists and user has access
    team = kindReader.get_by_name_and_namespace(
        db,
        current_user.id,
        KindType.TEAM,
        model_info["namespace"],
        model_info["team_name"],
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

        model = kindReader.get_by_name_and_namespace(
            db,
            current_user.id,
            KindType.MODEL,
            model_namespace,
            model_name,
        )

        # If not found and namespace is not default, try with default namespace
        # This handles the case where user passes group#group_team#public_model_id
        if not model and model_namespace != "default":
            model = kindReader.get_by_name_and_namespace(
                db,
                current_user.id,
                KindType.MODEL,
                "default",
                model_name,
            )

        if not model:
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

            # Query the bot using kindReader
            bot_kind = kindReader.get_by_name_and_namespace(
                db,
                team.user_id,
                KindType.BOT,
                bot_namespace,
                bot_name,
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

    # Use unified trigger architecture for all shell types
    # ExecutionRouter will automatically select communication mode based on shell_type
    if request_body.stream and not request_body.background:
        # Streaming mode: use dispatch_sse_stream
        # Note: background=True takes precedence over stream=True
        return await _create_streaming_response_unified(
            db=db,
            user=current_user,
            team=team,
            model_info=model_info,
            request_body=request_body,
            input_text=input_text,
            tool_settings=tool_settings,
            task_id=task_id,
            api_key_name=api_key_name,
        )
    else:
        # Non-streaming mode: background or sync
        return await _create_non_streaming_response_unified(
            db=db,
            user=current_user,
            team=team,
            model_info=model_info,
            request_body=request_body,
            input_text=input_text,
            tool_settings=tool_settings,
            task_id=task_id,
            api_key_name=api_key_name,
            background=request_body.background,
        )


async def _create_non_streaming_response_unified(
    db: Session,
    user: User,
    team,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
    background: bool = False,
) -> ResponseObject:
    """Create non-streaming response using unified trigger architecture.

    Handles both sync and background modes:
    - background=False (sync): Blocks until LLM completes, returns completed response
    - background=True: Returns immediately with 'in_progress', task runs asynchronously

    For non-SSE shell types, always returns queued response regardless of background flag.
    """
    import asyncio

    from app.db.session import SessionLocal
    from app.services.chat.storage import session_manager
    from app.services.chat.trigger.unified import build_execution_request
    from app.services.execution import execution_dispatcher
    from app.services.execution.emitters import SSEResultEmitter
    from app.services.openapi.chat_session import setup_chat_session
    from shared.models import EventType

    # Set up chat session (creates task and subtasks)
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
    task_kind_id = setup.task_id
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)
    preload_skills = tool_settings.get("preload_skills", [])
    user_id = user.id

    # Extract knowledge base names from tool settings
    knowledge_base_names = tool_settings.get("knowledge_base_names", [])

    # Auto-enable tools when knowledge_base is specified
    # This ensures KB tools and skill tools are actually added to the agent
    enable_tools = enable_chat_bot or bool(knowledge_base_names)

    # Link attachments to user subtask if provided
    if request_body.attachment_ids:
        link_contexts_to_subtask(
            db=db,
            subtask_id=setup.user_subtask.id,
            user_id=user.id,
            attachment_ids=request_body.attachment_ids,
            task=setup.task,
        )
        logger.info(
            f"[OPENAPI] Linked {len(request_body.attachment_ids)} attachments "
            f"to subtask {setup.user_subtask.id}"
        )

    # Convert reasoning config from Pydantic model to dict
    reasoning_config = None
    if request_body.reasoning:
        reasoning_config = request_body.reasoning.model_dump()

    # Build execution request
    try:
        execution_request = await build_execution_request(
            task=setup.task,
            assistant_subtask=setup.assistant_subtask,
            team=team,
            user=user,
            message=input_text,
            enable_tools=enable_tools,
            user_subtask_id=setup.user_subtask.id,
            enable_deep_thinking=enable_chat_bot,
            enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
            preload_skills=preload_skills,
            knowledge_base_names=knowledge_base_names,
            reasoning_config=reasoning_config,
        )
    except Exception as e:
        logger.error(f"Failed to build execution request: {e}")
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to build execution request: {str(e)}",
        )

    # Helper: close db session
    def _close_db():
        try:
            db.rollback()
        except Exception:
            pass
        db.close()

    # Helper: execute and collect content using SSEResultEmitter
    async def _execute_and_collect() -> tuple[str, Optional[Any]]:
        emitter = SSEResultEmitter(
            task_id=execution_request.task_id,
            subtask_id=execution_request.subtask_id,
        )
        dispatch_task = asyncio.create_task(
            execution_dispatcher.dispatch(execution_request, emitter=emitter)
        )
        accumulated_content, final_event = await emitter.collect()
        dispatch_error = None
        try:
            await dispatch_task
        except Exception as exc:
            dispatch_error = exc

        if final_event and final_event.type == EventType.ERROR.value:
            raise RuntimeError(final_event.error or "Unknown error")
        if dispatch_error is not None and final_event is None:
            raise _DispatchWithoutTerminalError(str(dispatch_error)) from dispatch_error

        return accumulated_content, final_event

    # Helper: query subtasks
    def _query_subtasks():
        query_db = SessionLocal()
        try:
            return (
                query_db.query(Subtask)
                .filter(Subtask.task_id == task_kind_id, Subtask.user_id == user_id)
                .order_by(Subtask.message_id.asc())
                .all()
            )
        finally:
            query_db.close()

    # Check if SSE mode is supported
    supports_sse = execution_dispatcher.supports_streaming(execution_request)

    # Non-SSE mode: dispatch and return queued response
    if not supports_sse:
        _close_db()
        asyncio.create_task(
            execution_dispatcher.dispatch(execution_request, emitter=None)
        )
        logger.info(
            f"[OPENAPI] Dispatched non-SSE task: task_id={task_kind_id}, "
            f"subtask_id={assistant_subtask_id}"
        )
        subtasks = _filter_current_assistant_turn(
            _query_subtasks(),
            assistant_subtask_id,
        )
        return ResponseObject(
            id=response_id,
            created_at=created_at,
            status="queued",
            model=request_body.model,
            output=build_response_output(
                subtasks,
                active_assistant_subtask_id=assistant_subtask_id,
                active_assistant_status="in_progress",
            ),
            previous_response_id=request_body.previous_response_id,
        )

    # SSE mode with background=True: fire-and-forget
    if background:
        _close_db()

        async def _run_background_task():
            try:
                accumulated_content, _ = await _execute_and_collect()
                logger.info(
                    f"[BACKGROUND] Task completed: task_id={task_kind_id}, "
                    f"subtask_id={assistant_subtask_id}, content_len={len(accumulated_content)}"
                )
            except _DispatchWithoutTerminalError as e:
                await _persist_terminal_failure(
                    subtask_id=assistant_subtask_id,
                    task_id=task_kind_id,
                    error_message=str(e),
                )
                logger.exception(f"[BACKGROUND] Error in background task: {e}")
            except Exception as e:
                logger.exception(f"[BACKGROUND] Error in background task: {e}")

        asyncio.create_task(_run_background_task())
        logger.info(
            f"[BACKGROUND] Task started: task_id={task_kind_id}, "
            f"subtask_id={assistant_subtask_id}"
        )
        subtasks = _filter_current_assistant_turn(
            _query_subtasks(),
            assistant_subtask_id,
        )
        return ResponseObject(
            id=response_id,
            created_at=created_at,
            status="in_progress",
            model=request_body.model,
            output=build_response_output(
                subtasks,
                active_assistant_subtask_id=assistant_subtask_id,
                active_assistant_status="in_progress",
            ),
            previous_response_id=request_body.previous_response_id,
        )

    # SSE mode with background=False: sync wait for completion
    _close_db()
    try:
        accumulated_content, _ = await _execute_and_collect()
        logger.info(f"[OPENAPI] Sync completed for subtask {assistant_subtask_id}")
    except _DispatchWithoutTerminalError as e:
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        logger.exception(f"Error in sync chat response: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {str(e)}",
        )
    except Exception as e:
        logger.exception(f"Error in sync chat response: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {str(e)}",
        )

    subtasks = _filter_current_assistant_turn(
        _query_subtasks(),
        assistant_subtask_id,
    )
    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status="completed",
        model=request_body.model,
        output=build_response_output(
            subtasks,
            active_assistant_subtask_id=assistant_subtask_id,
            active_assistant_status="completed",
            active_assistant_content=accumulated_content,
        ),
        previous_response_id=request_body.previous_response_id,
    )


async def _create_streaming_response_unified(
    db: Session,
    user: User,
    team,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> StreamingResponse:
    """Create streaming response using unified trigger architecture.

    Uses build_execution_request + dispatch_sse_stream for streaming.
    Raises NotImplementedError if the shell type doesn't support streaming.
    """
    from app.services.chat.storage import session_manager
    from app.services.chat.trigger.unified import build_execution_request
    from app.services.execution import execution_dispatcher
    from app.services.openapi.chat_session import setup_chat_session
    from app.services.openapi.streaming import streaming_service
    from shared.models import EventType

    # Set up chat session (creates task and subtasks)
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
    task_kind_id = setup.task_id
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)
    preload_skills = tool_settings.get("preload_skills", [])

    # Extract data needed for streaming before closing db
    user_id = user.id
    user_name = user.user_name

    # Extract knowledge base names from tool settings
    knowledge_base_names = tool_settings.get("knowledge_base_names", [])

    # Auto-enable tools when knowledge_base is specified
    # This ensures KB tools and skill tools are actually added to the agent
    enable_tools = enable_chat_bot or bool(knowledge_base_names)

    # Link attachments to user subtask if provided
    if request_body.attachment_ids:
        link_contexts_to_subtask(
            db=db,
            subtask_id=setup.user_subtask.id,
            user_id=user.id,
            attachment_ids=request_body.attachment_ids,
            task=setup.task,
        )
        logger.info(
            f"[OPENAPI] Linked {len(request_body.attachment_ids)} attachments "
            f"to subtask {setup.user_subtask.id}"
        )

    # Convert reasoning config from Pydantic model to dict
    reasoning_config = None
    if request_body.reasoning:
        reasoning_config = request_body.reasoning.model_dump()

    # Build execution request using unified builder
    try:
        execution_request = await build_execution_request(
            task=setup.task,
            assistant_subtask=setup.assistant_subtask,
            team=team,
            user=user,
            message=input_text,
            enable_tools=enable_tools,
            user_subtask_id=setup.user_subtask.id,
            enable_deep_thinking=enable_chat_bot,
            enable_web_search=enable_chat_bot and settings.WEB_SEARCH_ENABLED,
            preload_skills=preload_skills,
            knowledge_base_names=knowledge_base_names,
            reasoning_config=reasoning_config,
        )
    except Exception as e:
        logger.error(f"Failed to build execution request: {e}")
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to build execution request: {str(e)}",
        )
    finally:
        # Close the database session before streaming starts
        try:
            db.rollback()
        except Exception:
            pass
        db.close()

    async def raw_chat_stream():
        """Generate raw text and reasoning chunks from ExecutionDispatcher."""
        import asyncio

        from app.services.execution.emitters import SSEResultEmitter
        from app.services.openapi.streaming import StreamingChunk
        from shared.models import ExecutionEvent

        accumulated_content = ""
        accumulated_reasoning = ""
        tool_states: Dict[str, Dict[str, Any]] = {}
        next_output_index = 0
        reasoning_output_started = False
        message_output_started = False

        def allocate_output_index() -> int:
            nonlocal next_output_index
            assigned = next_output_index
            next_output_index += 1
            return assigned

        def _normalize_protocol_type(
            value: str | None, tool_name: str | None = None
        ) -> str:
            if value in {"mcp", "mcp_call"}:
                return "mcp_call"
            if value == "shell_call":
                return "shell_call"
            if tool_name == "exec":
                return "shell_call"
            return "function_call"

        emitter = None
        dispatch_task = None
        pubsub_redis_client = None
        pubsub_obj = None

        try:
            cancel_event = await session_manager.register_stream(assistant_subtask_id)

            is_sse = execution_dispatcher.supports_streaming(execution_request)

            if is_sse:
                # SSE mode (Chat shell): stream directly via OpenAI client
                emitter = SSEResultEmitter(
                    task_id=execution_request.task_id,
                    subtask_id=execution_request.subtask_id,
                )
                dispatch_task = asyncio.create_task(
                    execution_dispatcher.dispatch(execution_request, emitter=emitter)
                )
            else:
                # HTTP+Callback mode (ClaudeCode/Agno/Dify): subscribe to Redis
                # pub/sub channel; the /internal/callback handler publishes events
                pubsub_redis_client, pubsub_obj = (
                    await session_manager.subscribe_callback_channel(
                        assistant_subtask_id
                    )
                )
                if pubsub_redis_client is None:
                    raise RuntimeError("Failed to subscribe to callback stream channel")
                # Fire-and-forget; executor sends events back via /internal/callback
                asyncio.create_task(
                    execution_dispatcher.dispatch(execution_request, emitter=None)
                )

            async def _iter_events():
                """Yield ExecutionEvents from either SSE emitter or callback pub/sub."""
                if is_sse:
                    async for ev in emitter.stream():
                        yield ev
                else:
                    # Poll the pub/sub channel; 1s timeout keeps cancellation responsive
                    max_wait_until = asyncio.get_event_loop().time() + 600
                    while asyncio.get_event_loop().time() < max_wait_until:
                        if cancel_event.is_set():
                            return
                        message = await pubsub_obj.get_message(
                            ignore_subscribe_messages=True, timeout=1.0
                        )
                        if message is None:
                            continue
                        if message.get("type") != "message":
                            continue
                        data = message["data"]
                        if isinstance(data, bytes):
                            data = data.decode("utf-8")
                        event = ExecutionEvent.from_dict(json.loads(data))
                        yield event
                        if event.type in (
                            EventType.DONE.value,
                            EventType.ERROR.value,
                            EventType.CANCELLED.value,
                        ):
                            return

            # Stream events from the unified source
            try:
                async for event in _iter_events():
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        assistant_subtask_id
                    ):
                        logger.info(
                            f"Stream cancelled for subtask {assistant_subtask_id}"
                        )
                        break

                    if event.type == EventType.CHUNK.value:
                        content = event.content or ""
                        if content:
                            if not message_output_started:
                                message_output_started = True
                                allocate_output_index()
                            accumulated_content += content
                            yield StreamingChunk(type="text", content=content)
                    elif event.type == EventType.THINKING.value:
                        # Handle reasoning/thinking content
                        reasoning = event.content or ""
                        if reasoning:
                            if not reasoning_output_started:
                                reasoning_output_started = True
                                allocate_output_index()
                            accumulated_reasoning += reasoning
                            yield StreamingChunk(type="reasoning", content=reasoning)
                    elif event.type == EventType.TOOL_START.value:
                        tool_use_id = event.tool_use_id or ""
                        if not tool_use_id:
                            continue

                        tool_protocol = _normalize_protocol_type(
                            event.data.get("tool_protocol") if event.data else None,
                            event.tool_name,
                        )
                        tool_name = event.tool_name or ""
                        tool_input = (
                            event.tool_input if event.tool_input is not None else {}
                        )
                        tool_state = {
                            "protocol": tool_protocol,
                            "name": tool_name,
                            "arguments": tool_input,
                            "output_index": allocate_output_index(),
                        }
                        if event.data and event.data.get("server_label"):
                            tool_state["server_label"] = event.data["server_label"]
                        tool_states[tool_use_id] = tool_state

                        if tool_protocol == "mcp_call":
                            yield StreamingChunk(
                                type="mcp_call_added",
                                data={
                                    "item_id": tool_use_id,
                                    "name": tool_name,
                                    "server_label": tool_state.get("server_label", ""),
                                    "output_index": tool_state["output_index"],
                                },
                            )
                        elif tool_protocol == "shell_call":
                            yield StreamingChunk(
                                type="shell_call_added",
                                data={
                                    "call_id": tool_use_id,
                                    "name": tool_name,
                                    "arguments": tool_input,
                                    "output_index": tool_state["output_index"],
                                },
                            )
                        else:
                            yield StreamingChunk(
                                type="function_call_added",
                                data={
                                    "call_id": tool_use_id,
                                    "name": tool_name,
                                    "arguments": (
                                        json.dumps(tool_input, ensure_ascii=False)
                                        if tool_input is not None
                                        else ""
                                    ),
                                    "output_index": tool_state["output_index"],
                                },
                            )
                    elif event.type == EventType.TOOL.value:
                        tool_use_id = event.tool_use_id or ""
                        if not tool_use_id:
                            continue
                        tool_state = tool_states.get(tool_use_id)
                        if not tool_state:
                            continue
                        if tool_state.get("protocol") == "mcp_call":
                            tool_state["arguments"] = (
                                event.tool_input if event.tool_input is not None else {}
                            )
                    elif event.type == EventType.ERROR.value:
                        error_msg = event.error or "Unknown error"
                        logger.error(f"[OPENAPI] Error from execution: {error_msg}")
                        raise Exception(error_msg)
                    elif event.type == EventType.TOOL_RESULT.value:
                        tool_use_id = event.tool_use_id or ""
                        if not tool_use_id:
                            continue
                        tool_state = tool_states.pop(tool_use_id, None)
                        if tool_state is None:
                            tool_state = {
                                "protocol": _normalize_protocol_type(
                                    (
                                        event.data.get("tool_protocol")
                                        if event.data
                                        else None
                                    ),
                                    event.tool_name,
                                ),
                                "name": event.tool_name or "",
                                "arguments": (
                                    event.tool_input
                                    if event.tool_input is not None
                                    else {}
                                ),
                                "output_index": allocate_output_index(),
                            }
                            if event.data and event.data.get("server_label"):
                                tool_state["server_label"] = event.data["server_label"]
                        tool_protocol = _normalize_protocol_type(
                            tool_state.get("protocol")
                            or (
                                event.data.get("tool_protocol") if event.data else None
                            ),
                            tool_state.get("name") or event.tool_name,
                        )
                        tool_name = tool_state.get("name") or event.tool_name or ""
                        arguments = (
                            event.tool_input
                            if event.tool_input is not None
                            else tool_state.get("arguments") or {}
                        )
                        output_index = tool_state["output_index"]

                        if tool_protocol == "mcp_call":
                            yield StreamingChunk(
                                type="mcp_call_done",
                                data={
                                    "item_id": tool_use_id,
                                    "name": tool_name,
                                    "server_label": tool_state.get("server_label", ""),
                                    "arguments": (
                                        json.dumps(arguments, ensure_ascii=False)
                                        if arguments
                                        else ""
                                    ),
                                    "output_index": output_index,
                                    "status": (
                                        "failed"
                                        if event.data
                                        and event.data.get("status") == "failed"
                                        else "completed"
                                    ),
                                    "error": event.error
                                    or (
                                        event.data.get("error") if event.data else None
                                    ),
                                },
                            )
                        elif tool_protocol == "shell_call":
                            yield StreamingChunk(
                                type="shell_call_done",
                                data={
                                    "call_id": tool_use_id,
                                    "name": tool_name,
                                    "arguments": arguments,
                                    "output_index": output_index,
                                    "status": (
                                        "failed"
                                        if event.data
                                        and event.data.get("status") == "failed"
                                        else "completed"
                                    ),
                                },
                            )
                        else:
                            yield StreamingChunk(
                                type="function_call_done",
                                data={
                                    "call_id": tool_use_id,
                                    "name": tool_name,
                                    "arguments": (
                                        json.dumps(arguments, ensure_ascii=False)
                                        if arguments
                                        else ""
                                    ),
                                    "output_index": output_index,
                                },
                            )
                    elif event.type == EventType.DONE.value:
                        logger.info(
                            f"[OPENAPI] Stream completed for subtask {assistant_subtask_id}"
                        )
            finally:
                # Wait for SSE dispatch task to complete
                if dispatch_task is not None:
                    try:
                        await dispatch_task
                    except Exception:
                        pass  # Error already handled via emitter

        except NotImplementedError as e:
            # Streaming not supported for this shell type
            logger.error(f"[OPENAPI] Streaming not supported: {e}")
            raise
        except Exception as e:
            logger.exception(f"Error in streaming: {e}")
            raise
        finally:
            if pubsub_obj is not None:
                try:
                    await pubsub_obj.unsubscribe()
                except Exception:
                    pass
            if pubsub_redis_client is not None:
                try:
                    await pubsub_redis_client.aclose()
                except Exception:
                    pass
            await session_manager.unregister_stream(assistant_subtask_id)
            await session_manager.delete_streaming_content(assistant_subtask_id)

    async def generate():
        try:
            async for event in streaming_service.create_streaming_response(
                response_id=response_id,
                model_string=request_body.model,
                chat_stream=raw_chat_stream(),
                created_at=created_at,
                previous_response_id=request_body.previous_response_id,
                task_context=(
                    {
                        "task_id": setup.task_id,
                        "task_path": f"/chat?task_id={setup.task_id}",
                    }
                    if request_body.wegent_options
                    and request_body.wegent_options.include_task_context
                    else None
                ),
            ):
                yield event
        except NotImplementedError as e:
            # Return error in SSE format
            import json

            error_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="failed",
                error=ResponseError(code="not_implemented", message=str(e)),
                model=request_body.model,
                output=[],
                previous_response_id=request_body.previous_response_id,
            )
            yield f"data: {json.dumps({'response': error_response.model_dump(), 'type': 'response.failed'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{response_id}", response_model=ResponseObject)
@limiter.limit(settings.RATE_LIMIT_GET_RESPONSE)
async def get_response(
    request: Request,
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
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
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
@limiter.limit(settings.RATE_LIMIT_CANCEL_RESPONSE)
async def cancel_response(
    request: Request,
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

    from app.services.chat.storage import db_handler, session_manager

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
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
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
                task_crd.status.result = {"value": partial_content or ""}

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
@limiter.limit(settings.RATE_LIMIT_DELETE_RESPONSE)
async def delete_response(
    request: Request,
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
    from app.services.chat.storage import session_manager

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
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
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
                logger.info(f"[DELETE] Stream stopped for subtask {running_subtask.id}")

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
