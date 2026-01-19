# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db, with_task_telemetry
from app.core import security
from app.core.config import settings
from app.models.user import User
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
    ConfirmStageRequest,
    ConfirmStageResponse,
    PipelineStageInfo,
    TaskCreate,
    TaskDetail,
    TaskInDB,
    TaskListResponse,
    TaskLiteListResponse,
    TaskUpdate,
)
from app.services.adapters.task_kinds import task_kinds_service
from app.services.export.docx_generator import generate_task_docx
from app.services.shared_task import shared_task_service

router = APIRouter()
logger = logging.getLogger(__name__)


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
    items, total = task_kinds_service.get_user_personal_tasks_lite(
        db=db, user_id=current_user.id, skip=skip, limit=limit, types=type_list
    )
    return {"total": total, "items": items}


@router.get("/lite/new", response_model=TaskLiteListResponse)
def get_new_tasks_lite(
    since_id: int = Query(..., ge=1, description="Get tasks with ID greater than this"),
    limit: int = Query(
        50, ge=1, le=100, description="Maximum number of new tasks to return"
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get new tasks created after the specified task ID, excluding DELETE status tasks"""
    items = task_kinds_service.get_new_tasks_since_id(
        db=db, user_id=current_user.id, since_id=since_id, limit=limit
    )
    return {"total": len(items), "items": items}


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


@router.get("/{task_id}", response_model=TaskDetail)
def get_task(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified task details with related entities"""
    return task_kinds_service.get_task_detail(
        db=db, task_id=task_id, user_id=current_user.id
    )


@router.put("/{task_id}", response_model=TaskInDB)
def update_task(
    task_update: TaskUpdate,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update task information"""
    return task_kinds_service.update_task(
        db=db, task_id=task_id, obj_in=task_update, user_id=current_user.id
    )


@router.delete("/{task_id}")
def delete_task(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete task"""
    task_kinds_service.delete_task(db=db, task_id=task_id, user_id=current_user.id)
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


@router.post("/{task_id}/confirm-stage", response_model=ConfirmStageResponse)
def confirm_pipeline_stage(
    request: ConfirmStageRequest,
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Confirm a pipeline stage and proceed to the next stage.

    For pipeline mode teams with requireConfirmation=true on a member,
    the task will pause after that stage completes and wait for user confirmation.

    Args:
        request: Contains confirmed_prompt and action (continue/retry)
        task_id: Task ID
        current_user: Current authenticated user
        db: Database session

    Returns:
        ConfirmStageResponse with stage info
    """
    return task_kinds_service.confirm_pipeline_stage(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        confirmed_prompt=request.confirmed_prompt,
        action=request.action,
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
                Kind.user_id == current_user.id,
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
        force_override_bot_model=request.force_override_bot_model or False,
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
    from app.models.task import TaskResource
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task (owner or group chat member)
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    # Query task without user_id filter since we already validated access
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
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
    from app.models.task import TaskResource
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.is_(True),
        )
        .first()
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
    from sqlalchemy.orm.attributes import flag_modified

    from app.models.task import TaskResource
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.is_(True),
        )
        .first()
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
    task.json = task_json
    task.updated_at = datetime.now()
    flag_modified(task, "json")

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
    from sqlalchemy.orm.attributes import flag_modified

    from app.models.task import TaskResource
    from app.services.task_member_service import task_member_service

    # Check if user has access to the task
    if not task_member_service.is_member(db, task_id, current_user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.is_(True),
        )
        .first()
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
    task.json = task_json
    task.updated_at = datetime.now()
    flag_modified(task, "json")

    db.commit()
    db.refresh(task)

    return {"app": app_data}
