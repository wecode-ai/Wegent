"""Search accessible managed resources before pagination and adapter hydration."""

import logging
from time import perf_counter
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.models.user import User
from app.schemas.resource_search import ResourceSearchResponse
from app.services.adapters.team_kinds import team_kinds_service
from app.services.resource_library_service import (
    _decode_discovery_cursor,
    _encode_discovery_cursor,
    _escape_sql_like,
    _resource_json_text,
)
from app.services.team_list_filters import (
    build_team_list_filters,
    validate_team_list_groups,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)


def _search_filters(
    db: Session, keyword: str, cursor: str | None
) -> list[ColumnElement[bool]]:
    owner_name = select(User.user_name).where(User.id == Kind.user_id).scalar_subquery()
    fields = [
        Kind.name,
        _resource_json_text(db, "$.metadata.displayName"),
        _resource_json_text(db, "$.spec.description"),
        owner_name,
    ]
    pattern = f"%{_escape_sql_like(keyword.lower())}%"
    filters = []
    if keyword:
        filters.append(
            or_(*(func.lower(field).like(pattern, escape="\\") for field in fields))
        )
    if cursor:
        _, updated_at, resource_id = _decode_discovery_cursor(cursor)
        filters.append(
            or_(
                Kind.updated_at < updated_at,
                and_(Kind.updated_at == updated_at, Kind.id < resource_id),
            )
        )
    return filters


@trace_sync(span_name="resources.search", tracer_name="backend.resources")
def search_resources(
    db: Session,
    *,
    user_id: int,
    keyword: str,
    scope: Literal["personal", "group", "all"],
    group_name: str | None,
    limit: int,
    cursor: str | None,
    owned_only: bool = False,
    group_names: list[str] | None = None,
    source_filter: Literal["all", "mine", "personal", "group", "system"] = "all",
    mode: Literal["all", "chat", "code", "task", "knowledge", "video", "image"] = "all",
) -> ResourceSearchResponse:
    started = perf_counter()
    keyword = keyword.strip()
    if not keyword:
        raise HTTPException(status_code=422, detail="Search keyword must not be empty")
    validate_team_list_groups(db, user_id, group_name, group_names)
    filters = _search_filters(db, keyword, cursor)
    filters.extend(build_team_list_filters(db, user_id, source_filter, mode))
    if owned_only:
        filters.append(Kind.user_id == user_id)
    items = team_kinds_service.get_user_teams(
        db=db,
        user_id=user_id,
        scope=scope,
        group_name=group_name,
        limit=limit + 1,
        filters=filters,
        group_names=group_names,
        shared_only=source_filter == "group",
    )
    has_more = len(items) > limit
    items = items[:limit]
    next_cursor = None
    if has_more:
        next_cursor = _encode_discovery_cursor(
            None, items[-1]["updated_at"], items[-1]["id"]
        )
    logger.info(
        "[resource_search] user_id=%s scope=%s owned_only=%s keyword_length=%s returned=%s "
        "has_more=%s elapsed_ms=%.1f",
        user_id,
        scope,
        owned_only,
        len(keyword),
        len(items),
        has_more,
        (perf_counter() - started) * 1000,
    )
    return ResourceSearchResponse(
        items=items, has_more=has_more, next_cursor=next_cursor, limit=limit
    )
