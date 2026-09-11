# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Collaboration Workspace API shared by Wegent and Wework clients."""

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.cloud_project import (
    CloudProjectCreate,
    CloudProjectListResponse,
    CloudProjectResponse,
)
from app.schemas.workspace import (
    PersonalResourcesResponse,
    WorkspaceAgentCreate,
    WorkspaceAgentListResponse,
    WorkspaceAgentResponse,
    WorkspaceAgentUpdate,
    WorkspaceCreate,
    WorkspaceExecutionEnvironmentCreate,
    WorkspaceExecutionEnvironmentListResponse,
    WorkspaceExecutionEnvironmentResponse,
    WorkspaceListResponse,
    WorkspaceMemberCreate,
    WorkspaceMemberListResponse,
    WorkspaceMemberResponse,
    WorkspaceMemberUpdate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services.cloud_projects import cloud_project_service
from app.services.workspaces import workspace_service

router = APIRouter()
resources_router = APIRouter()


def _response(
    db: Session,
    workspace: object,
    current_user: User,
) -> WorkspaceResponse:
    access = workspace_service.access(db, int(workspace.id), current_user.id)
    return WorkspaceResponse.model_validate(
        {
            **workspace.__dict__,
            "access_role": access.role,
            **workspace_service.summary_counts(db, int(workspace.id)),
        }
    )


def _project_response(
    db: Session,
    project: object,
    current_user: User,
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


@resources_router.get("", response_model=PersonalResourcesResponse)
def list_personal_resources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> PersonalResourcesResponse:
    return PersonalResourcesResponse.model_validate(
        workspace_service.list_personal_resources(db, current_user.id)
    )


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
def create_workspace(
    values: WorkspaceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceResponse:
    workspace = workspace_service.create(db, current_user.id, values)
    return _response(db, workspace, current_user)


@router.get("", response_model=WorkspaceListResponse)
def list_workspaces(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceListResponse:
    return WorkspaceListResponse(
        items=[
            _response(db, workspace, current_user)
            for workspace in workspace_service.list_accessible(db, current_user.id)
        ]
    )


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceResponse:
    workspace = workspace_service.get(db, workspace_id, current_user.id)
    return _response(db, workspace, current_user)


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
def update_workspace(
    workspace_id: int,
    values: WorkspaceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceResponse:
    workspace = workspace_service.update(db, workspace_id, current_user.id, values)
    return _response(db, workspace, current_user)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_workspace(
    workspace_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    workspace_service.archive(db, workspace_id, current_user.id, version)


@router.get(
    "/{workspace_id}/members",
    response_model=WorkspaceMemberListResponse,
)
def list_workspace_members(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceMemberListResponse:
    return WorkspaceMemberListResponse(
        items=[
            WorkspaceMemberResponse.model_validate(member)
            for member in workspace_service.list_members(
                db, workspace_id, current_user.id
            )
        ]
    )


@router.post(
    "/{workspace_id}/members",
    response_model=WorkspaceMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_workspace_member(
    workspace_id: int,
    values: WorkspaceMemberCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceMemberResponse:
    return WorkspaceMemberResponse.model_validate(
        workspace_service.add_member(db, workspace_id, current_user.id, values)
    )


@router.patch(
    "/{workspace_id}/members/{member_user_id}",
    response_model=WorkspaceMemberResponse,
)
def update_workspace_member(
    workspace_id: int,
    member_user_id: int,
    values: WorkspaceMemberUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceMemberResponse:
    return WorkspaceMemberResponse.model_validate(
        workspace_service.update_member(
            db,
            workspace_id,
            member_user_id,
            current_user.id,
            values,
        )
    )


@router.delete(
    "/{workspace_id}/members/{member_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_workspace_member(
    workspace_id: int,
    member_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    workspace_service.remove_member(db, workspace_id, member_user_id, current_user.id)


@router.get(
    "/{workspace_id}/agents",
    response_model=WorkspaceAgentListResponse,
)
def list_workspace_agents(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceAgentListResponse:
    return WorkspaceAgentListResponse(
        items=[
            WorkspaceAgentResponse.model_validate(agent)
            for agent in workspace_service.list_agents(
                db, workspace_id, current_user.id
            )
        ]
    )


@router.post(
    "/{workspace_id}/agents",
    response_model=WorkspaceAgentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_workspace_agent(
    workspace_id: int,
    values: WorkspaceAgentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceAgentResponse:
    return WorkspaceAgentResponse.model_validate(
        workspace_service.add_agent(db, workspace_id, current_user.id, values)
    )


@router.patch(
    "/{workspace_id}/agents/{team_id}",
    response_model=WorkspaceAgentResponse,
)
def update_workspace_agent(
    workspace_id: int,
    team_id: int,
    values: WorkspaceAgentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceAgentResponse:
    return WorkspaceAgentResponse.model_validate(
        workspace_service.update_agent(
            db, workspace_id, team_id, current_user.id, values
        )
    )


@router.delete(
    "/{workspace_id}/agents/{team_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_workspace_agent(
    workspace_id: int,
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    workspace_service.remove_agent(db, workspace_id, team_id, current_user.id)


@router.get(
    "/{workspace_id}/execution-environments",
    response_model=WorkspaceExecutionEnvironmentListResponse,
)
def list_workspace_execution_environments(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceExecutionEnvironmentListResponse:
    return WorkspaceExecutionEnvironmentListResponse(
        items=[
            WorkspaceExecutionEnvironmentResponse.model_validate(environment)
            for environment in workspace_service.list_execution_environments(
                db, workspace_id, current_user.id
            )
        ]
    )


@router.post(
    "/{workspace_id}/execution-environments",
    response_model=WorkspaceExecutionEnvironmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_workspace_execution_environment(
    workspace_id: int,
    values: WorkspaceExecutionEnvironmentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkspaceExecutionEnvironmentResponse:
    return WorkspaceExecutionEnvironmentResponse.model_validate(
        workspace_service.add_execution_environment(
            db, workspace_id, current_user.id, values
        )
    )


@router.delete(
    "/{workspace_id}/execution-environments/{device_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_workspace_execution_environment(
    workspace_id: int,
    device_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    workspace_service.remove_execution_environment(
        db, workspace_id, device_id, current_user.id
    )


@router.get(
    "/{workspace_id}/projects",
    response_model=CloudProjectListResponse,
)
def list_workspace_projects(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudProjectListResponse:
    projects = cloud_project_service.list_accessible(
        db,
        current_user.id,
        workspace_id=workspace_id,
    )
    return CloudProjectListResponse(
        items=[_project_response(db, project, current_user) for project in projects]
    )


@router.post(
    "/{workspace_id}/projects",
    response_model=CloudProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_workspace_project(
    workspace_id: int,
    values: CloudProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CloudProjectResponse:
    project = cloud_project_service.create(
        db,
        current_user.id,
        values.model_copy(update={"workspace_id": str(workspace_id)}),
    )
    return _project_response(db, project, current_user)
