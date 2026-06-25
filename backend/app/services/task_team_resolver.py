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
