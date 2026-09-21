"""Resolve one configured default through the normal Team authorization query."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.adapters.team_kinds import team_kinds_service
from app.services.team_list_filters import TeamModeFilter, build_team_list_filters
from shared.telemetry.decorators import trace_sync


@trace_sync(span_name="teams.resolve_default", tracer_name="backend.teams")
def resolve_default_team(
    db: Session,
    *,
    user_id: int,
    mode: TeamModeFilter,
    name: str,
    namespace: str,
) -> dict[str, Any] | None:
    """Prefer the public default, matching the frontend's existing selection rule."""
    filters = build_team_list_filters(db, user_id, None, mode)
    filters.extend([Kind.name == name, Kind.namespace == namespace])
    accessible = team_kinds_service._build_accessible_teams_query(
        db, user_id=user_id, scope="all", filters=filters
    )
    if accessible is None:
        return None
    query, ranked = accessible
    candidate = (
        query.with_entities(ranked.c.team_id)
        .order_by(
            (ranked.c.team_user_id == 0).desc(),
            ranked.c.team_updated_at.desc(),
            ranked.c.team_id.desc(),
        )
        .first()
    )
    if candidate is None:
        return None
    items = team_kinds_service._load_teams_from_query(
        db,
        user_id=user_id,
        accessible_query=(query.filter(ranked.c.team_id == candidate.team_id), ranked),
        skip=0,
        limit=1,
    )
    return items[0] if items else None
