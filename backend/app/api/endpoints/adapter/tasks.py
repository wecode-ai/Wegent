# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import logging
import re
from datetime import datetime
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.api.dependencies import get_db, with_task_telemetry
from app.core import security
from app.core.config import settings
from app.core.constants import (
    CLIENT_ORIGIN_FRONTEND,
    CLIENT_ORIGIN_WEWORK,
    SUPPORTED_CLIENT_ORIGINS,
)
from app.db.session import get_async_db
from app.models.user import User
from app.schemas.remote_workspace import (
    RemoteWorkspaceStatusResponse,
    RemoteWorkspaceTreeResponse,
)
from app.schemas.service import (
    ServiceDeleteRequest,
    ServiceResponse,
    ServiceUpdate,
)
from app.schemas.shared_task import (
    JoinSharedTaskRequest,
    JoinSharedTaskResponse,
    PublicSharedTaskResponse,
    TaskShareInfo,
    TaskShareResponse,
)
from app.schemas.task import (
    ArchivedTaskListResponse,
    PipelineStageInfo,
    PromptDraftGenerateRequest,
    PromptDraftGenerateResponse,
    TaskArchiveBatchResponse,
    TaskArchiveResponse,
    TaskCreate,
    TaskDetail,
    TaskInDB,
    TaskListResponse,
    TaskLiteGroupedListResponse,
    TaskLiteListResponse,
    TaskRuntimeActiveStream,
    TaskRuntimeCheck,
    TaskSkillsResponse,
    TaskUpdate,
)
from app.services import prompt_draft_service
from app.services.adapters.executor_job import job_service
from app.services.adapters.task_kinds import task_kinds_service
from app.services.adapters.wework_conversation_search import (
    search_wework_conversation_tasks,
)
from app.services.chat.storage import session_manager
from app.services.remote_workspace_service import remote_workspace_service
from app.services.shared_task import shared_task_service
from app.stores.tasks import task_store
from shared.telemetry.decorators import trace_sync

router = APIRouter()
logger = logging.getLogger(__name__)

ClientOriginQuery = Annotated[
    str,
    Query(
        pattern=f"^({'|'.join(SUPPORTED_CLIENT_ORIGINS)})$",
        description="Client surface to scope task lists and chat operations",
    ),
]


def _personal_history_project_scope(
    client_origin: str,
) -> Literal["standalone", "standalone_unlabeled"]:
    if client_origin == CLIENT_ORIGIN_WEWORK:
        return "standalone_unlabeled"
    return "standalone"


@router.post("", response_model=dict)
def create_task_id(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with session id and return task_id"""
    return {
        "task_id": task_kinds_service.create_task_id(db=db, user_id=current_user.id)
    }


@router.post("/create", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_optional_id(
    task_create: TaskCreate,
    task_id: Optional[int] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with optional task_id in parameters"""
    result = task_kinds_service.create_task_or_append(
        db=db, obj_in=task_create, user=current_user, task_id=task_id
    )

    # Record task creation metric (only if telemetry is enabled)
    if settings.OTEL_ENABLED:
        from shared.telemetry.metrics import record_task_created

        record_task_created(
            user_id=str(current_user.id),
            team_id=str(task_create.team_id) if task_create.team_id else None,
        )

    return result


@router.post("/archive", response_model=TaskArchiveBatchResponse)
def archive_all_user_chats(
    scope: Literal["all", "standalone"] = Query(
        "all",
        description=(
            "Archive scope. 'standalone' archives chats with no project; "
            "'all' preserves the legacy behavior."
        ),
    ),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Archive all active personal chat/code tasks owned by the current user."""
    if scope == "standalone":
        count = task_kinds_service.archive_standalone_chats(
            db=db, user_id=current_user.id, client_origin=client_origin
        )
    else:
        count = task_kinds_service.archive_all_user_chats(
            db=db, user_id=current_user.id, client_origin=client_origin
        )
    return {"message": "Chats archived successfully", "count": count}


@router.post("/{task_id}", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_id(
    task_create: TaskCreate,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with specified task_id"""
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task_create, user=current_user, task_id=task_id
    )


@router.get("", response_model=TaskListResponse)
def get_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's task list (paginated), excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_with_pagination(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/lite", response_model=TaskLiteListResponse)
def get_tasks_lite(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's lightweight task list (paginated) for fast loading, excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_lite(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/lite/group", response_model=TaskLiteListResponse)
def get_group_tasks_lite(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's group chat task list (paginated) for fast loading.
    Returns only group chat tasks sorted by updated_at descending (most recent activity first).
    """
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_group_tasks_lite(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/lite/personal", response_model=TaskLiteListResponse)
def get_personal_tasks_lite(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    types: str = Query(
        "online,offline",
        description="Comma-separated task types to include: online (chat), offline (code), flow",
    ),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's personal (non-group-chat) task list (paginated) for fast loading.
    Returns only personal tasks sorted by created_at descending (newest first).

    Types filter:
    - online: chat tasks (task_type != 'code' and not flow)
    - offline: code tasks (task_type == 'code')
    - flow: flow-triggered tasks (labels.type == 'flow')
    """
    skip = (page - 1) * limit
    type_list = [t.strip() for t in types.split(",") if t.strip()]
    project_scope = _personal_history_project_scope(client_origin)
    items, total = task_kinds_service.get_user_personal_tasks_lite(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        types=type_list,
        client_origin=client_origin,
        project_scope=project_scope,
    )
    return {"total": total, "items": items}


@router.get("/lite/personal/grouped", response_model=TaskLiteGroupedListResponse)
@trace_sync("get_personal_task_groups_lite", "tasks.api")
def get_personal_task_groups_lite(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    types: str = Query(
        "online,offline",
        description="Comma-separated task types to include: online (chat), offline (code), flow",
    ),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's personal task page grouped by device or agent.

    This endpoint groups only the current flat page (default 50 items) to keep
    query costs equivalent to the existing personal history pagination.
    """
    skip = (page - 1) * limit
    type_list = [t.strip() for t in types.split(",") if t.strip()]
    project_scope = _personal_history_project_scope(client_origin)
    items, total = task_kinds_service.get_user_personal_task_groups_lite(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        types=type_list,
        client_origin=client_origin,
        project_scope=project_scope,
    )
    return {"total": total, "items": items}


@router.get("/search", response_model=TaskListResponse)
def search_tasks_by_title(
    title: str = Query(..., min_length=1, description="Search by task title keywords"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Fuzzy search tasks by title for current user (pagination), excluding DELETE status"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_by_title_with_pagination(
        db=db, user_id=current_user.id, title=title, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/wework/conversation-search", response_model=TaskListResponse)
def search_wework_conversation_task_list(
    keyword: str = Query(
        ..., min_length=1, description="Search by task title or message keywords"
    ),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Search WeWork conversations by title or conversation content."""
    skip = (page - 1) * limit
    items, total = search_wework_conversation_tasks(
        db=db,
        user_id=current_user.id,
        keyword=keyword,
        skip=skip,
        limit=limit,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    return {"total": total, "items": items}


@router.get("/archived", response_model=ArchivedTaskListResponse)
def get_archived_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(100, ge=1, le=200, description="Items per page"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get archived chats owned by the current user."""
    skip = (page - 1) * limit
    items, total = task_kinds_service.list_archived_tasks(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        client_origin=client_origin,
    )
    return {"total": total, "items": items}


@router.delete("/archived", response_model=TaskArchiveBatchResponse)
def delete_archived_tasks(
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Soft delete all archived chats owned by the current user."""
    count = task_kinds_service.delete_all_archived_tasks(
        db=db, user_id=current_user.id, client_origin=client_origin
    )
    return {"message": "Archived chats deleted successfully", "count": count}


@router.get("/{task_id}/runtime-check", response_model=TaskRuntimeCheck)
async def get_task_runtime_check(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Return lightweight task/runtime consistency checkpoint.

    This endpoint must not return message content. Messages are recovered via
    WebSocket join/resume only.
    """
    task = task_kinds_service.get_task_by_id(
        db=db, task_id=task_id, user_id=current_user.id
    )

    active_stream = None
    streaming_status = await session_manager.get_task_streaming_status(task_id)
    if streaming_status:
        raw_subtask_id = streaming_status.get("subtask_id")
        subtask_id = int(raw_subtask_id) if raw_subtask_id is not None else None
        if subtask_id is not None:
            cached_content = await session_manager.get_streaming_content(subtask_id)
            active_stream = TaskRuntimeActiveStream(
                subtask_id=subtask_id,
                cursor=len(cached_content or ""),
                last_activity_at=(
                    datetime.fromisoformat(streaming_status["last_activity_at"])
                    if streaming_status.get("last_activity_at")
                    else None
                ),
            )

    return TaskRuntimeCheck(
        task_id=task_id,
        task_status=task["status"],
        status_updated_at=task.get("updated_at"),
        active_stream=active_stream,
    )


@router.get("/{task_id}", response_model=TaskDetail)
def get_task(
    task_id: int = Depends(with_task_telemetry),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified task details with related entities"""
    return task_kinds_service.get_task_detail(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        client_origin=client_origin,
    )


@router.post("/{task_id}/archive", response_model=TaskArchiveResponse)
def archive_task(
    task_id: int = Depends(with_task_telemetry),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Archive one chat owned by the current user."""
    task_kinds_service.archive_task(
        db=db, task_id=task_id, user_id=current_user.id, client_origin=client_origin
    )
    return {"message": "Chat archived successfully", "task_id": task_id}


@router.post("/{task_id}/unarchive", response_model=TaskArchiveResponse)
def unarchive_task(
    task_id: int = Depends(with_task_telemetry),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Restore one archived chat owned by the current user."""
    task_kinds_service.unarchive_task(
        db=db, task_id=task_id, user_id=current_user.id, client_origin=client_origin
    )
    return {"message": "Chat unarchived successfully", "task_id": task_id}


@router.get(
    "/{task_id}/remote-workspace/status",
    response_model=RemoteWorkspaceStatusResponse,
)
def get_remote_workspace_status(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get remote workspace connection and availability status for a task."""
    return remote_workspace_service.get_status(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
    )


@router.get(
    "/{task_id}/remote-workspace/tree",
    response_model=RemoteWorkspaceTreeResponse,
)
def get_remote_workspace_tree(
    path: str = Query("/workspace", description="Workspace path to list"),
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """List remote workspace tree under /workspace."""
    return remote_workspace_service.list_tree(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        path=path,
    )


@router.get("/{task_id}/remote-workspace/file")
def get_remote_workspace_file(
    path: str = Query(..., description="Workspace file path"),
    disposition: str = Query(
        "inline", pattern="^(inline|attachment)$", description="File disposition"
    ),
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Stream remote workspace file for inline preview or attachment download."""
    return remote_workspace_service.stream_file(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        path=path,
        disposition=disposition,
    )


@router.get("/{task_id}/skills", response_model=TaskSkillsResponse)
def get_task_skills(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    db: Session = Depends(get_db),
):
    """Get all skills associated with a task.

    Follows the chain: task → team → bots → ghosts → skills

    Supports multiple authentication methods:
    - JWT Token (standard user authentication)
    - API Key (for executor/service authentication)
    - Task Token (for executor task-based authentication)

    Returns:
        TaskSkillsResponse with task_id, team_id, team_namespace,
        skills list (deduplicated), and preload_skills list.
    """
    return task_kinds_service.get_task_skills(
        db=db, task_id=task_id, user_id=current_user.id
    )


@router.post(
    "/{task_id}/prompt-drafts/generate", response_model=PromptDraftGenerateResponse
)
def generate_task_prompt_draft(
    request: PromptDraftGenerateRequest,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Generate a prompt draft from current task conversation."""
    try:
        return prompt_draft_service.generate_prompt_draft(
            db=db,
            task_id=task_id,
            current_user=current_user,
            model=request.model,
            source=request.source,
            current_prompt=request.current_prompt,
            regenerate=request.regenerate,
        )
    except prompt_draft_service.PromptDraftTaskNotFoundError:
        raise HTTPException(status_code=404, detail="Task not found")
    except prompt_draft_service.PromptDraftConversationTooShortError:
        raise HTTPException(
            status_code=400, detail="Conversation is too short to generate prompt"
        )
    except prompt_draft_service.PromptDraftModelUnavailableError:
        raise HTTPException(
            status_code=400,
            detail="No available model for prompt draft generation",
        )
    except prompt_draft_service.PromptDraftGenerationFailedError:
        raise HTTPException(status_code=502, detail="Prompt draft generation failed")
    except ValueError as exc:
        if str(exc) == "task_not_found":
            raise HTTPException(status_code=404, detail="Task not found")
        if str(exc) == "model_not_found":
            raise HTTPException(status_code=400, detail="Model not found")
        raise
    except RuntimeError as exc:
        if str(exc) == "conversation_too_short":
            raise HTTPException(
                status_code=400, detail="Conversation is too short to generate prompt"
            )
        raise


@router.post("/{task_id}/prompt-drafts/generate/stream")
async def generate_task_prompt_draft_stream(
    request: PromptDraftGenerateRequest,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Generate prompt draft as SSE stream events."""

    try:
        # Pre-check to return 4xx before streaming starts.
        prompt_draft_service.validate_prompt_draft_context(
            db=db, task_id=task_id, current_user=current_user, model=request.model
        )
    except prompt_draft_service.PromptDraftTaskNotFoundError:
        raise HTTPException(status_code=404, detail="Task not found")
    except prompt_draft_service.PromptDraftConversationTooShortError:
        raise HTTPException(
            status_code=400, detail="Conversation is too short to generate prompt"
        )
    except prompt_draft_service.PromptDraftModelUnavailableError:
        raise HTTPException(
            status_code=400,
            detail="No available model for prompt draft generation",
        )
    except ValueError as exc:
        if str(exc) == "task_not_found":
            raise HTTPException(status_code=404, detail="Task not found")
        if str(exc) == "model_not_found":
            raise HTTPException(status_code=400, detail="Model not found")
        raise

    async def event_stream():
        async for event in prompt_draft_service.generate_prompt_draft_stream(
            db=db,
            task_id=task_id,
            current_user=current_user,
            model=request.model,
            source=request.source,
            current_prompt=request.current_prompt,
            regenerate=request.regenerate,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.put("/{task_id}", response_model=TaskInDB)
def update_task(
    task_update: TaskUpdate,
    task_id: int = Depends(with_task_telemetry),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update task information"""
    return task_kinds_service.update_task(
        db=db,
        task_id=task_id,
        obj_in=task_update,
        user_id=current_user.id,
        client_origin=client_origin,
    )


@router.delete("/{task_id}")
def delete_task(
    task_id: int = Depends(with_task_telemetry),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete task"""
    task_kinds_service.delete_task(
        db=db, task_id=task_id, user_id=current_user.id, client_origin=client_origin
    )
    return {"message": "Task deleted successfully"}


@router.post("/{task_id}/cancel")
async def cancel_task(
    background_tasks: BackgroundTasks,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Cancel a running task by calling executor_manager or Chat Shell cancel"""
    return await task_kinds_service.cancel_task(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        background_task_runner=background_tasks.add_task,
    )


@router.get("/{task_id}/pipeline-stage-info", response_model=PipelineStageInfo)
def get_pipeline_stage_info(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get pipeline stage information for a task.

    Returns current stage, total stages, and stage details for pipeline mode teams.
    For non-pipeline teams, returns default values.

    Args:
        task_id: Task ID
        current_user: Current authenticated user
        db: Database session

    Returns:
        PipelineStageInfo with stage details
    """
    return task_kinds_service.get_pipeline_stage_info(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
    )


@router.post("/{task_id}/share", response_model=TaskShareResponse)
def share_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Generate a share link for a task.
    The share link allows others to view the task history and copy it to their task list.
    """
    # Validate that the task belongs to the current user
    if not shared_task_service.validate_task_exists(
        db=db, task_id=task_id, user_id=current_user.id
    ):
        raise HTTPException(
            status_code=404, detail="Task not found or you don't have permission"
        )

    return shared_task_service.share_task(
        db=db, task_id=task_id, user_id=current_user.id
    )


@router.get("/share/info", response_model=TaskShareInfo)
def get_task_share_info(
    share_token: str = Query(..., description="Share token from URL"),
    db: Session = Depends(get_db),
):
    """
    Get task share information from share token.
    This endpoint doesn't require authentication, so anyone with the link can view.
    """
    return shared_task_service.get_share_info(db=db, share_token=share_token)


@router.get("/share/public", response_model=PublicSharedTaskResponse)
def get_public_shared_task(
    token: str = Query(..., description="Share token from URL"),
    db: Session = Depends(get_db),
):
    """
    Get public shared task data for read-only viewing.
    This endpoint doesn't require authentication - anyone with the link can view.
    Only returns public data (no sensitive information like team config, bot details, etc.)
    """
    return shared_task_service.get_public_shared_task(db=db, share_token=token)


@router.post("/share/join", response_model=JoinSharedTaskResponse)
def join_shared_task(
    request: JoinSharedTaskRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Copy a shared task to the current user's task list.
    This creates a new task with all the subtasks (messages) from the shared task.
    """
    from app.models.kind import Kind

    # If team_id is provided, validate it belongs to the user
    if request.team_id:
        user_team = (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.id == request.team_id,
                Kind.is_active == True,
            )
            .first()
        )

        if not user_team:
            raise HTTPException(
                status_code=400,
                detail="Invalid team_id or team does not belong to you",
            )
    else:
        # Get user's first active team if not specified
        user_team = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not user_team:
            raise HTTPException(
                status_code=400,
                detail="You need to have at least one team to copy a shared task",
            )

    return shared_task_service.join_shared_task(
        db=db,
        share_token=request.share_token,
        user_id=current_user.id,
        team_id=user_team.id,
        model_id=request.model_id,
        force_override_bot_model=bool(request.model_id)
        or bool(request.force_override_bot_model),
        force_override_bot_model_type=request.force_override_bot_model_type,
        git_repo_id=request.git_repo_id,
        git_url=request.git_url,
        git_repo=request.git_repo,
        git_domain=request.git_domain,
        branch_name=request.branch_name,
    )


def sanitize_filename(name: str) -> str:
    """Remove invalid filename characters"""
    # Remove invalid characters
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", name)
    # Replace whitespace with underscore
    safe_name = re.sub(r"\s+", "_", safe_name)
    # Remove consecutive underscores
    safe_name = re.sub(r"_+", "_", safe_name)
    return safe_name.strip("_")[:100]  # Limit length


@router.get("/{task_id}/export/docx", summary="Export task as DOCX")
async def export_task_docx(
    task_id: int,
    message_ids: Optional[str] = Query(
        None,
        description="Comma-separated list of message IDs to export. If not provided, exports all messages.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Export task conversation history to DOCX format.

    Returns a downloadable DOCX file containing:
    - Task title and metadata
    - All subtask messages (user prompts and AI responses), or filtered by message_ids
    - Formatted markdown content
    - Embedded images and attachment info
    """
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task (owner or group chat member)
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    # Query task without user_id filter since we already validated access
    from app.models.task import TaskResource

    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=TaskResource.is_active_query(),
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Parse message_ids if provided
    filter_message_ids: Optional[list[int]] = None
    if message_ids:
        try:
            filter_message_ids = [
                int(id.strip()) for id in message_ids.split(",") if id.strip()
            ]
        except ValueError as e:
            raise HTTPException(
                status_code=400,
                detail="Invalid message_ids format. Must be comma-separated integers.",
            ) from e

    try:
        # Lazy import docx_generator to avoid loading python-docx at startup
        from app.services.export.docx_generator import generate_task_docx

        # Generate DOCX document with optional message filter
        docx_buffer = generate_task_docx(task, db, message_ids=filter_message_ids)

        # Get task title for filename
        task_data = task.json.get("spec", {})
        task_title = (
            task.json.get("metadata", {}).get("name", "")
            or task_data.get("title", "")
            or task_data.get("prompt", "Chat_Export")[:50]
        )

        # Sanitize filename
        safe_filename = sanitize_filename(task_title)
        filename = f"{safe_filename}_{datetime.now().strftime('%Y-%m-%d')}.docx"

        # Return as downloadable file
        return StreamingResponse(
            io.BytesIO(docx_buffer.getvalue()),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        logger.error(f"Failed to export task {task_id} to DOCX: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to generate DOCX document")


@router.get("/{task_id}/services", response_model=ServiceResponse)
def get_task_services(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get task services/app configuration.

    Returns the app field from the task JSON containing service information
    like name, host, previewUrl, mysql, etc.
    """
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    from app.models.task import TaskResource

    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=TaskResource.is_active_query(),
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # App data is stored under status.app
    status_data = task.json.get("status", {}) if task.json else {}
    app_data = status_data.get("app", {}) if status_data else {}
    return {"app": app_data}


@router.post("/{task_id}/services", response_model=ServiceResponse)
def update_task_services(
    service_update: ServiceUpdate,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update task services/app configuration (partial merge).

    Merges the provided fields with existing app data.
    Only provided non-None fields will be updated.
    """
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    from app.models.task import TaskResource

    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=TaskResource.is_active_query(),
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get existing app data or initialize empty dict
    # App data is stored under status.app
    task_json = task.json or {}
    status_data = task_json.get("status", {}) or {}
    app_data = status_data.get("app", {}) or {}

    # Merge only non-None fields from the request
    update_data = service_update.model_dump(exclude_none=True)
    app_data.update(update_data)

    # Update task JSON with new app data under status.app
    status_data["app"] = app_data
    task_json["status"] = status_data
    task_store.update_json(db, task=task, payload=task_json)

    db.commit()
    db.refresh(task)

    return {"app": app_data}


@router.delete("/{task_id}/services", response_model=ServiceResponse)
def delete_task_services(
    delete_request: ServiceDeleteRequest,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete specified fields from task services/app configuration.

    Removes the specified field names from the app object.
    """
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    from app.models.task import TaskResource

    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=TaskResource.is_active_query(),
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get existing app data
    # App data is stored under status.app
    task_json = task.json or {}
    status_data = task_json.get("status", {}) or {}
    app_data = status_data.get("app", {}) or {}

    # Remove specified fields
    for field_name in delete_request.fields:
        app_data.pop(field_name, None)

    # Update task JSON under status.app
    status_data["app"] = app_data
    task_json["status"] = status_data
    task_store.update_json(db, task=task, payload=task_json)

    db.commit()
    db.refresh(task)

    return {"app": app_data}


@router.post("/{task_id}/preserve-executor")
def set_preserve_executor(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Set preserve executor flag for a task.

    When this flag is set, the executor pod for this task will not be cleaned up
    by the cleanup_stale_executors job even after the task is completed.
    This is useful for important tasks that need to retain their execution environment.

    Only task owner or group chat members can set this flag.
    """
    return task_kinds_service.set_preserve_executor(
        db=db, task_id=task_id, user_id=current_user.id, preserve=True
    )


@router.delete("/{task_id}/preserve-executor")
def cancel_preserve_executor(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Cancel preserve executor flag for a task.

    Removes the preserve flag, allowing the executor pod to be cleaned up
    by the cleanup_stale_executors job when the task expires.

    Only task owner or group chat members can cancel this flag.
    """
    return task_kinds_service.set_preserve_executor(
        db=db, task_id=task_id, user_id=current_user.id, preserve=False
    )


@router.post("/{task_id}/cleanup-executor", response_model=dict)
async def cleanup_task_executor(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    """
    Clean up the executor for a finished task.

    This endpoint reuses the same cleanup rules as the scheduled executor cleanup
    job and only affects the specified task.
    """
    return await job_service.cleanup_task_executor(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
    )
