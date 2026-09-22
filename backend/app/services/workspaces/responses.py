# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Batch workspace list metadata without querying each workspace separately."""

from sqlalchemy import BigInteger, cast, func, literal, select, union_all
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.workspace import WorkspaceResponse
from app.services.cloud_project_visibility import user_memberships
from app.services.workspaces import workspace_service

COUNT_FIELDS = {
    ResourceType.WORKSPACE.value: "member_count",
    ResourceType.CLOUD_PROJECT.value: "project_count",
    ResourceType.TEAM.value: "agent_count",
    ResourceType.DEVICE.value: "execution_environment_count",
}


def _summary_counts(db: Session, ids: list[int]) -> dict[int, dict[str, int]]:
    members = (
        select(
            ResourceMember.resource_id,
            literal(ResourceType.WORKSPACE.value),
            func.count(ResourceMember.id),
        )
        .where(
            ResourceMember.resource_type == ResourceType.WORKSPACE.value,
            ResourceMember.entity_type == "user",
            ResourceMember.status == MemberStatus.APPROVED.value,
            ResourceMember.resource_id.in_(ids),
        )
        .group_by(ResourceMember.resource_id)
    )
    grants = (
        select(
            cast(ResourceMember.entity_id, BigInteger),
            ResourceMember.resource_type,
            func.count(ResourceMember.id),
        )
        .where(
            ResourceMember.resource_type.in_(
                [key for key in COUNT_FIELDS if key != ResourceType.WORKSPACE.value]
            ),
            ResourceMember.entity_type == "workspace",
            ResourceMember.status == MemberStatus.APPROVED.value,
            ResourceMember.entity_id.in_([str(value) for value in ids]),
        )
        .group_by(ResourceMember.entity_id, ResourceMember.resource_type)
    )
    rows = db.execute(union_all(members, grants)).all()
    counts = {value: {} for value in ids}
    for workspace, resource_type, count in rows:
        counts[int(workspace)][COUNT_FIELDS[resource_type]] = count
    return counts


def list_workspace_responses(db: Session, user_id: int) -> list[WorkspaceResponse]:
    workspaces = workspace_service.list_accessible(db, user_id)
    if not workspaces:
        return []
    ids = [workspace.id for workspace in workspaces]
    roles = dict(
        db.execute(
            user_memberships(user_id, ResourceType.WORKSPACE.value).where(
                ResourceMember.resource_id.in_(ids)
            )
        ).all()
    )
    counts = _summary_counts(db, ids)
    return [
        WorkspaceResponse.model_validate(
            {
                **workspace.__dict__,
                "access_role": roles[workspace.id],
                **counts[workspace.id],
            }
        )
        for workspace in workspaces
    ]
