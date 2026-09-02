# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.

This module uses the unified trigger architecture:
- setup_chat_session: Creates task and subtasks
- build_execution_request: Builds ExecutionRequest using TaskRequestBuilder
- OpenAPIWorkerClient: Sends prepared requests to the stream worker over bounded UDS
"""

import copy
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter
from sqlalchemy.orm import Session

from app.core import security
from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.core.rate_limit import get_limiter, nonblocking_limit
from app.core.request_body_limit import OPENAPI_RESPONSES_BODY_MAX_BYTES
from app.core.request_json import validate_json_request
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
from app.services.execution.stream_client import (
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
)
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import SUBTASK_RECOVERY_EXECUTE
from app.services.openapi.helpers import (
    extract_input_text,
    parse_model_string,
    parse_wegent_tools,
    wegent_status_to_openai_status,
)
from app.services.openapi.output_builder import (
    build_response_output,
    extract_pending_user_input_state,
)
from app.services.rag.sources import ExternalRefValidationError
from app.services.readers.kinds import KindType, kindReader
from app.stores.tasks import subtask_store, task_access_store, task_store
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
    trace_async_generator,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Get rate limiter instance
limiter = get_limiter()
_RESPONSE_CREATE_VALIDATOR = TypeAdapter(ResponseCreateInput)


async def _decode_response_create_request(request: Request) -> ResponseCreateInput:
    return await validate_json_request(
        request,
        _RESPONSE_CREATE_VALIDATOR,
        max_bytes=OPENAPI_RESPONSES_BODY_MAX_BYTES,
    )


@dataclass(frozen=True)
class _OpenAPIUser:
    """Authenticated user fields safe to retain outside the auth DB session."""

    id: int
    user_name: str


@dataclass(frozen=True)
class _OpenAPIAuthContext:
    user: _OpenAPIUser
    api_key_name: Optional[str]


async def _get_openapi_auth_context(
    auth_context: security.DetachedAuthContext = Depends(
        security.get_detached_auth_context
    ),
) -> _OpenAPIAuthContext:
    """Detach auth fields before OpenAPI async orchestration begins."""
    return _OpenAPIAuthContext(
        user=_OpenAPIUser(
            id=int(auth_context.user.id),
            user_name=str(auth_context.user.user_name),
        ),
        api_key_name=auth_context.api_key_name,
    )


async def _get_openapi_user(
    auth_context: security.DetachedAuthContext = Depends(
        security.get_detached_auth_context
    ),
) -> _OpenAPIUser:
    return _OpenAPIUser(
        id=int(auth_context.user.id),
        user_name=str(auth_context.user.user_name),
    )


@dataclass(frozen=True)
class _ValidatedResponseTarget:
    team_id: int
    model_info: Dict[str, Any]


@dataclass(frozen=True)
class _PreparedResponseSession:
    task_id: int
    user_subtask_id: int
    assistant_subtask_id: int
    linked_attachment_ids: Optional[list[int]]
    current_kb_refs: list[dict]
    enable_tools: bool
    enable_chat_bot: bool
    preload_skills: list[Any]
    memory_save_request: Optional[Dict[str, Any]]


@dataclass(frozen=True)
class _SubtaskView:
    id: int
    role: Any
    status: Any
    result: Any


@dataclass(frozen=True)
class _CancelResponsePlan:
    is_chat_shell: bool
    source_label: Optional[str]
    model_string: str
    running_subtask_id: Optional[int]
    call_executor_cancel: bool


@dataclass(frozen=True)
class _DeleteResponsePlan:
    running_subtask_id: Optional[int]


async def _run_sync(callable_obj: Any, /, *args: Any, **kwargs: Any) -> Any:
    """Run a synchronous OpenAPI preparation step in the shared DB pool."""
    from app.services.chat.storage.db import run_sync_in_executor

    return await run_sync_in_executor(partial(callable_obj, *args, **kwargs))


def _worker_session() -> Any:
    """Create a fresh Session owned exclusively by one worker invocation."""
    from app.db.session import get_db_session

    return get_db_session()


def _dump_model(value: Any) -> dict[str, Any]:
    return value.model_dump()


def _prepare_response_request_payload(
    request_body: ResponseCreateInput,
) -> tuple[Dict[str, Any], Dict[str, Any], str]:
    return (
        parse_model_string(request_body.model),
        parse_wegent_tools(request_body.tools),
        extract_input_text(request_body.input),
    )


def _normalize_auto_delete_executor_header(value: Optional[str]) -> Optional[str]:
    """Normalize auto-delete header values to task label strings."""
    if value is None:
        return None

    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return "true"
    if normalized in {"false", "0", "no", "off", ""}:
        return "false"

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid auto_delete_executor header value. Expected true or false.",
    )


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
    pending_user_input, pending_user_input_payload = extract_pending_user_input_state(
        _latest_assistant_subtask(subtasks or [])
    )

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
        pending_user_input=pending_user_input or None,
        pending_user_input_payload=pending_user_input_payload,
        previous_response_id=previous_response_id,
    )


def _filter_current_assistant_turn(
    subtasks: list[Subtask],
    assistant_subtask_id: int,
) -> list[Subtask]:
    return [subtask for subtask in subtasks if subtask.id == assistant_subtask_id]


def _project_current_response(
    response_id: str,
    created_at: int,
    response_status: str,
    model: str,
    subtasks: list[_SubtaskView],
    assistant_subtask_id: int,
    assistant_status: str,
    assistant_content: Optional[str],
    previous_response_id: Optional[str],
) -> ResponseObject:
    """Build one potentially large OpenAPI response in the codec worker."""
    current_subtasks = _filter_current_assistant_turn(
        subtasks,
        assistant_subtask_id,
    )
    pending_user_input, pending_user_input_payload = extract_pending_user_input_state(
        current_subtasks
    )
    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status=response_status,
        model=model,
        output=build_response_output(
            current_subtasks,
            active_assistant_subtask_id=assistant_subtask_id,
            active_assistant_status=assistant_status,
            active_assistant_content=assistant_content,
        ),
        pending_user_input=pending_user_input or None,
        pending_user_input_payload=pending_user_input_payload,
        previous_response_id=previous_response_id,
    )


async def _project_current_response_nonblocking(
    *,
    response_id: str,
    created_at: int,
    response_status: str,
    model: str,
    subtasks: list[_SubtaskView],
    assistant_subtask_id: int,
    assistant_status: str,
    assistant_content: Optional[str] = None,
    previous_response_id: Optional[str] = None,
) -> ResponseObject:
    return await run_payload_codec(
        _project_current_response,
        response_id,
        created_at,
        response_status,
        model,
        subtasks,
        assistant_subtask_id,
        assistant_status,
        assistant_content,
        previous_response_id,
        payload_hint=subtasks,
        force_offload=True,
    )


def _latest_assistant_subtask(subtasks: list[Subtask]) -> list[Subtask]:
    for subtask in reversed(subtasks or []):
        if subtask.role == SubtaskRole.ASSISTANT:
            return [subtask]
    return []


def _get_current_knowledge_base_refs(tool_settings: Dict[str, Any]) -> list[dict]:
    """Return explicitly requested normalized KB refs from the current request."""
    refs = tool_settings.get("knowledge_base_refs") or []
    return refs if isinstance(refs, list) else []


def _get_inherited_knowledge_base_refs(
    *,
    task: TaskResource,
    current_refs: list[dict],
) -> list[dict]:
    """Return task-level API KB scopes only when the current request has no KB refs."""
    if current_refs:
        return []

    from app.services.openapi.kb_context import get_task_knowledge_base_scope_refs

    return get_task_knowledge_base_scope_refs(task)


def _exception_message(exc: HTTPException) -> str:
    """Convert HTTPException detail to a readable persisted error message."""
    if isinstance(exc.detail, str):
        return exc.detail
    return json.dumps(exc.detail, ensure_ascii=False)


def _model_category_from_kind(model: Any) -> str:
    """Return the normalized model category stored in a Model CRD."""
    model_json = model.json if model and isinstance(model.json, dict) else {}
    spec = model_json.get("spec") if isinstance(model_json, dict) else {}
    if not isinstance(spec, dict):
        return "llm"
    model_type = spec.get("modelType") or "llm"
    return str(getattr(model_type, "value", model_type)).strip().lower()


def _generation_options(request_body: ResponseCreateInput) -> Any:
    wegent_options = getattr(request_body, "wegent_options", None)
    return getattr(wegent_options, "generation", None)


def _generation_options_dict(
    request_body: ResponseCreateInput,
) -> Optional[Dict[str, Any]]:
    generation_options = _generation_options(request_body)
    if generation_options is None:
        return None
    return generation_options.model_dump(exclude_none=True)


def _validate_response_target_sync(
    *,
    user_id: int,
    model_info: Dict[str, Any],
    previous_task_id: Optional[int],
) -> _ValidatedResponseTarget:
    """Validate conversation, team, bots, and model in a worker-owned session."""
    model_info = dict(model_info)
    with _worker_session() as db:
        if previous_task_id is not None:
            existing_task = task_store.get_task_by_states(
                db,
                task_id=previous_task_id,
                states=[TaskResource.STATE_ACTIVE],
                owner_user_id=user_id,
            )
            if not existing_task:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Previous response 'resp_{previous_task_id}' not found",
                )

        team = kindReader.get_by_name_and_namespace(
            db,
            user_id,
            KindType.TEAM,
            model_info["namespace"],
            model_info["team_name"],
        )
        if not team:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=(
                    f"Team '{model_info['namespace']}#"
                    f"{model_info['team_name']}' not found or not accessible"
                ),
            )

        if model_info.get("model_id"):
            _validate_explicit_response_model(db, user_id, model_info)
        else:
            _validate_team_response_models(db, user_id, team, model_info)

        return _ValidatedResponseTarget(team_id=team.id, model_info=model_info)


def _validate_explicit_response_model(
    db: Session,
    user_id: int,
    model_info: Dict[str, Any],
) -> None:
    model_name = model_info["model_id"]
    model_namespace = model_info["namespace"]
    model = kindReader.get_by_name_and_namespace(
        db,
        user_id,
        KindType.MODEL,
        model_namespace,
        model_name,
    )
    if not model and model_namespace != "default":
        model = kindReader.get_by_name_and_namespace(
            db,
            user_id,
            KindType.MODEL,
            "default",
            model_name,
        )
    if not model:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Model '{model_namespace}/{model_name}' not found",
        )
    model_info["model_type"] = _model_category_from_kind(model)


def _validate_team_response_models(
    db: Session,
    user_id: int,
    team: Any,
    model_info: Dict[str, Any],
) -> None:
    team_crd = Team.model_validate(team.json)
    if not team_crd.spec.members:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Team '{model_info['namespace']}#"
                f"{model_info['team_name']}' has no members configured"
            ),
        )

    for member_index, member in enumerate(team_crd.spec.members):
        bot_ref = member.botRef
        if not bot_ref.name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Team '{model_info['namespace']}#"
                    f"{model_info['team_name']}' has invalid bot reference"
                ),
            )
        bot_kind = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            bot_ref.namespace,
            bot_ref.name,
        )
        if not bot_kind:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Bot '{bot_ref.namespace}/{bot_ref.name}' not found",
            )
        bot_crd = Bot.model_validate(bot_kind.json)
        model_ref = bot_crd.spec.modelRef
        if not model_ref or not model_ref.name or not model_ref.namespace:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Bot '{bot_ref.namespace}/{bot_ref.name}' does not have a "
                    "valid model configured. Please specify model_id in the request "
                    "or configure modelRef for the bot."
                ),
            )
        if member_index == 0:
            default_model = kindReader.get_by_name_and_namespace(
                db,
                user_id,
                KindType.MODEL,
                model_ref.namespace,
                model_ref.name,
            )
            if default_model:
                model_info["model_type"] = _model_category_from_kind(default_model)


def _prepare_response_session_sync(
    *,
    user_id: int,
    team_id: int,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int],
    api_key_name: Optional[str],
    auto_delete_executor: Optional[str],
) -> _PreparedResponseSession:
    """Create chat records and attachment links without touching Uvicorn's loop."""
    from app.models.kind import Kind
    from app.services.openapi.chat_session import setup_chat_session

    with _worker_session() as db:
        user = db.get(User, user_id)
        team = db.get(Kind, team_id)
        if user is None or team is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User or team no longer exists",
            )

        setup = setup_chat_session(
            db,
            user,
            team,
            model_info,
            input_text,
            tool_settings,
            task_id,
            api_key_name,
            auto_delete_executor,
            generation_params=_generation_options_dict(request_body),
            defer_memory_save=True,
        )
        current_kb_refs = _get_current_knowledge_base_refs(tool_settings)
        inherited_kb_refs = _get_inherited_knowledge_base_refs(
            task=setup.task,
            current_refs=current_kb_refs,
        )
        enable_chat_bot = tool_settings.get("enable_chat_bot", False)
        enable_tools = (
            enable_chat_bot or bool(current_kb_refs) or bool(inherited_kb_refs)
        )

        linked_attachment_ids = None
        if request_body.attachment_ids:
            linked_attachment_ids = link_contexts_to_subtask(
                db=db,
                subtask_id=setup.user_subtask.id,
                user_id=user_id,
                attachment_ids=request_body.attachment_ids,
                task=setup.task,
            )

        return _PreparedResponseSession(
            task_id=setup.task_id,
            user_subtask_id=setup.user_subtask.id,
            assistant_subtask_id=setup.assistant_subtask.id,
            linked_attachment_ids=linked_attachment_ids,
            current_kb_refs=current_kb_refs,
            enable_tools=enable_tools,
            enable_chat_bot=enable_chat_bot,
            preload_skills=tool_settings.get("preload_skills", []),
            memory_save_request=getattr(setup, "memory_save_request", None),
        )


def _query_subtask_views_sync(
    *,
    task_id: int,
    user_id: int,
) -> list[_SubtaskView]:
    """Load only response-output fields and detach them from SQLAlchemy."""
    with _worker_session() as db:
        subtasks = subtask_store.list_by_task_for_user_ordered(
            db,
            task_id=task_id,
            user_id=user_id,
        )
        return [
            _SubtaskView(
                id=subtask.id,
                role=subtask.role,
                status=subtask.status,
                result=copy.deepcopy(subtask.result),
            )
            for subtask in subtasks
        ]


def _model_string_from_task_json(task_json: Any) -> str:
    if not isinstance(task_json, dict):
        return "unknown"
    task_crd = Task.model_validate(task_json)
    team_ref = task_crd.spec.teamRef
    model_id = (
        task_crd.metadata.labels.get("modelId") if task_crd.metadata.labels else None
    )
    model_string = f"{team_ref.namespace}#{team_ref.name}"
    return f"{model_string}#{model_id}" if model_id else model_string


def _parse_response_task_id(
    response_id: str,
    *,
    include_expected_format: bool = False,
) -> int:
    if not response_id.startswith("resp_"):
        detail = f"Invalid response_id format: '{response_id}'"
        if include_expected_format:
            detail += ". Expected format: 'resp_{task_id}'"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        )
    try:
        return int(response_id[5:])
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        ) from exc


def _response_object_from_db(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    model_string: Optional[str] = None,
) -> ResponseObject:
    task_dict = task_kinds_service.get_task_by_id(
        db,
        task_id=task_id,
        user_id=user_id,
    )
    subtasks = subtask_store.list_by_task_for_user_ordered(
        db,
        task_id=task_id,
        user_id=user_id,
    )
    if model_string is None:
        task = task_store.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE],
            owner_user_id=user_id,
        )
        model_string = _model_string_from_task_json(task.json if task else None)
    return _task_to_response_object(task_dict, model_string, subtasks=subtasks)


def _get_response_sync(
    *,
    task_id: int,
    user_id: int,
    response_id: str,
) -> ResponseObject:
    """Load and serialize one response in a worker-owned session."""
    with _worker_session() as db:
        try:
            return _response_object_from_db(
                db,
                task_id=task_id,
                user_id=user_id,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Response '{response_id}' not found",
                ) from exc
            raise


def _get_accessible_active_task(
    db: Session,
    *,
    task_id: int,
    user_id: int,
) -> Optional[TaskResource]:
    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=[TaskResource.STATE_ACTIVE],
        owner_user_id=user_id,
    )
    if task is not None:
        return task
    member_task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=[TaskResource.STATE_ACTIVE],
    )
    if member_task and task_access_store.is_member(
        db,
        task_id=task_id,
        user_id=user_id,
    ):
        return member_task
    return None


def _cancel_executor_response_sync(
    db: Session,
    *,
    task_id: int,
    user_id: int,
) -> bool:
    """Persist an executor cancellation and return whether to call its runtime."""
    from app.schemas.task import TaskUpdate

    task_dict = task_kinds_service.get_task_detail(
        db=db,
        task_id=task_id,
        user_id=user_id,
    )
    if not task_dict:
        raise HTTPException(status_code=404, detail="Task not found")

    current_status = task_dict.get("status", "")
    if current_status in {"COMPLETED", "FAILED", "CANCELLED", "DELETE"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(f"Task is already {current_status.lower()}, cannot cancel"),
        )
    if current_status == "CANCELLING":
        return False

    try:
        task_kinds_service.update_task(
            db=db,
            task_id=task_id,
            obj_in=TaskUpdate(status="CANCELLED"),
            user_id=user_id,
        )
    except Exception as exc:
        logger.error("Failed to update task %s status to CANCELLED: %s", task_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update task status: {str(exc)}",
        ) from exc
    return True


def _running_response_subtask_id(
    db: Session,
    *,
    task_id: int,
    user_id: int,
) -> Optional[int]:
    subtask = subtask_store.get_latest_assistant_for_user_by_statuses(
        db,
        task_id=task_id,
        user_id=user_id,
        statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
    )
    return subtask.id if subtask else None


def _prepare_cancel_response_sync(
    *,
    task_id: int,
    user_id: int,
    response_id: str,
) -> _CancelResponsePlan:
    """Validate cancellation and persist the non-chat cancellation phase."""
    with _worker_session() as db:
        task = _get_accessible_active_task(db, task_id=task_id, user_id=user_id)
        if task is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Response '{response_id}' not found",
            )

        task_crd = Task.model_validate(task.json)
        source_label = (
            task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
        )
        is_chat_shell = source_label == "chat_shell"
        running_subtask_id = None
        call_executor_cancel = False
        if is_chat_shell:
            running_subtask_id = _running_response_subtask_id(
                db,
                task_id=task_id,
                user_id=user_id,
            )
        else:
            try:
                call_executor_cancel = _cancel_executor_response_sync(
                    db,
                    task_id=task_id,
                    user_id=user_id,
                )
            except HTTPException as exc:
                if exc.status_code == status.HTTP_404_NOT_FOUND:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"Response '{response_id}' not found",
                    ) from exc
                raise

        return _CancelResponsePlan(
            is_chat_shell=is_chat_shell,
            source_label=source_label,
            model_string=_model_string_from_task_json(task.json),
            running_subtask_id=running_subtask_id,
            call_executor_cancel=call_executor_cancel,
        )


def _complete_chat_cancel_sync(
    *,
    task_id: int,
    user_id: int,
    subtask_id: int,
    partial_content: Optional[str],
) -> None:
    """Persist Chat Shell cancellation after async Redis coordination."""
    with _worker_session() as db:
        task = _get_accessible_active_task(db, task_id=task_id, user_id=user_id)
        subtask = subtask_store.get_basic_by_id(
            db,
            subtask_id=subtask_id,
            owner_user_id=user_id,
        )
        if task is None or subtask is None or subtask.task_id != task_id:
            return

        subtask_store.update_fields(
            db,
            subtask=subtask,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            completed_at=datetime.now(),
            result={"value": partial_content or ""},
        )
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            completed_at = datetime.now()
            task_crd.status.status = "COMPLETED"
            task_crd.status.errorMessage = ""
            task_crd.status.updatedAt = completed_at
            task_crd.status.completedAt = completed_at
            task_crd.status.result = {"value": partial_content or ""}
        task_store.update_json(
            db,
            task=task,
            payload=task_crd.model_dump(mode="json"),
        )
        db.commit()


def _build_cancel_response_sync(
    *,
    task_id: int,
    user_id: int,
    response_id: str,
    model_string: str,
) -> ResponseObject:
    """Serialize the post-cancellation state without leaking ORM objects."""
    with _worker_session() as db:
        try:
            return _response_object_from_db(
                db,
                task_id=task_id,
                user_id=user_id,
                model_string=model_string,
            )
        except HTTPException:
            return ResponseObject(
                id=response_id,
                created_at=int(datetime.now().timestamp()),
                status="cancelled",
                model="unknown",
                output=[],
            )


def _prepare_delete_response_sync(
    *,
    task_id: int,
    user_id: int,
) -> _DeleteResponsePlan:
    """Find the only stream that must be stopped before task deletion."""
    with _worker_session() as db:
        task = task_store.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE],
            owner_user_id=user_id,
        )
        if task is None:
            return _DeleteResponsePlan(running_subtask_id=None)
        task_crd = Task.model_validate(task.json)
        source_label = (
            task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
        )
        if source_label != "chat_shell":
            return _DeleteResponsePlan(running_subtask_id=None)
        return _DeleteResponsePlan(
            running_subtask_id=_running_response_subtask_id(
                db,
                task_id=task_id,
                user_id=user_id,
            ),
        )


def _delete_response_sync(
    *,
    task_id: int,
    user_id: int,
    response_id: str,
) -> ResponseDeletedObject:
    """Delete one response using a worker-owned database session."""
    with _worker_session() as db:
        try:
            task_kinds_service.delete_task(
                db,
                task_id=task_id,
                user_id=user_id,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Response '{response_id}' not found",
                ) from exc
            raise
    return ResponseDeletedObject(id=response_id)


async def _apply_cancel_response_plan(
    *,
    plan: _CancelResponsePlan,
    session_manager: Any,
    background_tasks: BackgroundTasks,
    task_id: int,
    user_id: int,
) -> None:
    if not plan.is_chat_shell:
        if plan.call_executor_cancel:
            background_tasks.add_task(
                task_kinds_service._call_executor_cancel,
                task_id,
            )
        return
    if plan.running_subtask_id is None:
        logger.info("[CANCEL] No running subtask found for task %s", task_id)
        return

    subtask_id = plan.running_subtask_id
    logger.info("[CANCEL] Found running subtask: id=%s", subtask_id)
    try:
        recovery = await web_stream_worker_client.execute(
            SUBTASK_RECOVERY_EXECUTE,
            {
                "subtask_id": subtask_id,
                "offset": 0,
                "include_blocks": False,
                "include_context_metrics": False,
            },
        )
    except StreamWorkerUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Streaming recovery worker is unavailable",
        ) from error
    except StreamWorkerExecutionError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error
    partial_content = recovery.get("content")
    if not isinstance(partial_content, str):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Streaming recovery worker returned an invalid snapshot",
        )
    logger.info(
        "[CANCEL] Got partial content from Redis: length=%s",
        len(partial_content) if partial_content else 0,
    )
    await session_manager.cancel_stream(subtask_id)
    await _run_sync(
        _complete_chat_cancel_sync,
        task_id=task_id,
        user_id=user_id,
        subtask_id=subtask_id,
        partial_content=partial_content,
    )
    logger.info(
        "[CANCEL] Chat Shell task cancelled: task_id=%s, subtask_id=%s",
        task_id,
        subtask_id,
    )


async def _stop_delete_stream(
    *,
    session_manager: Any,
    task_id: int,
    subtask_id: Optional[int],
) -> None:
    if subtask_id is None:
        return
    logger.info(
        "[DELETE] Stopping running stream before delete: task_id=%s, subtask_id=%s",
        task_id,
        subtask_id,
    )
    await session_manager.cancel_stream(subtask_id)
    await session_manager.delete_streaming_content(subtask_id)
    await session_manager.unregister_stream(subtask_id)
    logger.info("[DELETE] Stream stopped for subtask %s", subtask_id)


def _execution_model_type(execution_request: Any) -> str:
    """Return the normalized model type from an execution request."""
    model_config = getattr(execution_request, "model_config", {}) or {}
    return str(model_config.get("modelType") or "").lower()


def _validate_generation_options_model(
    request_body: ResponseCreateInput,
    execution_request: Any,
) -> None:
    """Reject OpenAPI generation options for non-generation execution models."""
    if _generation_options(request_body) is None:
        return
    if _execution_model_type(execution_request) not in {"image", "video"}:
        raise ValueError(
            "Generation options are only supported for image or video models"
        )


def _should_run_in_background(
    *,
    requested_background: bool,
    execution_request: Any,
) -> bool:
    """Video generation is always asynchronous."""
    return requested_background or _execution_model_type(execution_request) == "video"


async def _reject_video_streaming(
    *,
    request_body: ResponseCreateInput,
    execution_request: Any,
    subtask_id: int,
    task_id: int,
) -> None:
    """Reject video streaming while preserving callback streaming for executors."""
    if (
        not request_body.stream
        or request_body.background
        or _execution_model_type(execution_request) != "video"
    ):
        return

    error_message = (
        "Streaming is not supported for video generation. "
        "Use stream=false and poll GET /api/v1/responses/{id}."
    )
    await _persist_terminal_failure(
        subtask_id=subtask_id,
        task_id=task_id,
        error_message=error_message,
        error_code="streaming_not_supported",
    )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=error_message,
    )


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


@router.post(
    "",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": ResponseCreateInput.model_json_schema(by_alias=True)
                }
            },
        }
    },
)
@nonblocking_limit(limiter, settings.RATE_LIMIT_CREATE_RESPONSE)
@trace_async(
    span_name="openapi.create_response",
    tracer_name="backend.openapi",
    extract_attributes=lambda request, request_body, auth_context: {
        "user.id": str(auth_context.user.id),
        "user.name": auth_context.user.user_name,
        "request.model": request_body.model,
        "request.stream": request_body.stream,
        "request.background": request_body.background,
    },
)
async def create_response(
    request: Request,
    request_body: ResponseCreateInput = Depends(_decode_response_create_request),
    auth_context: _OpenAPIAuthContext = Depends(_get_openapi_auth_context),
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
    del auth_context
    auto_delete_executor = _normalize_auto_delete_executor_header(
        request.headers.get("auto_delete_executor")
        or request.headers.get("auto-delete-executor")
    )

    model_info, tool_settings, input_text = await run_payload_codec(
        _prepare_response_request_payload,
        request_body,
        payload_hint=request_body,
        force_offload=True,
    )

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

    target = await _run_sync(
        _validate_response_target_sync,
        user_id=current_user.id,
        model_info=model_info,
        previous_task_id=previous_task_id,
    )

    # Use unified trigger architecture for all shell types
    # ExecutionRouter will automatically select communication mode based on shell_type
    if request_body.stream and not request_body.background:
        # Streaming mode: use dispatch_sse_stream
        # Note: background=True takes precedence over stream=True
        return await _create_streaming_response_unified(
            user=current_user,
            team_id=target.team_id,
            model_info=target.model_info,
            request_body=request_body,
            input_text=input_text,
            tool_settings=tool_settings,
            task_id=task_id,
            api_key_name=api_key_name,
            auto_delete_executor=auto_delete_executor,
        )
    else:
        # Non-streaming mode: background or sync
        return await _create_non_streaming_response_unified(
            user=current_user,
            team_id=target.team_id,
            model_info=target.model_info,
            request_body=request_body,
            input_text=input_text,
            tool_settings=tool_settings,
            task_id=task_id,
            api_key_name=api_key_name,
            auto_delete_executor=auto_delete_executor,
            background=request_body.background,
        )


async def _create_non_streaming_response_unified(
    user: _OpenAPIUser,
    team_id: int,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
    auto_delete_executor: Optional[str] = None,
    background: bool = False,
) -> ResponseObject:
    """Create non-streaming response using unified trigger architecture.

    Handles both sync and background modes:
    - background=False (sync): Blocks until LLM completes, returns completed response
    - background=True: Returns immediately with 'in_progress', task runs asynchronously

    For non-SSE shell types, always returns queued response regardless of background flag.
    """
    from app.services.chat.trigger.unified import build_execution_request
    from app.services.openapi.chat_session import schedule_memory_save
    from app.services.openapi.worker_client import openapi_worker_client

    preparation = await _run_sync(
        _prepare_response_session_sync,
        user_id=user.id,
        team_id=team_id,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
        auto_delete_executor=auto_delete_executor,
    )
    schedule_memory_save(preparation.memory_save_request)

    response_id = f"resp_{preparation.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = preparation.assistant_subtask_id
    task_kind_id = preparation.task_id
    user_id = user.id

    # Convert reasoning config from Pydantic model to dict
    reasoning_config = None
    if request_body.reasoning:
        reasoning_config = await run_payload_codec(
            _dump_model,
            request_body.reasoning,
            payload_hint=request_body.reasoning,
            force_offload=True,
        )

    # Build execution request
    try:
        execution_request = await build_execution_request(
            task=preparation.task_id,
            assistant_subtask=preparation.assistant_subtask_id,
            team=team_id,
            user=user.id,
            message=input_text,
            enable_tools=preparation.enable_tools,
            user_subtask_id=preparation.user_subtask_id,
            enable_deep_thinking=preparation.enable_chat_bot,
            enable_web_search=(
                preparation.enable_chat_bot and settings.WEB_SEARCH_ENABLED
            ),
            preload_skills=preparation.preload_skills,
            knowledge_base_refs=preparation.current_kb_refs,
            reasoning_config=reasoning_config,
            generation_params=_generation_options(request_body),
            attachment_ids=preparation.linked_attachment_ids,
        )
        _validate_generation_options_model(request_body, execution_request)
    except ExternalRefValidationError as e:
        logger.warning("Failed to build execution request: %s", e)
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except HTTPException as e:
        logger.warning("Failed to build execution request: %s", e.detail)
        error_message = await run_payload_codec(
            _exception_message,
            e,
            payload_hint=e.detail,
            force_offload=True,
        )
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=error_message,
        )
        raise
    except ValueError as e:
        logger.warning("Invalid execution request: %s", e)
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
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

    await _reject_video_streaming(
        request_body=request_body,
        execution_request=execution_request,
        subtask_id=assistant_subtask_id,
        task_id=task_kind_id,
    )

    async def _query_subtasks() -> list[_SubtaskView]:
        return await _run_sync(
            _query_subtask_views_sync,
            task_id=task_kind_id,
            user_id=user_id,
        )

    background = _should_run_in_background(
        requested_background=background,
        execution_request=execution_request,
    )
    try:
        outcome = await openapi_worker_client.execute(
            execution_request,
            background=background,
        )
    except Exception as e:
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        logger.exception("Worker-owned OpenAPI execution failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {str(e)}",
        ) from e
    if outcome.status == "failed":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM request failed: {outcome.error or 'Unknown error'}",
        )

    response_status = outcome.status
    assistant_status = "completed" if response_status == "completed" else "in_progress"
    return await _project_current_response_nonblocking(
        response_id=response_id,
        created_at=created_at,
        response_status=response_status,
        model=request_body.model,
        subtasks=await _query_subtasks(),
        assistant_subtask_id=assistant_subtask_id,
        assistant_status=assistant_status,
        previous_response_id=request_body.previous_response_id,
    )


@trace_async(
    span_name="openapi.streaming_response",
    tracer_name="backend.openapi",
    extract_attributes=lambda user, team_id, model_info, request_body, input_text, tool_settings, task_id, api_key_name, auto_delete_executor=None: {
        "task.id": str(task_id) if task_id else "new",
        "user.id": str(user.id),
        "team.name": model_info.get("team_name"),
        "team.namespace": model_info.get("namespace"),
        "model.id": model_info.get("model_id", "default"),
        "stream.enabled": True,
        "task.auto_delete_executor": auto_delete_executor or "default",
    },
)
async def _create_streaming_response_unified(
    user: _OpenAPIUser,
    team_id: int,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
    auto_delete_executor: Optional[str] = None,
) -> StreamingResponse:
    """Create streaming response using unified trigger architecture.

    Uses direct SSE for Chat shells and callback streaming for executor shells.
    """
    from app.services.chat.trigger.unified import build_execution_request
    from app.services.openapi.chat_session import schedule_memory_save
    from app.services.openapi.worker_client import openapi_worker_client
    from app.services.openapi.worker_protocol import OpenAPIStreamSpec

    preparation = await _run_sync(
        _prepare_response_session_sync,
        user_id=user.id,
        team_id=team_id,
        model_info=model_info,
        request_body=request_body,
        input_text=input_text,
        tool_settings=tool_settings,
        task_id=task_id,
        api_key_name=api_key_name,
        auto_delete_executor=auto_delete_executor,
    )
    schedule_memory_save(preparation.memory_save_request)

    # Add trace events for session setup
    add_span_event(
        "streaming.session_setup",
        {
            "task_id": str(preparation.task_id),
            "assistant_subtask_id": str(preparation.assistant_subtask_id),
            "user_subtask_id": str(preparation.user_subtask_id),
        },
    )
    set_span_attribute("task.id", preparation.task_id)
    set_span_attribute("subtask.id", preparation.assistant_subtask_id)
    set_span_attribute("user.id", str(user.id))

    response_id = f"resp_{preparation.task_id}"
    created_at = int(datetime.now().timestamp())
    assistant_subtask_id = preparation.assistant_subtask_id
    task_kind_id = preparation.task_id

    # Convert reasoning config from Pydantic model to dict
    reasoning_config = None
    if request_body.reasoning:
        reasoning_config = await run_payload_codec(
            _dump_model,
            request_body.reasoning,
            payload_hint=request_body.reasoning,
            force_offload=True,
        )

    # Build execution request using unified builder
    try:
        execution_request = await build_execution_request(
            task=preparation.task_id,
            assistant_subtask=preparation.assistant_subtask_id,
            team=team_id,
            user=user.id,
            message=input_text,
            enable_tools=preparation.enable_tools,
            user_subtask_id=preparation.user_subtask_id,
            enable_deep_thinking=preparation.enable_chat_bot,
            enable_web_search=(
                preparation.enable_chat_bot and settings.WEB_SEARCH_ENABLED
            ),
            preload_skills=preparation.preload_skills,
            knowledge_base_refs=preparation.current_kb_refs,
            reasoning_config=reasoning_config,
            generation_params=_generation_options(request_body),
            attachment_ids=preparation.linked_attachment_ids,
        )
        _validate_generation_options_model(request_body, execution_request)
    except ExternalRefValidationError as e:
        logger.warning("Failed to build execution request: %s", e)
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except HTTPException as e:
        logger.warning("Failed to build execution request: %s", e.detail)
        error_message = await run_payload_codec(
            _exception_message,
            e,
            payload_hint=e.detail,
            force_offload=True,
        )
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=error_message,
        )
        raise
    except ValueError as e:
        logger.warning("Invalid execution request: %s", e)
        await _persist_terminal_failure(
            subtask_id=assistant_subtask_id,
            task_id=task_kind_id,
            error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
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
    await _reject_video_streaming(
        request_body=request_body,
        execution_request=execution_request,
        subtask_id=assistant_subtask_id,
        task_id=task_kind_id,
    )

    stream_spec = OpenAPIStreamSpec(
        response_id=response_id,
        model_string=request_body.model,
        created_at=created_at,
        previous_response_id=request_body.previous_response_id,
        task_context=(
            {
                "task_id": task_kind_id,
                "task_path": f"/chat?task_id={task_kind_id}",
            }
            if request_body.wegent_options
            and request_body.wegent_options.include_task_context
            else None
        ),
    )

    async def generate():
        async for payload in openapi_worker_client.stream(
            execution_request,
            stream_spec,
        ):
            yield payload

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
@nonblocking_limit(limiter, settings.RATE_LIMIT_GET_RESPONSE)
async def get_response(
    request: Request,
    response_id: str,
    current_user: _OpenAPIUser = Depends(_get_openapi_user),
):
    """
    Retrieve a response by ID.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with current status and output
    """
    task_id = _parse_response_task_id(
        response_id,
        include_expected_format=True,
    )

    user_id = int(current_user.id)
    del current_user
    return await _run_sync(
        _get_response_sync,
        task_id=task_id,
        user_id=user_id,
        response_id=response_id,
    )


@router.post("/{response_id}/cancel", response_model=ResponseObject)
@nonblocking_limit(limiter, settings.RATE_LIMIT_CANCEL_RESPONSE)
async def cancel_response(
    request: Request,
    response_id: str,
    background_tasks: BackgroundTasks,
    current_user: _OpenAPIUser = Depends(_get_openapi_user),
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
    from app.services.chat.storage import session_manager

    task_id = _parse_response_task_id(response_id)

    user_id = int(current_user.id)
    del current_user
    plan = await _run_sync(
        _prepare_cancel_response_sync,
        task_id=task_id,
        user_id=user_id,
        response_id=response_id,
    )
    logger.info(
        "[CANCEL] task_id=%s, source=%s, is_chat_shell=%s",
        task_id,
        plan.source_label,
        plan.is_chat_shell,
    )

    await _apply_cancel_response_plan(
        plan=plan,
        session_manager=session_manager,
        background_tasks=background_tasks,
        task_id=task_id,
        user_id=user_id,
    )

    return await _run_sync(
        _build_cancel_response_sync,
        task_id=task_id,
        user_id=user_id,
        response_id=response_id,
        model_string=plan.model_string,
    )


@router.delete("/{response_id}", response_model=ResponseDeletedObject)
@nonblocking_limit(limiter, settings.RATE_LIMIT_DELETE_RESPONSE)
async def delete_response(
    request: Request,
    response_id: str,
    current_user: _OpenAPIUser = Depends(_get_openapi_user),
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

    task_id = _parse_response_task_id(response_id)

    user_id = int(current_user.id)
    del current_user
    plan = await _run_sync(
        _prepare_delete_response_sync,
        task_id=task_id,
        user_id=user_id,
    )
    await _stop_delete_stream(
        session_manager=session_manager,
        task_id=task_id,
        subtask_id=plan.running_subtask_id,
    )

    return await _run_sync(
        _delete_response_sync,
        task_id=task_id,
        user_id=user_id,
        response_id=response_id,
    )
