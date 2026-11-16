# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transactional project tag changes across the catalog, Issues and saved views."""

from copy import deepcopy

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.schemas.board_views import BoardViews
from app.schemas.cloud_project import ProjectTagChange
from app.schemas.delivery import LoopItemUpdate
from app.schemas.tagging import normalize_tags
from shared.telemetry.decorators import trace_sync


def replace_tag(tags: list[str], change: ProjectTagChange) -> list[str]:
    """Replace one tag without losing unrelated tags or introducing duplicates."""
    return list(
        dict.fromkeys(
            change.target if tag == change.source else tag
            for tag in tags
            if tag != change.source or change.target is not None
        )
    )


def change_view_tags(metadata: dict, change: ProjectTagChange) -> None:
    """Validate the complete new projection before writing any Issue."""
    config = metadata.get("board_views")
    if config is None:
        return
    if config.get("schema_version") != 1:
        raise HTTPException(409, "Upgrade before changing tags in newer board views")
    try:
        BoardViews.model_validate(config)
    except ValueError as exc:
        raise HTTPException(422, "Project has invalid board views") from exc
    for view in config.get("views", []):
        removed = set()
        for column in view["columns"]:
            if column["type"] == "tag" and column["value"] == change.source:
                if change.target is None:
                    removed.add(column["id"])
                else:
                    column["value"] = change.target
        view["columns"] = [c for c in view["columns"] if c["id"] not in removed]
        if not view["columns"]:
            raise HTTPException(422, "Edit the view before removing its only lane")
        if "filter" in view:
            view["filter"]["tags"] = replace_tag(view["filter"].get("tags", []), change)
        if "sorts" in view:
            view["sorts"] = {k: v for k, v in view["sorts"].items() if k not in removed}
    try:
        BoardViews.model_validate(config)
    except ValueError as exc:
        raise HTTPException(422, "Tag change would create invalid board views") from exc


@trace_sync("cloud_projects.change_tag", tracer_name="backend")
def change_project_tag(
    db: Session, project_id: int, user_id: int, version: int, change: ProjectTagChange
) -> CloudProject:
    """Commit all references together, or roll back every write on any failure."""
    from app.services.cloud_projects.service import CloudProjectService
    from app.services.loop_items.service import loop_item_service

    try:
        project = CloudProjectService._lock_project(db, project_id)
        if project.version != version:
            raise HTTPException(409, "Cloud project changed")
        if project.task_provider != "local":
            raise HTTPException(
                422, "Project tag changes require locally stored Issues"
            )
        metadata = deepcopy(project.metadata_json or {})
        metadata["tags"] = replace_tag(normalize_tags(metadata.get("tags")), change)
        change_view_tags(metadata, change)
        items = (
            db.query(LoopItem)
            .filter(
                LoopItem.cloud_project_id == project.id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .order_by(LoopItem.id)
            .populate_existing()
            .with_for_update()
            .all()
        )
        for item in items:
            tags = normalize_tags((item.metadata_json or {}).get("tags"))
            if change.source in tags:
                loop_item_service.update(
                    db,
                    item.id,
                    user_id,
                    LoopItemUpdate(
                        version=item.version, tags=replace_tag(tags, change)
                    ),
                    commit=False,
                )
        project.metadata_json = metadata
        project.version += 1
        db.commit()
        db.refresh(project)
        return project
    except Exception:
        db.rollback()
        raise
