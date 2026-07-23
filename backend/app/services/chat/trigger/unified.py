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

from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.external_knowledge_refs import (
    extract_task_external_knowledge_refs,
    validate_external_knowledge_refs,
)
from app.services.context import context_service
from app.services.runtime_codex_model import (
    CODEX_RUNTIME_MODEL_ID,
    CODEX_RUNTIME_MODEL_NAME,
)
from app.services.user_runtime_config import (
    UserRuntimeConfigError,
    user_runtime_config_service,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.api.ws.chat_namespace import ChatNamespace
    from app.services.execution.emitters import ResultEmitter
    from shared.models.execution import ExecutionRequest

logger = logging.getLogger(__name__)
SELECTED_KB_PRELOAD_SKILL = "wegent-knowledge"
CODEX_RUNTIME = "codex"
RUNTIME_MODEL_TYPE = "runtime"
EXECUTOR_ATTACHMENT_METADATA_ONLY_SHELLS = {"ClaudeCode", "Agno", "CodeX", "Codex"}
SERVICE_TIER_ALIASES = {
    "fast": "priority",
    "priority": "priority",
    "快速": "priority",
    "运行快速": "priority",
    "standard": "default",
    "default": "default",
    "普通": "default",
    "标准": "default",
    "运行标准": "default",
}


def _request_shell_type(request: "ExecutionRequest") -> str:
    """Extract the primary shell type from an execution request."""
    if request.bot and isinstance(request.bot[0], dict):
        return str(request.bot[0].get("shell_type") or "")
    return ""


def _should_inline_attachment_content(request: "ExecutionRequest") -> bool:
    """Return whether parsed attachment content should be injected into prompt."""
    return _request_shell_type(request) not in EXECUTOR_ATTACHMENT_METADATA_ONLY_SHELLS


def _reasoning_from_model_options(payload: Any) -> Optional[Dict[str, Any]]:
    """Convert UI model options into execution reasoning config."""
    if payload is None:
        return None
    model_options = getattr(payload, "model_options", None)
    if not isinstance(model_options, dict):
        return None
    reasoning = model_options.get("reasoning")
    summary = model_options.get("summary")
    if not reasoning and not summary:
        return None

    result: Dict[str, Any] = {}
    if isinstance(reasoning, dict):
        effort = reasoning.get("effort") or reasoning.get("reasoning")
        summary = summary or reasoning.get("summary")
    else:
        effort = reasoning

    if effort:
        result["effort"] = str(effort)
    if summary:
        result["summary"] = str(summary)
    return result or None


def _service_tier_from_model_options(payload: Any) -> Optional[str]:
    """Convert UI speed options into Codex service tier values."""
    if payload is None:
        return None
    model_options = getattr(payload, "model_options", None)
    if not isinstance(model_options, dict):
        return None

    speed = model_options.get("speed") or model_options.get("service_tier")
    if isinstance(speed, dict):
        speed = speed.get("value") or speed.get("speed") or speed.get("service_tier")
    if not speed:
        return None

    return SERVICE_TIER_ALIASES.get(str(speed).strip().lower())


def _model_options_from_payload(payload: Any) -> Optional[Dict[str, Any]]:
    """Return model_options dict from a chat send payload, if present."""
    if payload is None:
        return None
    model_options = getattr(payload, "model_options", None)
    if isinstance(model_options, dict):
        return model_options
    return None


def _model_options_from_task(task: TaskResource) -> Optional[Dict[str, Any]]:
    """Return model_options dict persisted in task metadata labels."""
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = task_json.get("metadata") or {}
    if not isinstance(metadata, dict):
        return None
    labels = metadata.get("labels") or {}
    if not isinstance(labels, dict):
        return None
    model_options_raw = labels.get("modelOptions")
    if not model_options_raw:
        return None
    if isinstance(model_options_raw, dict):
        return model_options_raw
    try:
        import json as json_lib

        return json_lib.loads(model_options_raw)
    except Exception:
        return None


def _catalog_model_id_from_model_options(
    model_options: Optional[Dict[str, Any]],
) -> Optional[str]:
    """Extract catalog model id override from UI model options."""
    if not model_options:
        return None
    catalog_id = (
        model_options.get("weworkCloudModelCatalogModelId")
        or model_options.get("codex_catalog_model_id")
        or model_options.get("codexCatalogModelId")
    )
    if isinstance(catalog_id, str) and catalog_id.strip():
        return catalog_id.strip()
    return None


def _should_ignore_unavailable_task_model_override(payload: Any) -> bool:
    """Return whether a caller can fall back when task model labels are stale."""
    return bool(
        payload is not None
        and getattr(payload, "ignore_unavailable_task_model_override", False)
    )


def _task_model_override_available(
    db: "Session",
    *,
    model_name: str,
    user_id: int,
) -> bool:
    """Return whether the task-level model override resolves as a Model CRD."""
    from app.services.chat.config.model_resolver import _find_model_with_namespace

    _model_kind, model_spec = _find_model_with_namespace(db, model_name, user_id)
    return model_spec is not None


def _model_has_explicit_provider_credentials(model_config: Dict[str, Any]) -> bool:
    """Return True when the model config already carries its own endpoint credentials."""
    base_url = str(model_config.get("base_url") or "").strip()
    api_key = str(model_config.get("api_key") or "").strip()
    return bool(base_url) and bool(api_key)


def _build_codex_runtime_model_config(
    model_name: str,
    model_options: Optional[Dict[str, Any]] = None,
    db: Optional["Session"] = None,
    user_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Build a Codex-compatible model config for Wework runtime models.

    When the requested name matches a Wegent Model CRD, the full model config
    (model_id, base_url, api_key, default_headers, etc.) is extracted from the
    CRD so that third-party Codex providers receive the same credentials the
    Wegent web frontend would use. Otherwise a minimal runtime config is built
    for runtime-only or official Codex models.

    """
    requested_name = model_name
    options = model_options or {}
    provider_id = options.get("codexProviderId") or options.get("codex_model_provider")
    provider_name = options.get("codexProviderName") or options.get(
        "codex_provider_name"
    )
    catalog_model_id = _catalog_model_id_from_model_options(options)

    # Official Codex runtime model: keep the existing minimal config.
    if model_name == CODEX_RUNTIME_MODEL_NAME:
        config: Dict[str, Any] = {
            "model": "openai",
            "model_id": CODEX_RUNTIME_MODEL_ID,
            "api_format": "responses",
            "protocol": "openai-responses",
        }
        if provider_id:
            config["model_provider"] = str(provider_id)
        if provider_name:
            config["provider_name"] = str(provider_name)
        if catalog_model_id:
            config["codex_catalog_model_id"] = catalog_model_id
        return config

    resolved_config: Optional[Dict[str, Any]] = None
    if db is not None and user_id is not None:
        try:
            from app.services.chat.config.model_resolver import (
                _extract_model_config,
                _find_model_with_namespace,
            )

            _kind, model_spec = _find_model_with_namespace(db, model_name, user_id)
            if model_spec:
                full_config = _extract_model_config(model_spec)
                resolved_config = {
                    "model": "openai",
                    "model_id": str(full_config.get("model_id") or model_name),
                    "api_format": "responses",
                    "protocol": "openai-responses",
                    "base_url": str(full_config.get("base_url") or "").strip(),
                    "api_key": str(full_config.get("api_key") or "").strip(),
                }
                if full_config.get("default_headers"):
                    resolved_config["default_headers"] = dict(
                        full_config["default_headers"]
                    )
                if full_config.get("context_window") is not None:
                    resolved_config["context_window"] = full_config["context_window"]
                if full_config.get("max_output_tokens") is not None:
                    resolved_config["max_output_tokens"] = full_config[
                        "max_output_tokens"
                    ]
                if full_config.get("temperature") is not None:
                    resolved_config["temperature"] = full_config["temperature"]
                if full_config.get("think_config"):
                    resolved_config["think_config"] = dict(full_config["think_config"])
        except Exception:
            pass

    if resolved_config is None:
        resolved_config = {
            "model": "openai",
            "model_id": model_name,
            "api_format": "responses",
            "protocol": "openai-responses",
        }

    if provider_id:
        resolved_config["model_provider"] = str(provider_id)
    if provider_name:
        resolved_config["provider_name"] = str(provider_name)
    if catalog_model_id:
        resolved_config["codex_catalog_model_id"] = catalog_model_id
    return resolved_config


def _is_codex_model_config(model_config: Dict[str, Any]) -> bool:
    model_type = str(model_config.get("model") or "").lower()
    api_format = str(
        model_config.get("api_format") or model_config.get("apiFormat") or ""
    ).lower()
    protocol = str(model_config.get("protocol") or "").lower()
    wire_api = str(model_config.get("wire_api") or "").lower()

    return model_type == "openai" and (
        api_format == "responses"
        or protocol == "openai-responses"
        or wire_api == "responses"
    )


def _apply_user_runtime_config(
    db: "Session",
    request: "ExecutionRequest",
    user: User,
) -> Optional[Dict[str, Any]]:
    """Attach user runtime config status to model_config for executor routing.

    If the selected model already carries explicit endpoint credentials (base_url +
    api_key), keep the user's Codex auth.json synced to the device for convenience
    but do not override the request with use_user_config. This lets Wegent-managed
    third-party Codex models use their own credentials instead of being shadowed by
    the user's personal auth.json.
    """
    if not _is_codex_model_config(request.model_config):
        return None

    try:
        status = user_runtime_config_service.get_execution_config(
            db,
            user_id=user.id,
            runtime=CODEX_RUNTIME,
            preferences=getattr(user, "preferences", None),
        )
    except UserRuntimeConfigError:
        logger.exception(
            "[build_execution_request] Failed to resolve user runtime config"
        )
        return None

    has_credentials = _model_has_explicit_provider_credentials(request.model_config)
    prefer_user_config = bool(status.get("use_user_config")) and not has_credentials

    runtime_config = dict(request.model_config.get("runtime_config") or {})
    runtime_config[CODEX_RUNTIME] = {
        "use_user_config": prefer_user_config,
        "configured": bool(status.get("configured")),
        "target_path": status.get("target_path"),
        "auth_json_sha256": status.get("auth_json_sha256"),
        "use_proxy": bool(status.get("use_proxy")),
        "proxy_configured": bool(status.get("proxy_configured")),
    }
    if status.get("proxy_url"):
        proxy = dict(request.model_config.get("proxy") or {})
        proxy["url"] = status["proxy_url"]
        request.model_config["proxy"] = proxy
    request.model_config["runtime_config"] = runtime_config
    return status


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
    knowledge_base_refs: Optional[List[Dict[str, Any]]] = None,
    reasoning_config: Optional[Dict[str, Any]] = None,
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
        knowledge_base_names: Optional legacy list of KB names in {'namespace': str, 'name': str} format
        knowledge_base_refs: Optional normalized KB refs with optional folder/document scope
        reasoning_config: Optional reasoning config dict with 'effort' and 'summary' keys

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
                preload_skills = list(preload_skills or []) + list(additional_skills)
        web_runtime_guidance = (
            payload is not None
            and getattr(payload, "client_origin", None) == CLIENT_ORIGIN_FRONTEND
        )

        # Extract model override from task metadata labels
        # This is where force_override_bot_model is stored when task is created
        override_model_name = None
        override_model_type = None
        force_override = False
        runtime_model_config = None
        task_json = task.json if isinstance(task.json, dict) else {}
        metadata = task_json.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        labels = metadata.get("labels") or {}
        task_labels = labels if isinstance(labels, dict) else {}
        if task_labels:
            override_model_name = task_labels.get("modelId")
            override_model_type = task_labels.get("forceOverrideBotModelType")
            force_override = task_labels.get("forceOverrideBotModel") == "true"
            logger.info(
                "[build_execution_request] Extracted model override from task labels: "
                "modelId=%s, forceOverrideBotModel=%s, forceOverrideBotModelType=%s",
                override_model_name,
                force_override,
                override_model_type,
            )

        # Extract model options from payload or task labels (retry path may not have payload)
        model_options = _model_options_from_payload(
            payload
        ) or _model_options_from_task(task)
        catalog_model_id = _catalog_model_id_from_model_options(model_options)
        if catalog_model_id:
            logger.info(
                "[build_execution_request] Extracted catalog model id override: %s",
                catalog_model_id,
            )

        if (
            force_override
            and override_model_name
            and (override_model_type == RUNTIME_MODEL_TYPE)
        ):
            runtime_model_config = _build_codex_runtime_model_config(
                override_model_name,
                model_options=model_options,
                db=db,
                user_id=user.id,
            )
            logger.info(
                "[build_execution_request] Using runtime model config: "
                "selectedModel=%s, executorModel=%s",
                override_model_name,
                runtime_model_config.get("model_id"),
            )
            override_model_name = None
            force_override = False
        elif (
            force_override
            and override_model_name
            and _should_ignore_unavailable_task_model_override(payload)
            and not _task_model_override_available(
                db,
                model_name=override_model_name,
                user_id=user.id,
            )
        ):
            logger.info(
                "[build_execution_request] Ignoring unavailable task model "
                "override for payload fallback: modelId=%s",
                override_model_name,
            )
            override_model_name = None
            force_override = False

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
            web_runtime_guidance=web_runtime_guidance,
            runtime_model_config=runtime_model_config,
        )
        request.device_id = device_id or request.device_id
        # Task spec is the runtime source of truth. Message-level external
        # contexts are materialized into Task.spec before execution is built.
        task_refs = extract_task_external_knowledge_refs(task)
        if task_refs:
            validate_external_knowledge_refs(
                task_refs,
                binding_level="conversation",
            )
            request.external_knowledge_refs = task_refs

        # Merge reasoning config from API/model selection into model_config.
        # Priority: explicit API reasoning_config > UI model_options > model think_config.
        selected_reasoning_config = reasoning_config or _reasoning_from_model_options(
            payload
        )
        if selected_reasoning_config:
            request.model_config["reasoning"] = selected_reasoning_config
            logger.info(
                "[build_execution_request] Applied selected reasoning config: %s",
                selected_reasoning_config,
            )
        elif request.model_config.get("think_config"):
            # If no API reasoning_config but model has think_config, use it
            request.model_config["reasoning"] = request.model_config["think_config"]
            logger.info(
                "[build_execution_request] Applied reasoning config from model think_config: %s",
                request.model_config["think_config"],
            )

        selected_service_tier = _service_tier_from_model_options(payload)
        if selected_service_tier:
            request.model_config["service_tier"] = selected_service_tier
            logger.info(
                "[build_execution_request] Applied selected service tier: %s",
                selected_service_tier,
            )

        _apply_user_runtime_config(db, request, user)

        # Apply UI-selected or Model CRD catalog model id override for Codex-compatible models.
        effective_catalog_model_id = catalog_model_id or request.model_config.get(
            "codex_catalog_model_id"
        )
        if effective_catalog_model_id and _is_codex_model_config(request.model_config):
            request.model_config["codex_catalog_model_id"] = effective_catalog_model_id
            request.model_config["codex_responses_compat_proxy"] = True
            logger.info(
                "[build_execution_request] Applied catalog model id override: %s",
                effective_catalog_model_id,
            )

        # Store reasoning_config in ExecutionRequest for downstream access
        request.reasoning_config = (
            selected_reasoning_config or request.model_config.get("reasoning")
        )

        if payload is not None:
            interactive_form_answer = getattr(payload, "interactive_form_answer", None)
            if interactive_form_answer:
                if hasattr(interactive_form_answer, "model_dump"):
                    request.interactive_form_answer = (
                        interactive_form_answer.model_dump(mode="json")
                    )
                elif isinstance(interactive_form_answer, dict):
                    request.interactive_form_answer = dict(interactive_form_answer)

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
    inline_attachment_content = _should_inline_attachment_content(request)

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
        inline_attachment_content=inline_attachment_content,
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
    logger.info(
        "[ai_trigger_unified] Executor attachment payload built: "
        "task_id=%d, user_subtask_id=%d, attachment_ids=%s",
        request.task_id,
        user_subtask_id,
        [attachment.get("id") for attachment in request.attachments],
    )
    if ctx.kb.knowledge_base_ids:
        request.knowledge_base_ids = ctx.kb.knowledge_base_ids
        request.knowledge_base_scopes = ctx.kb.knowledge_base_scopes
        request.is_user_selected_kb = ctx.kb.is_user_selected_kb
        request.kb_tool_access_mode = ctx.kb.kb_tool_access_mode
        if ctx.kb.document_ids and not ctx.kb.knowledge_base_scopes:
            request.document_ids = ctx.kb.document_ids
        _ensure_selected_kb_skill_priority(request)

    logger.info(
        "[ai_trigger_unified] Context processing completed: "
        "user_subtask_id=%d, knowledge_base_ids=%s, table_contexts_count=%d, "
        "attachments=%d, inline_attachment_content=%s",
        user_subtask_id,
        request.knowledge_base_ids,
        len(ctx.table_contexts),
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
