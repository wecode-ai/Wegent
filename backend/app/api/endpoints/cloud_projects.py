# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared cloud project endpoints."""

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import (
    get_current_user,
    get_current_user_jwt_apikey_tasktoken,
)
from app.models.delivery import LoopItem
from app.models.user import User
from app.schemas.cloud_file import (
    CloudFileAccessResponse,
    CloudFileListResponse,
    CloudFileMove,
    CloudFileResponse,
    CloudFolderCreate,
    ProjectDeliveryFileListResponse,
    ProjectDeliveryFileResponse,
    ProjectDeliveryItemPathResponse,
)
from app.schemas.cloud_project import (
    CloudProjectCreate,
    CloudProjectListResponse,
    CloudProjectMemberCreate,
    CloudProjectMemberResponse,
    CloudProjectMemberUpdate,
    CloudProjectResponse,
    CloudProjectUpdate,
)
from app.schemas.delivery import LoopItemResponse
from app.schemas.project_board import ProjectBoardSnapshotResponse
from app.schemas.project_chat import (
    LoopItemApproval,
    LoopItemAssign,
    ProjectChatAgentCreate,
    ProjectChatAgentUpdate,
    ProjectChatAgentView,
)
from app.services.cloud_files import cloud_file_service
from app.services.cloud_projects import cloud_project_service
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_items import loop_item_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_board_snapshot import project_board_snapshot_service
from app.services.project_chat.service import project_chat_service

router = APIRouter()


def _project_response(
    db: Session, project: object, current_user: User
) -> CloudProjectResponse:
    access = cloud_project_service.access(db, int(project.id), current_user.id)
    return CloudProjectResponse.model_validate(
        {
            **project.__dict__,
            "current_user_id": current_user.id,
            "current_user_name": current_user.user_name,
            "access_role": access.role,
        }
    )


@router.post(
    "", response_model=CloudProjectResponse, status_code=status.HTTP_201_CREATED
)
def create_cloud_project(
    values: CloudProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudProjectResponse:
    """Create a cloud board using a user JWT, personal API key, or task token."""

    project = cloud_project_service.create(db, current_user.id, values)
    return _project_response(db, project, current_user)


@router.get("", response_model=CloudProjectListResponse)
def list_cloud_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudProjectListResponse:
    projects = cloud_project_service.list_accessible(db, current_user.id)
    return CloudProjectListResponse(
        items=[_project_response(db, project, current_user) for project in projects]
    )


@router.get("/{project_id}", response_model=CloudProjectResponse)
def get_cloud_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    return _project_response(db, project, current_user)


@router.patch("/{project_id}", response_model=CloudProjectResponse)
def update_cloud_project(
    project_id: int,
    values: CloudProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudProjectResponse:
    project = cloud_project_service.update(db, project_id, current_user.id, values)
    return _project_response(db, project, current_user)


@router.get("/{project_id}/chat-agents", response_model=list[ProjectChatAgentView])
def list_project_chat_agents(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> list[ProjectChatAgentView]:
    return project_chat_service.list_agents(
        db, user_id=current_user.id, project_id=str(project_id)
    )


@router.get(
    "/{project_id}/board-snapshot",
    response_model=ProjectBoardSnapshotResponse,
)
def get_project_board_snapshot(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectBoardSnapshotResponse:
    return project_board_snapshot_service.get(db, project_id, current_user.id)


@router.post(
    "/{project_id}/chat-agents",
    response_model=ProjectChatAgentView,
    status_code=status.HTTP_201_CREATED,
)
def create_project_chat_agent(
    project_id: int,
    values: ProjectChatAgentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectChatAgentView:
    return project_chat_service.create_agent(
        db, user_id=current_user.id, project_id=str(project_id), request=values
    )


@router.patch(
    "/{project_id}/chat-agents/{agent_id}", response_model=ProjectChatAgentView
)
def update_project_chat_agent(
    project_id: int,
    agent_id: str,
    values: ProjectChatAgentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectChatAgentView:
    return project_chat_service.update_agent(
        db,
        user_id=current_user.id,
        project_id=str(project_id),
        agent_id=agent_id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/assign",
    response_model=LoopItemResponse,
)
async def assign_loop_item(
    project_id: int,
    item_id: str,
    values: LoopItemAssign,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    """Assign a task to a member, project robot, or Wegent Team.

    The assignment chain and the derived queue state live on the task itself;
    there is no separate queue storage.
    """

    if external_loop_item_provider.is_external_item(db, item_id):
        response = external_loop_item_provider.assign(
            db, item_id, current_user.id, values
        )
        if values.assignee_type == "agent":
            from app.services.board_team_execution import (
                dispatch_board_team_assignment,
            )

            item = db.get(LoopItem, item_id)
            if item is None:
                raise RuntimeError("External Team assignment index is unavailable")
            await dispatch_board_team_assignment(db, item=item, user=current_user)
            response = external_loop_item_provider.get(db, item_id, current_user.id)
        from app.tasks.robot_queue_tasks import consume_queues_background

        background_tasks.add_task(consume_queues_background)
        return LoopItemResponse.model_validate(response)
    item = loop_item_service.assign(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
        values=values,
    )
    if values.assignee_type == "agent":
        from app.services.board_team_execution import dispatch_board_team_assignment

        await dispatch_board_team_assignment(db, item=item, user=current_user)
        db.refresh(item)
    from app.tasks.robot_queue_tasks import consume_queues_background

    background_tasks.add_task(consume_queues_background)
    publish_loop_item_changed(
        db,
        item=item,
        reason="assignment",
        actor_user_id=current_user.id,
    )
    access = cloud_project_service.access(db, project_id, current_user.id)
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, current_user.id, access=access)
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/approve",
    response_model=LoopItemResponse,
)
def approve_loop_item_run(
    project_id: int,
    item_id: str,
    values: LoopItemApproval,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    """Approve a pending robot run. Only the robot creator can approve."""

    if external_loop_item_provider.is_external_item(db, item_id):
        response = external_loop_item_provider.approve_run(
            db,
            project_id=project_id,
            item_id=item_id,
            user_id=current_user.id,
            values=values,
        )
        from app.tasks.robot_queue_tasks import consume_queues_background

        background_tasks.add_task(consume_queues_background)
        return LoopItemResponse.model_validate(response)
    item = loop_item_service.approve_run(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
        values=values,
    )
    from app.tasks.robot_queue_tasks import consume_queues_background

    background_tasks.add_task(consume_queues_background)
    publish_loop_item_changed(
        db,
        item=item,
        reason="execution_approved",
        actor_user_id=current_user.id,
    )
    access = cloud_project_service.access(db, project_id, current_user.id)
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, current_user.id, access=access)
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/reject",
    response_model=LoopItemResponse,
)
def reject_loop_item_run(
    project_id: int,
    item_id: str,
    values: LoopItemApproval,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    """Reject a pending robot run. Only the robot creator can reject."""

    if external_loop_item_provider.is_external_item(db, item_id):
        response = external_loop_item_provider.reject_run(
            db,
            project_id=project_id,
            item_id=item_id,
            user_id=current_user.id,
            values=values,
        )
        return LoopItemResponse.model_validate(response)
    item = loop_item_service.reject_run(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
        values=values,
    )
    publish_loop_item_changed(
        db,
        item=item,
        reason="execution_rejected",
        actor_user_id=current_user.id,
    )
    access = cloud_project_service.access(db, project_id, current_user.id)
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, current_user.id, access=access)
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_cloud_project(
    project_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    cloud_project_service.archive(db, project_id, current_user.id, version)


@router.get("/{project_id}/members", response_model=list[CloudProjectMemberResponse])
def list_cloud_project_members(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> list[CloudProjectMemberResponse]:
    members = cloud_project_service.list_members(db, project_id, current_user.id)
    return [CloudProjectMemberResponse.model_validate(member) for member in members]


@router.post(
    "/{project_id}/members",
    response_model=CloudProjectMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_cloud_project_member(
    project_id: int,
    values: CloudProjectMemberCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectMemberResponse:
    member = cloud_project_service.add_member(db, project_id, current_user.id, values)
    return CloudProjectMemberResponse.model_validate(member)


@router.patch(
    "/{project_id}/members/{member_user_id}",
    response_model=CloudProjectMemberResponse,
)
def update_cloud_project_member(
    project_id: int,
    member_user_id: int,
    values: CloudProjectMemberUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectMemberResponse:
    member = cloud_project_service.update_member(
        db, project_id, member_user_id, current_user.id, values
    )
    return CloudProjectMemberResponse.model_validate(member)


@router.delete(
    "/{project_id}/members/{member_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_cloud_project_member(
    project_id: int,
    member_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    cloud_project_service.remove_member(db, project_id, member_user_id, current_user.id)


@router.get("/{project_id}/files", response_model=CloudFileListResponse)
def list_cloud_files(
    project_id: int,
    prefix: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudFileListResponse:
    files = cloud_file_service.list(db, project_id, current_user.id, prefix)
    return CloudFileListResponse(
        items=[CloudFileResponse.model_validate(file) for file in files]
    )


@router.get(
    "/{project_id}/delivery-files", response_model=ProjectDeliveryFileListResponse
)
def list_project_delivery_files(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectDeliveryFileListResponse:
    rows = cloud_file_service.list_delivery_files(db, project_id, current_user.id)
    return ProjectDeliveryFileListResponse(
        items=[
            ProjectDeliveryFileResponse(
                asset_id=row.asset.id,
                delivery_id=row.delivery.id,
                loop_item_id=row.item.id,
                loop_item_title=row.item.title or row.item.id,
                relative_path=row.asset.relative_path,
                display_name=row.asset.display_name,
                content_type=row.asset.content_type,
                size_bytes=row.asset.size_bytes,
                delivered_at=row.delivery.delivered_at,
                loop_item_path=[
                    ProjectDeliveryItemPathResponse(
                        id=item.id, title=item.title or item.id
                    )
                    for item in row.item_path
                ],
            )
            for row in rows
            if row.delivery.delivered_at is not None
        ]
    )


@router.post(
    "/{project_id}/folders",
    response_model=CloudFileResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_cloud_folder(
    project_id: int,
    values: CloudFolderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    folder = cloud_file_service.create_folder(
        db, project_id, current_user.id, values.path, values.description
    )
    return CloudFileResponse.model_validate(folder)


@router.post(
    "/{project_id}/files",
    response_model=CloudFileResponse,
    status_code=status.HTTP_201_CREATED,
)
def upload_cloud_file(
    project_id: int,
    file: UploadFile = File(...),
    path: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    uploaded = cloud_file_service.upload(
        db,
        project_id,
        current_user.id,
        path,
        file.content_type or "application/octet-stream",
        file.file,
    )
    return CloudFileResponse.model_validate(uploaded)


@router.get("/files/{file_id}/access", response_model=CloudFileAccessResponse)
def access_cloud_file(
    file_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudFileAccessResponse:
    return CloudFileAccessResponse(
        url=cloud_file_service.access_url(db, file_id, current_user.id)
    )


@router.get("/files/{file_id}/content")
def read_cloud_file(
    file_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    content, content_type, filename = cloud_file_service.read_content(
        db, file_id, current_user.id
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.patch("/files/{file_id}", response_model=CloudFileResponse)
def move_cloud_file(
    file_id: int,
    values: CloudFileMove,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    file = cloud_file_service.move(
        db, file_id, current_user.id, values.path, values.version
    )
    return CloudFileResponse.model_validate(file)


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cloud_file(
    file_id: int,
    recursive: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    cloud_file_service.delete(db, file_id, current_user.id, recursive)
