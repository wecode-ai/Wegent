# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace lifecycle and aggregate summary operations."""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.workspace import (
    Workspace,
    WorkspaceAgentBinding,
    WorkspaceExecutionEnvironment,
)
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate
from app.services.workspaces.access import WorkspaceAccess, require_workspace_role
from app.services.workspaces.members import ensure_human_member


class WorkspaceLifecycleService:
    """Manage Workspace creation, discovery, updates, and archival."""

    def create(
        self,
        db: Session,
        user_id: int,
        values: WorkspaceCreate,
    ) -> Workspace:
        has_workspace = (
            db.query(Workspace.id)
            .filter(
                Workspace.created_by_user_id == user_id,
                Workspace.status == "active",
            )
            .first()
            is not None
        )
        workspace = _new_workspace(
            user_id=user_id,
            name=values.name,
            description=values.description,
            is_default=values.is_default or not has_workspace,
        )
        db.add(workspace)
        try:
            db.flush()
            if workspace.is_default:
                _clear_other_defaults(db, user_id, workspace.id)
            db.add(_owner_membership(workspace.id, user_id))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Workspace could not be created"
            ) from exc
        db.refresh(workspace)
        return workspace

    def get_or_create_default(self, db: Session, user_id: int) -> Workspace:
        workspace = (
            db.query(Workspace)
            .filter(
                Workspace.created_by_user_id == user_id,
                Workspace.status == "active",
                Workspace.is_default.is_(True),
            )
            .order_by(Workspace.id)
            .first()
        )
        if workspace is not None:
            return workspace

        workspace = (
            db.query(Workspace)
            .filter(
                Workspace.created_by_user_id == user_id,
                Workspace.status == "active",
            )
            .order_by(Workspace.id)
            .first()
        )
        if workspace is not None:
            workspace.is_default = True
            workspace.version += 1
            _clear_other_defaults(db, user_id, workspace.id)
            ensure_human_member(
                db,
                workspace_id=workspace.id,
                user_id=user_id,
                role=BaseRole.Owner,
            )
            db.flush()
            return workspace

        workspace = _new_workspace(
            user_id=user_id,
            name="默认协作空间",
            description="",
            is_default=True,
        )
        db.add(workspace)
        db.flush()
        db.add(_owner_membership(workspace.id, user_id))
        return workspace

    def list_accessible(self, db: Session, user_id: int) -> list[Workspace]:
        member_workspace_ids = select(ResourceMember.resource_id).where(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        return (
            db.query(Workspace)
            .filter(
                Workspace.status == "active",
                or_(
                    Workspace.created_by_user_id == user_id,
                    Workspace.id.in_(member_workspace_ids),
                ),
            )
            .order_by(Workspace.is_default.desc(), Workspace.updated_at.desc())
            .all()
        )

    def get(self, db: Session, workspace_id: int, user_id: int) -> Workspace:
        return require_workspace_role(db, workspace_id, user_id).workspace

    def access(self, db: Session, workspace_id: int, user_id: int) -> WorkspaceAccess:
        return require_workspace_role(db, workspace_id, user_id)

    def summary_counts(self, db: Session, workspace_id: int) -> dict[str, int]:
        member_count = (
            db.query(func.count(ResourceMember.id))
            .filter(
                ResourceMember.resource_type == ResourceType.WORKSPACE.value,
                ResourceMember.resource_id == workspace_id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .scalar()
            or 0
        )
        project_count = (
            db.query(func.count(CloudProject.id))
            .filter(
                CloudProject.workspace_id == workspace_id,
                CloudProject.status == "active",
            )
            .scalar()
            or 0
        )
        agent_count = (
            db.query(func.count(WorkspaceAgentBinding.id))
            .filter(WorkspaceAgentBinding.workspace_id == workspace_id)
            .scalar()
            or 0
        )
        environment_count = (
            db.query(func.count(WorkspaceExecutionEnvironment.id))
            .filter(WorkspaceExecutionEnvironment.workspace_id == workspace_id)
            .scalar()
            or 0
        )
        return {
            "member_count": int(member_count),
            "project_count": int(project_count),
            "agent_count": int(agent_count),
            "execution_environment_count": int(environment_count),
        }

    def update(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceUpdate,
    ) -> Workspace:
        workspace = require_workspace_role(
            db, workspace_id, user_id, BaseRole.Maintainer
        ).workspace
        updates = values.model_dump(exclude={"version"}, exclude_none=True)
        if updates.get("is_default"):
            _clear_other_defaults(db, workspace.created_by_user_id, workspace.id)
        updated = (
            db.query(Workspace)
            .filter(
                Workspace.id == workspace.id,
                Workspace.version == values.version,
            )
            .update({**updates, "version": Workspace.version + 1})
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Workspace changed")
        db.commit()
        db.refresh(workspace)
        return workspace

    def archive(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        version: int,
    ) -> None:
        workspace = require_workspace_role(
            db, workspace_id, user_id, BaseRole.Owner
        ).workspace
        active_project = (
            db.query(CloudProject.id)
            .filter(
                CloudProject.workspace_id == workspace.id,
                CloudProject.status == "active",
            )
            .first()
        )
        if active_project is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Archive or move active Projects before archiving the Workspace",
            )
        updated = (
            db.query(Workspace)
            .filter(
                Workspace.id == workspace.id,
                Workspace.version == version,
                Workspace.status == "active",
            )
            .update(
                {
                    "status": "archived",
                    "is_default": False,
                    "version": Workspace.version + 1,
                }
            )
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Workspace changed")
        db.commit()


def _new_workspace(
    *,
    user_id: int,
    name: str,
    description: str,
    is_default: bool,
) -> Workspace:
    return Workspace(
        public_id=str(uuid.uuid4()),
        name=name,
        description=description,
        created_by_user_id=user_id,
        is_default=is_default,
        status="active",
    )


def _owner_membership(workspace_id: int, user_id: int) -> ResourceMember:
    return ResourceMember.create(
        resource_type=ResourceType.WORKSPACE.value,
        resource_id=workspace_id,
        entity_id=str(user_id),
        role=BaseRole.Owner.value,
        status=MemberStatus.APPROVED.value,
    )


def _clear_other_defaults(
    db: Session,
    user_id: int,
    workspace_id: int,
) -> None:
    (
        db.query(Workspace)
        .filter(
            Workspace.created_by_user_id == user_id,
            Workspace.id != workspace_id,
            Workspace.is_default.is_(True),
        )
        .update({"is_default": False}, synchronize_session=False)
    )
