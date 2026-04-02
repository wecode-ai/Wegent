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
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union

from fastapi import HTTPException

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.services.context import context_service

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.api.ws.chat_namespace import ChatNamespace
    from app.services.execution.emitters import ResultEmitter
    from shared.models.execution import ExecutionRequest

logger = logging.getLogger(__name__)
SELECTED_KB_PRELOAD_SKILL = "wegent-knowledge"


def _build_executor_attachment_payload(context: Any) -> dict[str, Any]:
    """Serialize an attachment context for executor-side downloading."""
    return {
        "id": context.id,
        "original_filename": context.original_filename,
        "mime_type": context.mime_type,
        "file_size": context.file_size,
        "subtask_id": context.subtask_id,
    }


def _ensure_selected_kb_skill_priority(request: "ExecutionRequest") -> None:
    """Ensure selected-KB requests both preload and prioritize the KB skill."""
    if not request.knowledge_base_ids or not request.is_user_selected_kb:
        return

    preload_skills = list(request.preload_skills or [])
    if SELECTED_KB_PRELOAD_SKILL not in preload_skills:
        preload_skills.append(SELECTED_KB_PRELOAD_SKILL)
        request.preload_skills = preload_skills
        logger.info(
            "[ai_trigger_unified] Added preload skill '%s' for selected KBs: %s",
            SELECTED_KB_PRELOAD_SKILL,
            request.knowledge_base_ids,
        )

    user_selected_skills = list(request.user_selected_skills or [])
    if SELECTED_KB_PRELOAD_SKILL not in user_selected_skills:
        user_selected_skills.append(SELECTED_KB_PRELOAD_SKILL)
        request.user_selected_skills = user_selected_skills
        logger.info(
            "[ai_trigger_unified] Added user-selected skill '%s' for selected KBs: %s",
            SELECTED_KB_PRELOAD_SKILL,
            request.knowledge_base_ids,
        )


async def trigger_ai_response_unified(
    task: TaskResource,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: Union[str, list],
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
    previous_bot_id: Optional[int] = None,
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
        device_id=device_id,
        payload=payload,
        user_subtask_id=user_subtask_id,
        history_limit=history_limit,
        is_subscription=is_subscription,
        enable_tools=enable_tools,
        enable_deep_thinking=enable_deep_thinking,
        previous_bot_id=previous_bot_id,
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
    message: Union[str, list],
    device_id: Optional[str] = None,
    payload: Any = None,
    user_subtask_id: Optional[int] = None,
    history_limit: Optional[int] = None,
    is_subscription: bool = False,
    enable_tools: bool = True,
    enable_deep_thinking: bool = True,
    enable_web_search: bool = False,
    enable_clarification: bool = False,
    preload_skills: Optional[list] = None,
    previous_bot_id: Optional[int] = None,
    knowledge_base_names: Optional[List[Dict[str, str]]] = None,
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
        knowledge_base_names: Optional list of KB names in {'namespace': str, 'name': str} format

    Returns:
        ExecutionRequest ready for dispatch
    """
    from app.services.execution import TaskRequestBuilder
    from shared.models import ExecutionRequest
    from shared.telemetry.context import get_request_id

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
            previous_bot_id=previous_bot_id,
        )

        # Merge user-selected generate_params into videoConfig for video models
        # Validates params against model capabilities to reject invalid values
        if payload is not None:
            generate_params = getattr(payload, "generate_params", None)
            if generate_params and request.model_config.get("modelType") == "video":
                video_config = request.model_config.get("videoConfig") or {}
                capabilities = video_config.get("capabilities") or {}

                if generate_params.resolution:
                    allowed_resolutions = [
                        r.get("label") for r in (capabilities.get("resolutions") or [])
                    ]
                    if (
                        allowed_resolutions
                        and generate_params.resolution not in allowed_resolutions
                    ):
                        raise ValueError(
                            f"Unsupported resolution '{generate_params.resolution}', "
                            f"allowed: {allowed_resolutions}"
                        )
                    video_config["resolution"] = generate_params.resolution

                if generate_params.ratio:
                    allowed_ratios = [
                        r.get("value")
                        for r in (capabilities.get("aspect_ratios") or [])
                    ]
                    if allowed_ratios and generate_params.ratio not in allowed_ratios:
                        raise ValueError(
                            f"Unsupported aspect ratio '{generate_params.ratio}', "
                            f"allowed: {allowed_ratios}"
                        )
                    video_config["ratio"] = generate_params.ratio

                if generate_params.duration:
                    allowed_durations = capabilities.get("durations_sec") or []
                    if (
                        allowed_durations
                        and generate_params.duration not in allowed_durations
                    ):
                        raise ValueError(
                            f"Unsupported duration {generate_params.duration}s, "
                            f"allowed: {allowed_durations}"
                        )
                    video_config["duration"] = generate_params.duration

                request.model_config["videoConfig"] = video_config

        # Always propagate user_subtask_id for downstream persistence (e.g., KB tool results).
        # Note: This is different from request.subtask_id which is the assistant subtask.
        request.user_subtask_id = user_subtask_id

        # Propagate backend request_id for cross-service log correlation.
        # Fallback to deterministic subtask-based ID when request context is unavailable.
        current_request_id = get_request_id()
        request.request_id = (
            current_request_id if current_request_id else f"req_{assistant_subtask.id}"
        )
        logger.info(
            "[build_execution_request] request_id assigned: task_id=%d, subtask_id=%d, request_id=%s, source=%s",
            task.id,
            assistant_subtask.id,
            request.request_id,
            "context" if current_request_id else "generated",
        )

        # Process knowledge base names from API request (OpenAPI v1/responses)
        # This creates SubtaskContext records for KBs specified in the request
        processed_subtask_id = None
        if knowledge_base_names:
            processed_subtask_id = (
                user_subtask_id if user_subtask_id else assistant_subtask.id
            )
            logger.info(
                "[build_execution_request] Will create KB contexts for subtask_id: %d (user_subtask_id was %s)",
                processed_subtask_id,
                str(user_subtask_id),
            )
            await _create_kb_contexts_from_api_request(
                db, user.id, processed_subtask_id, knowledge_base_names
            )

        # Process contexts (attachments, knowledge bases, etc.)
        # If we created KB contexts, we need to process them regardless of whether it's user_subtask or assistant subtask
        context_subtask_id = (
            user_subtask_id if user_subtask_id else processed_subtask_id
        )
        if context_subtask_id:
            request = await _process_contexts(
                db,
                request,
                context_subtask_id,
                user.id,
            )
            if (
                device_id
                and request.knowledge_base_ids
                and request.is_user_selected_kb
                and SELECTED_KB_PRELOAD_SKILL not in (request.skill_names or [])
            ):
                from app.schemas.kind import Team as TeamCRD

                team_crd = TeamCRD.model_validate(team.json)
                bot = builder._get_bot_for_subtask(assistant_subtask, team, team_crd)
                if bot:
                    request = builder.resolve_request_preload_skills(
                        request=request,
                        bot=bot,
                        team=team,
                        user=user,
                    )

        return request

    finally:
        db.close()


async def _process_contexts(
    db: "Session",
    request: "ExecutionRequest",
    user_subtask_id: int,
    user_id: int,
) -> "ExecutionRequest":
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

    # Get context_window from model_config for selected_documents injection threshold
    model_context_window = request.model_config.get("context_window")

    # Process contexts (attachments, knowledge bases, etc.)
    ctx = await prepare_contexts_for_chat(
        db=db,
        user_subtask_id=user_subtask_id,
        user_id=user_id,
        message=request.prompt,
        base_system_prompt=request.system_prompt,
        task_id=request.task_id,
        context_window=model_context_window,
        model_config=request.model_config,
    )

    # Update request with all processed context results.
    # knowledge_base_ids / is_user_selected_kb / document_ids / kb_meta_prompt are
    # computed inside _prepare_kb_tools_from_contexts and surfaced here - no extra
    # DB queries needed.
    request.prompt = ctx.final_message
    request.system_prompt = ctx.kb.enhanced_system_prompt
    request.table_contexts = ctx.table_contexts
    request.kb_meta_prompt = ctx.kb.kb_meta_prompt
    request.attachments = [
        _build_executor_attachment_payload(context)
        for context in context_service.get_attachments_by_subtask(db, user_subtask_id)
    ]
    if ctx.kb.knowledge_base_ids:
        request.knowledge_base_ids = ctx.kb.knowledge_base_ids
        request.is_user_selected_kb = ctx.kb.is_user_selected_kb
        request.kb_tool_access_mode = ctx.kb.kb_tool_access_mode
        if ctx.kb.document_ids:
            request.document_ids = ctx.kb.document_ids
        _ensure_selected_kb_skill_priority(request)

    logger.info(
        "[ai_trigger_unified] Context processing completed: "
        "user_subtask_id=%d, knowledge_base_ids=%s, table_contexts_count=%d, attachments=%d",
        user_subtask_id,
        request.knowledge_base_ids,
        len(ctx.table_contexts),
        len(request.attachments),
    )

    return request


async def _create_kb_contexts_from_api_request(
    db: "Session",
    user_id: int,
    user_subtask_id: int,
    knowledge_base_names: List[Dict[str, str]],
) -> None:
    """Create SubtaskContext records for knowledge bases from API request.

    This function creates KB contexts for OpenAPI v1/responses requests
    that specify knowledge_base_names in the tools field. The created
    contexts are then processed by the existing RAG pipeline.

    Args:
        db: Database session
        user_id: User ID for permission checking
        user_subtask_id: User subtask ID to attach contexts to
        knowledge_base_names: List of dicts with 'namespace' and 'name' keys
    """
    from app.services.openapi.kb_context import KnowledgeBaseContextCreator

    try:
        creator = KnowledgeBaseContextCreator(db, user_id)
        contexts = creator.create_contexts(user_subtask_id, knowledge_base_names)
        logger.info(
            "[build_execution_request] Created %d KB contexts from API request "
            "for subtask %d",
            len(contexts),
            user_subtask_id,
        )
    except HTTPException:
        # Re-raise HTTPException from KnowledgeBaseNameResolver to propagate
        # permission errors (403) and not-found errors (404) to the caller
        raise
    except Exception as e:
        # Log error but don't fail the request - KB context creation is best-effort
        logger.warning(
            "[build_execution_request] Failed to create KB contexts from API request "
            "for subtask %d: %s",
            user_subtask_id,
            e,
        )
