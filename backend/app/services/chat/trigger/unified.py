# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unified AI Trigger - Refactored entry point for triggering AI responses.

This module provides a unified entry point for triggering AI responses,
removing all type-specific logic and using the unified ExecutionDispatcher.

Key changes from the original trigger_ai_response:
- No supports_direct_chat judgment
- No device vs executor judgment
- No chat_shell vs executor judgment
- Uses TaskRequestBuilder to build requests
- Uses ExecutionDispatcher to dispatch tasks
- Supports custom ResultEmitter for different output modes (WebSocket, SSE, Callback)
"""

import logging
from typing import TYPE_CHECKING, Any, Optional

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User

if TYPE_CHECKING:
    from app.api.ws.chat_namespace import ChatNamespace
    from app.services.execution.emitters import ResultEmitter

logger = logging.getLogger(__name__)


async def trigger_ai_response_unified(
    task: TaskResource,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    device_id: Optional[str] = None,
    namespace: Optional["ChatNamespace"] = None,
    user_subtask_id: Optional[int] = None,
    result_emitter: Optional["ResultEmitter"] = None,
    history_limit: Optional[int] = None,
    auth_token: str = "",
    is_subscription: bool = False,
    enable_tools: bool = True,
    enable_deep_thinking: bool = True,
) -> None:
    """Trigger AI response using unified execution architecture.

    This is the refactored version of trigger_ai_response that:
    - Has no supports_direct_chat judgment
    - Has no device vs executor judgment
    - Has no chat_shell vs executor judgment
    - Uses TaskRequestBuilder to build unified requests
    - Uses ExecutionDispatcher to dispatch tasks
    - Supports custom ResultEmitter for different output modes

    Args:
        task: Task TaskResource object
        assistant_subtask: Assistant subtask for AI response
        team: Team Kind object
        user: User object
        message: User message (original query)
        payload: Original chat send payload
        task_room: Task room name for WebSocket events
        device_id: Optional device ID (uses WebSocket mode when specified)
        namespace: ChatNamespace instance for emitting events (optional)
        user_subtask_id: Optional user subtask ID for unified context processing
        result_emitter: Optional custom ResultEmitter for output (SSE, WebSocket, Callback)
        history_limit: Optional limit on number of history messages
        auth_token: JWT token from user's request for downstream API authentication
        is_subscription: Whether this is a subscription task
        enable_tools: Whether to enable tool usage (default: True)
        enable_deep_thinking: Whether to enable deep thinking mode (default: True)
    """
    logger.info(
        "[ai_trigger_unified] Triggering AI response: task_id=%d, "
        "subtask_id=%d, device_id=%s, has_result_emitter=%s",
        task.id,
        assistant_subtask.id,
        device_id,
        result_emitter is not None,
    )

    from app.services.execution import execution_dispatcher

    # 1. Build unified execution request using shared function
    request = await build_execution_request(
        task=task,
        assistant_subtask=assistant_subtask,
        team=team,
        user=user,
        message=message,
        payload=payload,
        user_subtask_id=user_subtask_id,
        history_limit=history_limit,
        is_subscription=is_subscription,
        enable_tools=enable_tools,
        enable_deep_thinking=enable_deep_thinking,
    )

    # 2. Dispatch task
    # ExecutionDispatcher automatically selects communication mode:
    # - device_id specified -> WebSocket mode
    # - shell_type=Chat -> SSE mode
    # - Others -> HTTP+Callback mode
    # If result_emitter is provided, it will be used for event emission
    await execution_dispatcher.dispatch(
        request, device_id=device_id, emitter=result_emitter
    )

    logger.info(
        "[ai_trigger_unified] Task dispatched: task_id=%d, subtask_id=%d",
        task.id,
        assistant_subtask.id,
    )


async def build_execution_request(
    task: TaskResource,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any = None,
    user_subtask_id: Optional[int] = None,
    history_limit: Optional[int] = None,
    is_subscription: bool = False,
    enable_tools: bool = True,
    enable_deep_thinking: bool = True,
    enable_web_search: bool = False,
    enable_clarification: bool = False,
    preload_skills: Optional[list] = None,
):
    """Build ExecutionRequest without dispatching.

    This function builds the ExecutionRequest using TaskRequestBuilder,
    allowing callers to use the request with different dispatch methods
    (e.g., dispatch with SSEResultEmitter for OpenAPI streaming).

    Args:
        task: Task TaskResource object
        assistant_subtask: Assistant subtask for AI response
        team: Team Kind object
        user: User object
        message: User message (original query)
        payload: Optional original chat send payload (for extracting feature flags)
        user_subtask_id: Optional user subtask ID for unified context processing
        history_limit: Optional limit on number of history messages
        is_subscription: Whether this is a subscription task
        enable_tools: Whether to enable tool usage (default: True)
        enable_deep_thinking: Whether to enable deep thinking mode (default: True)
        enable_web_search: Whether to enable web search (default: False)
        enable_clarification: Whether to enable clarification mode (default: False)
        preload_skills: Optional list of skills to preload

    Returns:
        ExecutionRequest ready for dispatch
    """
    from app.services.execution import TaskRequestBuilder
    from shared.models import ExecutionRequest

    logger.info(
        "[build_execution_request] Building request: task_id=%d, subtask_id=%d",
        task.id,
        assistant_subtask.id,
    )

    db = SessionLocal()
    try:
        # Build unified execution request
        builder = TaskRequestBuilder(db)

        # Extract feature flags from payload if provided
        if payload is not None:
            enable_web_search = getattr(payload, "enable_web_search", enable_web_search)
            enable_clarification = getattr(
                payload, "enable_clarification", enable_clarification
            )
            additional_skills = getattr(payload, "additional_skills", None)
            if additional_skills:
                preload_skills = additional_skills

        # Extract model override from task metadata labels
        # This is where force_override_bot_model is stored when task is created
        override_model_name = None
        force_override = False
        task_json = task.json or {}
        task_labels = task_json.get("metadata", {}).get("labels", {})
        if task_labels:
            override_model_name = task_labels.get("modelId")
            force_override = task_labels.get("forceOverrideBotModel") == "true"
            logger.info(
                "[build_execution_request] Extracted model override from task labels: "
                "modelId=%s, forceOverrideBotModel=%s",
                override_model_name,
                force_override,
            )

        request = builder.build(
            subtask=assistant_subtask,
            task=task,
            user=user,
            team=team,
            message=message,
            enable_tools=enable_tools,
            enable_web_search=enable_web_search,
            enable_clarification=enable_clarification,
            enable_deep_thinking=enable_deep_thinking,
            preload_skills=preload_skills,
            history_limit=history_limit,
            is_subscription=is_subscription,
            override_model_name=override_model_name,
            force_override=force_override,
        )

        # Process contexts (attachments, knowledge bases, etc.)
        if user_subtask_id:
            request = await _process_contexts(db, request, user_subtask_id, user.id)

        return request

    finally:
        db.close()


async def _process_contexts(
    db,
    request,
    user_subtask_id: int,
    user_id: int,
):
    """Process contexts (attachments, knowledge bases, etc.) for the request.

    Args:
        db: Database session
        request: ExecutionRequest to enhance
        user_subtask_id: User subtask ID for context retrieval
        user_id: User ID for context retrieval

    Returns:
        Enhanced ExecutionRequest with context information
    """
    from app.services.chat.preprocessing import prepare_contexts_for_chat
    from app.services.chat.preprocessing.contexts import (
        _get_bound_knowledge_base_ids,
        get_document_ids_from_subtask,
        get_knowledge_base_ids_from_subtask,
    )

    # Get context_window from model_config for selected_documents injection threshold
    model_context_window = request.model_config.get("context_window")

    # Process contexts (attachments, knowledge bases, etc.)
    (
        final_message,
        enhanced_system_prompt,
        extra_tools,
        has_table_context,
        table_contexts,
    ) = await prepare_contexts_for_chat(
        db=db,
        user_subtask_id=user_subtask_id,
        user_id=user_id,
        message=request.prompt,
        base_system_prompt=request.system_prompt,
        task_id=request.task_id,
        context_window=model_context_window,
    )

    # Update request with processed contexts
    request.prompt = final_message
    request.system_prompt = enhanced_system_prompt
    request.table_contexts = table_contexts

    # Get knowledge base IDs
    knowledge_base_ids = get_knowledge_base_ids_from_subtask(db, user_subtask_id)
    is_user_selected_kb = bool(knowledge_base_ids)

    if knowledge_base_ids:
        document_ids = get_document_ids_from_subtask(db, user_subtask_id)
        request.knowledge_base_ids = knowledge_base_ids
        request.document_ids = document_ids
        request.is_user_selected_kb = is_user_selected_kb
    elif request.task_id:
        # Fall back to task-level bound knowledge bases
        knowledge_base_ids = _get_bound_knowledge_base_ids(db, request.task_id)
        if knowledge_base_ids:
            request.knowledge_base_ids = knowledge_base_ids
            request.is_user_selected_kb = False

    logger.info(
        "[ai_trigger_unified] Context processing completed: "
        "user_subtask_id=%d, knowledge_base_ids=%s, table_contexts_count=%d",
        user_subtask_id,
        request.knowledge_base_ids,
        len(table_contexts),
    )

    return request
