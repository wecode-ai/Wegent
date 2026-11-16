# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Plan atomic tag cleanup across the registry, Issues and saved projections."""

from copy import deepcopy

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.schemas.board_views import BoardViews
from app.schemas.cloud_project import CloudProjectUpdate
from app.schemas.tagging import normalize_tags
from app.services.cloud_projects.admin_errors import config_error

REMOVED_TAGS_KEY = "project_removed_tags"


def validate_issue_tags(project: CloudProject, tags: list[str]) -> None:
    removed = set((project.metadata_json or {}).get(REMOVED_TAGS_KEY, []))
    if removed.intersection(tags):
        raise config_error(
            "invalid_config",
            "A removed tag must be recreated in project settings before reuse",
            field="tags",
        )


def _replace(tags: list[str], changes: dict[str, str | None]) -> list[str]:
    return list(
        dict.fromkeys(
            target for tag in tags if (target := changes.get(tag, tag)) is not None
        )
    )


def require_writable_views(metadata: dict) -> None:
    config = metadata.get("board_views")
    if config is not None and (
        not isinstance(config, dict) or config.get("schema_version", 1) != 1
    ):
        raise config_error(
            "version_conflict",
            "Upgrade before changing board views saved by a newer version",
            field="board_views",
            status_code=409,
        )


def _view_references(metadata: dict, changes: dict[str, str | None]) -> None:
    config = metadata.get("board_views")
    if config is not None:
        require_writable_views(metadata)
        try:
            BoardViews.model_validate(config)
            for index, view in enumerate(config.get("views", [])):
                removed = set()
                for column in view["columns"]:
                    if column["type"] == "tag" and column["value"] in changes:
                        target = changes[column["value"]]
                        if target is None:
                            removed.add(column["id"])
                        else:
                            column["value"] = target
                view["columns"] = [
                    column for column in view["columns"] if column["id"] not in removed
                ]
                if not view["columns"]:
                    raise config_error(
                        "partial_reference_conflict",
                        "Removing this tag would leave a saved view without columns",
                        field=f"board_views.views.{index}.columns",
                    )
                if "filter" in view:
                    view["filter"]["tags"] = _replace(
                        view["filter"].get("tags", []), changes
                    )
                if "sorts" in view:
                    view["sorts"] = {
                        key: rules
                        for key, rules in view["sorts"].items()
                        if key not in removed
                    }
            BoardViews.model_validate(config)
        except (ValidationError, AttributeError, KeyError, TypeError) as exc:
            raise config_error(
                "partial_reference_conflict",
                "A saved view has unsupported tag references",
                field="board_views",
            ) from exc
    schedule = metadata.get("board_config", {}).get("schedule_view", {})
    if schedule.get("tag_filter") in changes:
        schedule["tag_filter"] = changes[schedule["tag_filter"]]


def plan_tag_update(
    db: Session, project: CloudProject, values: CloudProjectUpdate
) -> tuple[dict, list[tuple[LoopItem, dict]], list[str] | None]:
    """Validate every reference before mutating mapped objects, including archives."""
    metadata = deepcopy(project.metadata_json or {})
    current = list(project.tags)
    target = values.tags
    changes: dict[str, str | None] = {}
    if values.tag_change is not None:
        old, new = values.tag_change.source, values.tag_change.target
        if old not in current:
            raise config_error(
                "invalid_config", "Tag does not exist", field="tag_change.source"
            )
        changes[old] = new
        target = _replace(current, changes)
    elif target is not None:
        changes = {tag: None for tag in current if tag not in target}
    if target is not None:
        removed = set(metadata.get(REMOVED_TAGS_KEY, []))
        removed.update(
            tag for tag, replacement in changes.items() if tag != replacement
        )
        metadata[REMOVED_TAGS_KEY] = sorted(removed - set(target))
    if not changes:
        return metadata, [], target
    if project.task_provider != "local":
        raise config_error(
            "partial_reference_conflict",
            "External provider references cannot be changed atomically",
            field="tags",
        )
    require_writable_views(metadata)
    # A replacement is checked as part of the complete submitted configuration.
    previous_views = metadata.pop("board_views", None) if values.board_views else None
    _view_references(metadata, changes)
    if previous_views is not None:
        metadata["board_views"] = previous_views
    items = (
        db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == project.id)
        .order_by(LoopItem.id)
        .populate_existing()
        .with_for_update()
        .all()
    )
    planned = []
    for item in items:
        if item.metadata_json is not None and not isinstance(item.metadata_json, dict):
            raise config_error(
                "partial_reference_conflict",
                "An Issue has unsupported tag references",
                field=f"issues.{item.id}.tags",
            )
        item_metadata = deepcopy(item.metadata_json or {})
        if item_metadata.get("tags") is not None and not isinstance(
            item_metadata["tags"], list
        ):
            raise config_error(
                "partial_reference_conflict",
                "An Issue has unsupported tag references",
                field=f"issues.{item.id}.tags",
            )
        original = normalize_tags(item_metadata.get("tags"))
        tags = _replace(original, changes)
        if tags != original:
            item_metadata["tags"] = tags
            planned.append((item, item_metadata))
    return metadata, planned, target
