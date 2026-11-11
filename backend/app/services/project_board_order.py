# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project presentation ranks never rewrite owning-group task order or grants."""

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    ThreadProjectLink,
    loop_datetime_is_unset,
)
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.loop_item_position import LoopItemPosition
from app.services.chat_group_access import chat_group_role
from app.services.loop_items.access import visible_item_filter
from app.services.project_classification_access import (
    require_classification_project_access,
)

ORDER_KEY = "board_item_order"


def project_ranks(metadata: object) -> dict[str, int]:
    values = metadata.get(ORDER_KEY, {}) if isinstance(metadata, dict) else {}
    return {
        key: value
        for key, value in (values.items() if isinstance(values, dict) else [])
        if isinstance(key, str) and type(value) is int and value >= 0
    }


class ProjectBoardOrder(list[LoopItem]):
    def __init__(self, project: CloudProject, items: list[LoopItem]) -> None:
        super().__init__(items)
        self.project = project

    def persist(self) -> None:
        ranks = project_ranks(self.project.metadata_json)
        ranks.update({item.id: rank for rank, item in enumerate(self)})
        self.project.version += 1
        self.project.metadata_json = {
            **(self.project.metadata_json or {}),
            ORDER_KEY: ranks,
        }


def position_project_items(
    db: Session,
    item: LoopItem,
    parent_id: str | None,
    position: LoopItemPosition,
    user_id: int,
) -> ProjectBoardOrder:
    project_id = position.classification_project_id
    if (
        project_id is None
        or not project_id.isascii()
        or not project_id.isdecimal()
        or str(int(project_id)) != project_id
        or not 0 < int(project_id) <= 2**63 - 1
    ):
        raise HTTPException(422, "Invalid ordering project identity")
    access = require_classification_project_access(db, project_id, user_id)
    project = access.project
    links = (
        db.query(ThreadProjectLink)
        .filter(
            ThreadProjectLink.parent_id == project_id,
            ThreadProjectLink.status == "active",
            loop_datetime_is_unset(ThreadProjectLink.deleted_at),
        )
        .order_by(ThreadProjectLink.id)
        .with_for_update()
        .populate_existing()
        .all()
    )
    legacy = LoopItem.cloud_project_id == project_id
    if not has_permission(access.role, BaseRole.Maintainer):
        legacy = legacy & visible_item_filter(user_id, project)
    candidates = (
        db.query(LoopItem)
        .filter(
            or_(legacy, LoopItem.id.in_([link.loop_item_id for link in links])),
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        .order_by(LoopItem.id)
        .with_for_update()
        .populate_existing()
        .all()
    )
    owners = {
        candidate.cloud_project_id
        for candidate in candidates
        if candidate.cloud_project_id != project_id
    }
    roles = {}
    for owner in sorted(owners):
        if owner.isascii() and owner.isdecimal() and str(int(owner)) == owner:
            roles[owner] = chat_group_role(db, owner, user_id, lock=True)
    siblings = [
        candidate
        for candidate in candidates
        if (candidate.parent_id or None) == (parent_id or None)
        and (
            candidate.cloud_project_id == project_id
            or roles.get(candidate.cloud_project_id) is not None
        )
    ]
    if item.cloud_project_id != project_id and (
        roles.get(item.cloud_project_id) is None
        or not has_permission(roles[item.cloud_project_id], BaseRole.Developer)
    ):
        raise HTTPException(403, "Owning group editing is required")
    if (
        item.cloud_project_id != project_id
        and db.get(CollaborationChatGroup, item.cloud_project_id).status != "active"
    ):
        raise HTTPException(409, "Owning group is archived")
    if not any(candidate.id == item.id for candidate in siblings):
        raise HTTPException(422, "Moving item is not classified in this project")
    ranks = project_ranks(project.metadata_json)
    siblings.sort(
        key=lambda candidate: (
            ranks.get(candidate.id, candidate.sort_order),
            -candidate.updated_at.timestamp(),
            candidate.id,
        )
    )
    siblings = [candidate for candidate in siblings if candidate.id != item.id]
    anchor = position.before_item_id
    index = next(
        (index for index, candidate in enumerate(siblings) if candidate.id == anchor),
        len(siblings) if anchor is None else -1,
    )
    if index < 0:
        raise HTTPException(422, "Position anchor is not an authorized project sibling")
    siblings.insert(index, item)
    return ProjectBoardOrder(project, siblings)


def project_order_values(project: CloudProject, values: list[dict]) -> list[dict]:
    ranks = project_ranks(project.metadata_json)
    return [
        {**value, "sort_order": ranks.get(value["id"], value["sort_order"])}
        for value in values
    ]
