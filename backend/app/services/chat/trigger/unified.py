# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build and dispatch AI requests without blocking on model resolution."""

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union

from fastapi import HTTPException

from app.core.async_utils import run_in_threadpool_with_cleanup
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.external_knowledge_refs import (
    extract_task_external_knowledge_refs,
    validate_external_knowledge_refs,
)
from app.services.chat.trigger.request_preparation import prepare_execution_request
from app.services.context import context_service
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.api.ws.chat_namespace import ChatNamespace
    from app.models.subtask_context import SubtaskContext
    from app.services.execution.emitters import ResultEmitter
    from shared.models.execution import ExecutionRequest

logger = logging.getLogger(__name__)
KNOWLEDGE_ARTIFACT_SOURCE = "knowledge_artifact"
EXECUTOR_ATTACHMENT_METADATA_ONLY_SHELLS = {"ClaudeCode", "Agno", "CodeX", "Codex"}


def _request_shell_type(request: "ExecutionRequest") -> str:
    """Extract the primary shell type from an execution request."""
    if request.bot and isinstance(request.bot[0], dict):
        return str(request.bot[0].get("shell_type") or "Chat")
    return "Chat"


def _should_inline_attachment_content(request: "ExecutionRequest") -> bool:
    """Return whether parsed attachment content should be injected into prompt."""
    if str(request.model_config.get("modelType") or "").lower() == "video":
        # VideoAgent resolves the original uploaded media from the user subtask.
        # Inlining the same images into the prompt makes them count twice.
        return False
    return _request_shell_type(request) not in EXECUTOR_ATTACHMENT_METADATA_ONLY_SHELLS


def _build_executor_attachment_payload(context: Any) -> dict[str, Any]:
    """Serialize an attachment context for executor-side downloading."""
    return {
        "id": context.id,
        "original_filename": context.original_filename,
        "mime_type": context.mime_type,
        "file_size": context.file_size,
        "subtask_id": context.subtask_id,
    }


def _order_contexts_by_attachment_ids(
    contexts: List[Any],
    attachment_ids: Optional[List[int]],
) -> List[Any]:
    """Keep attachment contexts in caller order and preserve remaining contexts."""
    if not attachment_ids:
        return contexts

    contexts_by_id = {
        context.id: context for context in contexts if context.id in attachment_ids
    }
    ordered = [
        contexts_by_id[attachment_id]
        for attachment_id in attachment_ids
        if attachment_id in contexts_by_id
    ]
    ordered_ids = {context.id for context in ordered}
    ordered.extend(context for context in contexts if context.id not in ordered_ids)
    return ordered


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


@trace_async("chat.build_execution_request", tracer_name="backend.chat")
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
    knowledge_base_refs: Optional[List[Dict[str, Any]]] = None,
    reasoning_config: Optional[Dict[str, Any]] = None,
    generation_params: Any = None,
    attachment_ids: Optional[List[int]] = None,
    include_wework_space_mcp: bool = False,
    web_runtime_guidance: Optional[bool] = None,
) -> "ExecutionRequest":
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
        knowledge_base_names: Optional legacy list of KB names in {'namespace': str, 'name': str} format
        knowledge_base_refs: Optional normalized KB refs with optional folder/document scope
        reasoning_config: Optional reasoning config dict with 'effort' and 'summary' keys
        generation_params: Optional request-scoped image or video generation options
        attachment_ids: Optional attachment IDs in caller-defined material order
        include_wework_space_mcp: Whether to expose the Wework board MCP

    Returns:
        ExecutionRequest ready for dispatch
    """
    request = await run_in_threadpool_with_cleanup(
        prepare_execution_request,
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
        enable_web_search=enable_web_search,
        enable_clarification=enable_clarification,
        preload_skills=preload_skills,
        previous_bot_id=previous_bot_id,
        reasoning_config=reasoning_config,
        generation_params=generation_params,
        include_wework_space_mcp=include_wework_space_mcp,
        web_runtime_guidance=web_runtime_guidance,
    )

    from app.services.execution import TaskRequestBuilder

    db = SessionLocal()
    try:
        builder = TaskRequestBuilder(db)
        task_json = task.json if isinstance(task.json, dict) else {}
        metadata = task_json.get("metadata") or {}
        labels = metadata.get("labels") if isinstance(metadata, dict) else {}
        task_labels = labels if isinstance(labels, dict) else {}
        task_refs = extract_task_external_knowledge_refs(task)
        # Process knowledge base refs from API request (OpenAPI v1/responses)
        # This creates SubtaskContext records for KBs specified in the request
        normalized_kb_refs = knowledge_base_refs
        if normalized_kb_refs is None:
            normalized_kb_refs = knowledge_base_names
        processed_subtask_id = None
        if normalized_kb_refs:
            processed_subtask_id = (
                user_subtask_id if user_subtask_id else assistant_subtask.id
            )
            logger.info(
                "[build_execution_request] Will create KB contexts for subtask_id: %d (user_subtask_id was %s)",
                processed_subtask_id,
                str(user_subtask_id),
            )
            await _create_kb_contexts_from_api_request(
                db,
                user.id,
                processed_subtask_id,
                normalized_kb_refs,
                task=task,
                user_name=user.user_name,
            )

        # Process contexts (attachments, knowledge bases, etc.)
        # If we created KB contexts, we need to process them regardless of whether it's user_subtask or assistant subtask
        context_subtask_id = (
            user_subtask_id if user_subtask_id else processed_subtask_id
        )
        current_contexts = []
        if context_subtask_id:
            current_contexts = context_service.get_by_subtask(db, context_subtask_id)

        inherited_external_refs = list(task_refs)
        if inherited_external_refs:
            validate_external_knowledge_refs(
                inherited_external_refs,
                binding_level="conversation",
            )
        request.external_knowledge_refs = inherited_external_refs

        from app.services.chat.selected_knowledge import (
            SUPPORTED_PROVIDER_NATIVE_SHELLS,
            activate_provider_native_knowledge,
            apply_selected_knowledge_context,
            build_inherited_selected_knowledge_refs,
            build_selected_knowledge_context,
            validate_explicit_knowledge_contexts,
        )

        is_knowledge_artifact = task_labels.get("source") == KNOWLEDGE_ARTIFACT_SOURCE
        supports_provider_native = (
            not is_knowledge_artifact
            and _request_shell_type(request) in SUPPORTED_PROVIDER_NATIVE_SHELLS
        )
        selected_knowledge_context = None
        if supports_provider_native:
            inherited_refs = build_inherited_selected_knowledge_refs(
                db,
                task,
                user.id,
                external_refs=inherited_external_refs,
            )
            selected_knowledge_context = build_selected_knowledge_context(
                db,
                request,
                task,
                current_contexts=current_contexts,
                inherited_refs=inherited_refs,
                user_id=user.id,
            )
        elif not is_knowledge_artifact:
            validate_explicit_knowledge_contexts(current_contexts)
        should_apply_provider_native = bool(
            selected_knowledge_context and selected_knowledge_context.refs
        )

        if context_subtask_id:
            process_context_kwargs = {
                "prepare_provider_native_knowledge": should_apply_provider_native,
                "current_contexts": current_contexts,
            }
            if attachment_ids is not None:
                process_context_kwargs["attachment_ids"] = attachment_ids
            request = await _process_contexts(
                db,
                request,
                context_subtask_id,
                user.id,
                **process_context_kwargs,
            )

        provider_skills = []
        if should_apply_provider_native:
            provider_skills = apply_selected_knowledge_context(
                db,
                request,
                task,
                context=selected_knowledge_context,
            )
        unresolved_provider_skills = [
            skill_name
            for skill_name in provider_skills
            if skill_name not in (request.skill_names or [])
        ]
        if unresolved_provider_skills:
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
        activate_provider_native_knowledge(request, provider_skills)

        return request

    finally:
        db.close()


async def _process_contexts(
    db: "Session",
    request: "ExecutionRequest",
    user_subtask_id: int,
    user_id: int,
    *,
    prepare_provider_native_knowledge: bool = False,
    current_contexts: Optional[List["SubtaskContext"]] = None,
    attachment_ids: Optional[List[int]] = None,
) -> "ExecutionRequest":
    """Process contexts (attachments, knowledge bases, etc.) for the request.

    Args:
        db: Database session
        request: ExecutionRequest to enhance
        user_subtask_id: User subtask ID for context retrieval
        user_id: User ID for context retrieval
        prepare_provider_native_knowledge: Whether the resolved knowledge context
            should suppress the legacy KB prompt.

    Returns:
        Enhanced ExecutionRequest with context information
    """
    from app.services.chat.preprocessing import prepare_contexts_for_chat

    if current_contexts is not None:
        current_contexts = _order_contexts_by_attachment_ids(
            current_contexts,
            attachment_ids,
        )

    # Get context_window from model_config for selected_documents injection threshold
    model_context_window = request.model_config.get("context_window")
    inline_attachment_content = _should_inline_attachment_content(request)

    # Process contexts (attachments, knowledge bases, etc.)
    base_system_prompt = request.system_prompt
    ctx = await prepare_contexts_for_chat(
        db=db,
        user_subtask_id=user_subtask_id,
        user_id=user_id,
        message=request.prompt,
        base_system_prompt=request.system_prompt,
        task_id=request.task_id,
        context_window=model_context_window,
        model_config=request.model_config,
        inline_attachment_content=inline_attachment_content,
        contexts=current_contexts,
    )

    # Update request with all processed context results.
    # knowledge_base_ids / is_user_selected_kb / document_ids / kb_meta_prompt are
    # computed inside _prepare_kb_tools_from_contexts and surfaced here - no extra
    # DB queries needed.
    request.prompt = ctx.final_message
    request.system_prompt = (
        base_system_prompt
        if prepare_provider_native_knowledge
        else ctx.kb.enhanced_system_prompt
    )
    request.kb_meta_prompt = (
        "" if prepare_provider_native_knowledge else ctx.kb.kb_meta_prompt
    )
    attachment_contexts = context_service.get_attachments_by_subtask(
        db,
        user_subtask_id,
    )
    attachment_contexts = _order_contexts_by_attachment_ids(
        attachment_contexts,
        attachment_ids,
    )
    request.attachments = [
        _build_executor_attachment_payload(context) for context in attachment_contexts
    ]
    logger.info(
        "[ai_trigger_unified] Executor attachment payload built: "
        "task_id=%d, user_subtask_id=%d, attachment_ids=%s",
        request.task_id,
        user_subtask_id,
        [attachment.get("id") for attachment in request.attachments],
    )
    if ctx.kb.knowledge_base_ids:
        request.provider_native_knowledge = False
        request.knowledge_base_ids = ctx.kb.knowledge_base_ids
        request.knowledge_base_scopes = ctx.kb.knowledge_base_scopes
        request.is_user_selected_kb = ctx.kb.is_user_selected_kb
        request.kb_tool_access_mode = ctx.kb.kb_tool_access_mode
        if ctx.kb.document_ids and not ctx.kb.knowledge_base_scopes:
            request.document_ids = ctx.kb.document_ids
    logger.info(
        "[ai_trigger_unified] Context processing completed: "
        "user_subtask_id=%d, knowledge_base_ids=%s, "
        "attachments=%d, inline_attachment_content=%s",
        user_subtask_id,
        request.knowledge_base_ids,
        len(request.attachments),
        inline_attachment_content,
    )

    return request


async def _create_kb_contexts_from_api_request(
    db: "Session",
    user_id: int,
    user_subtask_id: int,
    knowledge_base_names: List[Dict[str, Any]],
    task=None,
    user_name: Optional[str] = None,
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
        task: Optional task for syncing selected KBs to task-level refs
        user_name: Optional user name used as boundBy during task-level sync
    """
    from app.services.openapi.kb_context import KnowledgeBaseContextCreator

    try:
        creator = KnowledgeBaseContextCreator(db, user_id)
        contexts = creator.create_contexts(
            user_subtask_id,
            knowledge_base_names,
            task=task,
            user_name=user_name,
        )
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
