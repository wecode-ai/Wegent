# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for resolving the Team referenced by a Task CRD."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind


def get_team_ref_owner_id(team_ref: Any, fallback_user_id: int) -> int:
    """Return teamRef.user_id when present, preserving public owner id 0."""
    team_ref_user_id = getattr(team_ref, "user_id", None)
    return fallback_user_id if team_ref_user_id is None else team_ref_user_id


def get_team_ref_owner_id_from_dict(
    team_ref: dict[str, Any], fallback_user_id: int
) -> int:
    """Return teamRef['user_id'] when present, preserving public owner id 0."""
    team_ref_user_id = team_ref.get("user_id")
    return fallback_user_id if team_ref_user_id is None else team_ref_user_id


def resolve_task_team_ref(
    db: Session,
    *,
    team_ref: Any,
    fallback_user_id: int,
) -> Kind | None:
    """Resolve a task's Team by namespace, name, and explicit owner when provided."""
    team_owner_id = get_team_ref_owner_id(team_ref, fallback_user_id)
    return (
        db.query(Kind)
        .filter(
            Kind.kind == "Team",
            Kind.name == team_ref.name,
            Kind.namespace == (team_ref.namespace or "default"),
            Kind.user_id == team_owner_id,
            Kind.is_active == True,
        )
        .first()
    )


def can_user_use_team(db: Session, user_id: int, team: Kind) -> bool:
    """Return whether a user can execute with a resolved Team."""
    if team.user_id == user_id or team.user_id == 0:
        return True

    team_namespace = team.namespace or "default"
    if team_namespace != "default":
        from app.services.readers.groups import groupReader

        if groupReader.is_public(db, team_namespace):
            return True

    from app.models.resource_member import MemberStatus
    from app.models.share_link import ResourceType
    from app.services.adapters.task_kinds.helpers import _get_accessible_team_ids

    accessible_team_ids = _get_accessible_team_ids(
        db,
        user_id,
        [ResourceType.TEAM.value, ResourceType.TEAM.name],
        [MemberStatus.APPROVED.value, "APPROVED"],
    )
    return team.id in accessible_team_ids
