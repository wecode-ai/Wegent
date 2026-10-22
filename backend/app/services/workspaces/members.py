# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace human membership management."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceMemberCreate, WorkspaceMemberUpdate
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.storage import project_ids_for_workspace


class WorkspaceMemberService:
    """Manage human membership in a Workspace."""

    def list_members(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
    ) -> list[dict[str, object]]:
        workspace = require_workspace_role(db, workspace_id, user_id).workspace
        rows = (
            db.query(ResourceMember, User)
            .join(User, User.id == ResourceMember.user_id)
            .filter(
                ResourceMember.resource_type == ResourceType.WORKSPACE.value,
                ResourceMember.resource_id == workspace_id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .order_by(ResourceMember.id)
            .all()
        )
        members = [_member_values(member, member_user) for member, member_user in rows]
        for entry in members:
            if entry["user_id"] == workspace.owner_user_id:
                entry["role"] = BaseRole.Owner.value
        if not any(member["user_id"] == workspace.owner_user_id for member in members):
            creator = db.get(User, workspace.owner_user_id)
            if creator is not None:
                members.insert(
                    0,
                    {
                        "id": 0,
                        "user_id": creator.id,
                        "user_name": creator.user_name,
                        "email": creator.email,
                        "role": BaseRole.Owner.value,
                    },
                )
        return members

    def add_member(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceMemberCreate,
    ) -> dict[str, object]:
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
        target = db.get(User, values.user_id)
        if target is None or not target.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        member = ensure_human_member(
            db,
            workspace_id=workspace_id,
            user_id=target.id,
            role=values.role,
        )
        if target.id == access.workspace.owner_user_id:
            raise HTTPException(
                409, "Use ownership transfer to change the Workspace owner"
            )
        member.role = (
            "Reporter" if values.role == BaseRole.Viewer else values.role.value
        )
        db.flush()
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        pending = [
            run
            for project_id in project_ids_for_workspace(db, workspace_id)
            for run in revoke_unauthorized_project_work(db, project_id, target.id)
        ]
        db.commit()
        request_execution_cancellations(pending)
        db.refresh(member)
        return _member_values(member, target)

    def update_member(
        self,
        db: Session,
        workspace_id: int,
        member_user_id: int,
        user_id: int,
        values: WorkspaceMemberUpdate,
    ) -> dict[str, object]:
        workspace = require_workspace_role(
            db, workspace_id, user_id, BaseRole.Maintainer
        ).workspace
        if member_user_id == workspace.owner_user_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Workspace owner is immutable"
            )
        member, target = _get_member(db, workspace_id, member_user_id)
        member.role = (
            "Reporter" if values.role == BaseRole.Viewer else values.role.value
        )
        db.flush()
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        pending = [
            run
            for project_id in project_ids_for_workspace(db, workspace_id)
            for run in revoke_unauthorized_project_work(db, project_id, member_user_id)
        ]
        db.commit()
        request_execution_cancellations(pending)
        db.refresh(member)
        return _member_values(member, target)

    def remove_member(
        self,
        db: Session,
        workspace_id: int,
        member_user_id: int,
        user_id: int,
    ) -> None:
        workspace = require_workspace_role(
            db, workspace_id, user_id, BaseRole.Maintainer
        ).workspace
        if member_user_id == workspace.owner_user_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Workspace owner cannot be removed"
            )
        project_ids = project_ids_for_workspace(db, workspace.id)
        member, _ = _get_member(db, workspace_id, member_user_id)
        (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id.in_(project_ids),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(member_user_id),
            )
            .delete(synchronize_session=False)
        )
        db.delete(member)
        db.flush()
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        pending = [
            run
            for project_id in project_ids
            for run in revoke_unauthorized_project_work(db, project_id, member_user_id)
        ]
        db.commit()
        request_execution_cancellations(pending)

    def ensure_human_member(
        self,
        db: Session,
        *,
        workspace_id: int,
        user_id: int,
        role: BaseRole = BaseRole.Viewer,
    ) -> ResourceMember:
        return ensure_human_member(
            db,
            workspace_id=workspace_id,
            user_id=user_id,
            role=role,
        )


def ensure_human_member(
    db: Session,
    *,
    workspace_id: int,
    user_id: int,
    role: BaseRole = BaseRole.Viewer,
) -> ResourceMember:
    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.resource_id == workspace_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
        )
        .first()
    )
    if member is None:
        member = ResourceMember.create(
            resource_type=ResourceType.WORKSPACE.value,
            resource_id=workspace_id,
            entity_id=str(user_id),
            role=BaseRole.Maintainer.value if role == BaseRole.Owner else role.value,
            status=MemberStatus.APPROVED.value,
        )
        db.add(member)
    else:
        member.status = MemberStatus.APPROVED.value
        if role == BaseRole.Owner:
            member.role = BaseRole.Maintainer.value
    return member


def _member_values(member: ResourceMember, user: User) -> dict[str, object]:
    from app.services.cloud_project_visibility import collaboration_role

    return {
        "id": member.id,
        "user_id": user.id,
        "user_name": user.user_name,
        "email": user.email,
        "role": collaboration_role(member.role),
    }


def _get_member(
    db: Session,
    workspace_id: int,
    member_user_id: int,
) -> tuple[ResourceMember, User]:
    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.resource_id == workspace_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(member_user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )
    user = db.get(User, member_user_id)
    if member is None or user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace member not found")
    return member, user
