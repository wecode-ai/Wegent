# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for collaboration Workspaces."""

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole, has_permission
from app.services.workspaces.storage import (
    CollaborationWorkspace,
    get_workspace_kind,
    workspace_from_kind,
)


@dataclass(frozen=True)
class WorkspaceAccess:
    workspace: CollaborationWorkspace
    role: BaseRole


def require_workspace_role(
    db: Session,
    workspace_id: int,
    user_id: int,
    required_role: BaseRole = BaseRole.Reporter,
) -> WorkspaceAccess:
    kind = get_workspace_kind(db, workspace_id)
    if kind is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    membership = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.resource_id == workspace_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    try:
        role = BaseRole(membership.role)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Invalid Workspace role"
        ) from exc
    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return WorkspaceAccess(workspace=workspace_from_kind(kind), role=role)
