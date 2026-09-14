# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared read-visibility query for Cloud Projects."""

from sqlalchemy import or_, select
from sqlalchemy.orm import Query, Session

from app.models.cloud_project import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole

VALID_CLOUD_PROJECT_MEMBER_ROLES = tuple(role.value for role in BaseRole)


def accessible_cloud_projects(db: Session, user_id: int) -> Query[CloudProject]:
    """Return active Cloud Projects the user can genuinely read."""

    member_project_ids = select(ResourceMember.resource_id).where(
        ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status == MemberStatus.APPROVED.value,
        ResourceMember.role.in_(VALID_CLOUD_PROJECT_MEMBER_ROLES),
    )
    return db.query(CloudProject).filter(
        CloudProject.status == "active",
        or_(
            CloudProject.created_by_user_id == user_id,
            CloudProject.id.in_(member_project_ids),
            CloudProject.metadata_json["visibility"].as_string() == "public",
        ),
    )
