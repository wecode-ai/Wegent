# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace lifecycle and aggregate summary operations."""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate
from app.services.workspaces.access import WorkspaceAccess, require_workspace_role
from app.services.workspaces.members import ensure_human_member
from app.services.workspaces.storage import (
    COLLABORATION_WORKSPACE_KIND,
    WORKSPACE_ENTITY_TYPE,
    CollaborationWorkspace,
    get_workspace_kind,
    project_ids_for_workspace,
    workspace_from_kind,
    workspace_kind_payload,
)


class WorkspaceLifecycleService:
    """Manage Workspace creation, discovery, updates, and archival."""

    def create(
        self, db: Session, user_id: int, values: WorkspaceCreate
    ) -> CollaborationWorkspace:
        is_default = values.is_default or not self._owned_active_kinds(db, user_id)
        public_id = str(uuid.uuid4())
        kind = Kind(
            user_id=user_id,
            kind=COLLABORATION_WORKSPACE_KIND,
            name=values.name,
            namespace="default",
            json=workspace_kind_payload(
                name=values.name,
                description=values.description,
                public_id=public_id,
                is_default=is_default,
            ),
            is_active=True,
        )
        db.add(kind)
        try:
            db.flush()
            if is_default:
                self._clear_other_defaults(db, user_id, int(kind.id))
            db.add(_owner_membership(int(kind.id), user_id))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Workspace could not be created"
            ) from exc
        db.refresh(kind)
        return workspace_from_kind(kind)

    def get_or_create_default(
        self, db: Session, user_id: int
    ) -> CollaborationWorkspace:
        owned = self._owned_active_kinds(db, user_id)
        for kind in owned:
            workspace = workspace_from_kind(kind)
            if workspace.is_default:
                ensure_human_member(
                    db,
                    workspace_id=workspace.id,
                    user_id=user_id,
                    role=BaseRole.Owner,
                )
                return workspace
        if owned:
            kind = owned[0]
            self._set_kind_values(kind, is_default=True)
            self._clear_other_defaults(db, user_id, int(kind.id))
            ensure_human_member(
                db,
                workspace_id=int(kind.id),
                user_id=user_id,
                role=BaseRole.Owner,
            )
            db.flush()
            return workspace_from_kind(kind)
        return self._create_uncommitted_default(db, user_id)

    def list_accessible(
        self, db: Session, user_id: int
    ) -> list[CollaborationWorkspace]:
        workspace_ids = select(ResourceMember.resource_id).where(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        kinds = (
            db.query(Kind)
            .filter(
                Kind.kind == COLLABORATION_WORKSPACE_KIND,
                Kind.is_active.is_(True),
                Kind.id.in_(workspace_ids),
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )
        workspaces = [workspace_from_kind(kind) for kind in kinds]
        return sorted(
            workspaces,
            key=lambda item: (not item.is_default, -item.updated_at.timestamp()),
        )

    def get(
        self, db: Session, workspace_id: int, user_id: int
    ) -> CollaborationWorkspace:
        return require_workspace_role(db, workspace_id, user_id).workspace

    def access(self, db: Session, workspace_id: int, user_id: int) -> WorkspaceAccess:
        return require_workspace_role(db, workspace_id, user_id)

    def summary_counts(self, db: Session, workspace_id: int) -> dict[str, int]:
        member_count = self._grant_count(
            db,
            resource_type=ResourceType.WORKSPACE.value,
            workspace_id=workspace_id,
            entity_type="user",
            resource_side=True,
        )
        return {
            "member_count": member_count,
            "project_count": self._grant_count(
                db,
                resource_type=ResourceType.CLOUD_PROJECT.value,
                workspace_id=workspace_id,
            ),
            "agent_count": self._grant_count(
                db,
                resource_type=ResourceType.TEAM.value,
                workspace_id=workspace_id,
            ),
            "execution_environment_count": self._grant_count(
                db,
                resource_type=ResourceType.DEVICE.value,
                workspace_id=workspace_id,
            ),
        }

    def update(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceUpdate,
    ) -> CollaborationWorkspace:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
        kind = (
            db.query(Kind)
            .filter(
                Kind.id == workspace_id,
                Kind.kind == COLLABORATION_WORKSPACE_KIND,
            )
            .with_for_update()
            .one()
        )
        current = workspace_from_kind(kind)
        if current.version != values.version:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Workspace changed")
        next_default = (
            values.is_default if values.is_default is not None else current.is_default
        )
        if next_default:
            self._clear_other_defaults(db, current.created_by_user_id, workspace_id)
        self._set_kind_values(
            kind,
            name=values.name,
            description=values.description,
            is_default=next_default,
        )
        db.commit()
        db.refresh(kind)
        return workspace_from_kind(kind)

    def archive(
        self, db: Session, workspace_id: int, user_id: int, version: int
    ) -> None:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Owner)
        if project_ids_for_workspace(db, workspace_id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Archive or move active Projects before archiving the Workspace",
            )
        kind = get_workspace_kind(db, workspace_id)
        if kind is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
        if workspace_from_kind(kind).version != version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Workspace changed")
        self._set_kind_values(kind, is_default=False, state="archived")
        kind.is_active = False
        db.commit()

    def _create_uncommitted_default(
        self, db: Session, user_id: int
    ) -> CollaborationWorkspace:
        public_id = str(uuid.uuid4())
        kind = Kind(
            user_id=user_id,
            kind=COLLABORATION_WORKSPACE_KIND,
            name="默认协作空间",
            namespace="default",
            json=workspace_kind_payload(
                name="默认协作空间",
                description="",
                public_id=public_id,
                is_default=True,
            ),
            is_active=True,
        )
        db.add(kind)
        db.flush()
        db.add(_owner_membership(int(kind.id), user_id))
        return workspace_from_kind(kind)

    @staticmethod
    def _grant_count(
        db: Session,
        *,
        resource_type: str,
        workspace_id: int,
        entity_type: str = WORKSPACE_ENTITY_TYPE,
        resource_side: bool = False,
    ) -> int:
        query = db.query(func.count(ResourceMember.id)).filter(
            ResourceMember.resource_type == resource_type,
            ResourceMember.entity_type == entity_type,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        if resource_side:
            query = query.filter(ResourceMember.resource_id == workspace_id)
        else:
            query = query.filter(ResourceMember.entity_id == str(workspace_id))
        return int(query.scalar() or 0)

    @staticmethod
    def _owned_active_kinds(db: Session, user_id: int) -> list[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == COLLABORATION_WORKSPACE_KIND,
                Kind.is_active.is_(True),
            )
            .order_by(Kind.id)
            .all()
        )

    @staticmethod
    def _set_kind_values(
        kind: Kind,
        *,
        name: str | None = None,
        description: str | None = None,
        is_default: bool | None = None,
        state: str = "active",
    ) -> None:
        current = workspace_from_kind(kind)
        next_name = name if name is not None else current.name
        kind.name = next_name
        kind.json = workspace_kind_payload(
            name=next_name,
            description=(
                description if description is not None else current.description
            ),
            public_id=current.public_id,
            is_default=(is_default if is_default is not None else current.is_default),
            version=current.version + 1,
        )
        kind.json["status"]["state"] = state

    def _clear_other_defaults(
        self, db: Session, user_id: int, workspace_id: int
    ) -> None:
        for kind in self._owned_active_kinds(db, user_id):
            if int(kind.id) != workspace_id and workspace_from_kind(kind).is_default:
                self._set_kind_values(kind, is_default=False)


def _owner_membership(workspace_id: int, user_id: int) -> ResourceMember:
    return ResourceMember.create(
        resource_type=ResourceType.WORKSPACE.value,
        resource_id=workspace_id,
        entity_id=str(user_id),
        role=BaseRole.Owner.value,
        status=MemberStatus.APPROVED.value,
    )
