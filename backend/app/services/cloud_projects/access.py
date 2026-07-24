# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for cloud collaboration resources."""

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole, has_permission


@dataclass(frozen=True)
class CloudProjectAccess:
    project: CloudProject
    role: BaseRole


def require_cloud_project_role(
    db: Session,
    cloud_project_id: int,
    user_id: int,
    required_role: BaseRole = BaseRole.Reporter,
) -> CloudProjectAccess:
    project = (
        db.query(CloudProject)
        .filter(
            CloudProject.id == cloud_project_id,
            CloudProject.status == "active",
        )
        .first()
    )
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")

    if project.created_by_user_id == user_id:
        role = BaseRole.Owner
    else:
        membership = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == cloud_project_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        if membership is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        try:
            role = BaseRole(membership.role)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Invalid cloud project role"
            ) from exc

    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return CloudProjectAccess(project=project, role=role)
