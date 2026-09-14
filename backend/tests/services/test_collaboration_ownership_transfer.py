# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from app.core.security import get_password_hash
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.cloud_project import CloudProjectCreate, CloudProjectMemberCreate
from app.schemas.workspace import WorkspaceCreate, WorkspaceMemberCreate
from app.services.cloud_projects.service import cloud_project_service
from app.services.workspaces import workspace_service


def _member_user(test_db) -> User:
    user = User(
        user_name="new-owner",
        password_hash=get_password_hash("testpassword123"),
        email="new-owner@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def test_workspace_ownership_transfer_demotes_previous_owner(
    test_db, test_user
) -> None:
    new_owner = _member_user(test_db)
    workspace = workspace_service.create(
        test_db,
        test_user.id,
        WorkspaceCreate(name="Shared workspace"),
    )
    workspace_service.add_member(
        test_db,
        workspace.id,
        test_user.id,
        WorkspaceMemberCreate(
            user_id=new_owner.id,
            role=BaseRole.Developer,
        ),
    )

    transferred = workspace_service.transfer_ownership(
        test_db,
        workspace.id,
        new_owner.id,
        test_user.id,
    )

    assert transferred.created_by_user_id == new_owner.id
    assert not transferred.is_default
    assert (
        workspace_service.access(test_db, workspace.id, new_owner.id).role
        == BaseRole.Owner
    )
    assert (
        workspace_service.access(test_db, workspace.id, test_user.id).role
        == BaseRole.Maintainer
    )


def test_project_ownership_transfer_demotes_previous_owner(test_db, test_user) -> None:
    new_owner = _member_user(test_db)
    project = cloud_project_service.create(
        test_db,
        test_user.id,
        CloudProjectCreate(name="Shared project"),
    )
    cloud_project_service.add_member(
        test_db,
        project.id,
        test_user.id,
        CloudProjectMemberCreate(
            user_id=new_owner.id,
            role=BaseRole.Developer,
        ),
    )

    transferred = cloud_project_service.transfer_ownership(
        test_db,
        project.id,
        new_owner.id,
        test_user.id,
    )

    assert transferred.created_by_user_id == new_owner.id
    assert (
        cloud_project_service.access(test_db, project.id, new_owner.id).role
        == BaseRole.Owner
    )
    assert (
        cloud_project_service.access(test_db, project.id, test_user.id).role
        == BaseRole.Maintainer
    )
