"""Shared filters for managed agent browsing and search."""

from typing import Literal

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.schemas.namespace import GroupRole
from app.services.group_permission import check_group_permission
from app.services.resource_library_service import _resource_json_text

TeamSourceFilter = Literal["all", "mine", "personal", "group", "system"]
TeamModeFilter = Literal["all", "chat", "code", "task", "knowledge", "video", "image"]


def validate_team_list_groups(
    db: Session, user_id: int, group_name: str | None, group_names: list[str] | None
) -> None:
    for namespace in set(group_names or []) | ({group_name} if group_name else set()):
        if not check_group_permission(db, user_id, namespace, GroupRole.Reporter):
            raise HTTPException(status_code=403, detail="Group access denied")


def build_team_list_filters(
    db: Session,
    user_id: int,
    source_filter: TeamSourceFilter | None,
    mode: TeamModeFilter | None,
) -> list[ColumnElement[bool]]:
    filters = []
    if source_filter in ("mine", "personal"):
        filters.append(Kind.user_id == user_id)
    if source_filter == "personal":
        filters.append(Kind.namespace == "default")
    elif source_filter == "system":
        filters.append(Kind.user_id == 0)
    if mode is not None:
        modes = _resource_json_text(db, "$.spec.bind_mode")
        filters.append(modes != "[]")
        if mode != "all":
            filters.append(or_(modes.in_(["", "null"]), modes.like(f'%"{mode}"%')))
    return filters
