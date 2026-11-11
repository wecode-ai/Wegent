# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit chat-group grants, separate from the project permission contract."""

from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup, loop_datetime_value_is_unset
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole

GROUP_RESOURCE_TYPE = "CollaborationChatGroup"
GROUP_ROLES = frozenset({"Owner", "Maintainer", "Developer", "Viewer"})


def chat_group_member_grants(
    db: Session, group_id: str, *, lock: bool = False, user_ids: set[int] | None = None
) -> dict[int, ResourceMember]:
    """Read canonical explicit grants without taking any account locks."""
    query = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == GROUP_RESOURCE_TYPE,
            ResourceMember.resource_id == int(group_id),
            ResourceMember.entity_type == "user",
            ResourceMember.status == "approved",
            ResourceMember.role.in_(GROUP_ROLES),
        )
        .order_by(ResourceMember.id)
    )
    if lock:
        query = query.with_for_update().populate_existing()
    grants = query.all()
    by_user_id = {}
    for grant in grants:
        value = grant.entity_id
        if value and value.isascii() and value.isdecimal():
            user_id = int(value)
            if (
                0 < user_id <= 2**31 - 1
                and str(user_id) == value
                and (user_ids is None or user_id in user_ids)
            ):
                by_user_id[user_id] = grant
    return by_user_id


def chat_group_members(
    db: Session, group_id: str, *, lock: bool = False, user_ids: set[int] | None = None
) -> list[dict[str, object]]:
    """Project-independent roster for already authorized group surfaces."""
    by_user_id = chat_group_member_grants(db, group_id, lock=lock, user_ids=user_ids)
    if not by_user_id:
        return []
    if lock:
        users = []
        for user_id in sorted(by_user_id):
            user = (
                db.query(User)
                .filter(User.id == user_id)
                .with_for_update()
                .populate_existing()
                .one_or_none()
            )
            if user is not None and user.is_active:
                users.append(user)
    else:
        users = (
            db.query(User)
            .filter(User.id.in_(by_user_id), User.is_active.is_(True))
            .order_by(User.id)
            .all()
        )
    return [
        {
            "id": by_user_id[user.id].id,
            "user_id": user.id,
            "user_name": user.user_name,
            "email": None,
            "role": by_user_id[user.id].role,
            "direct_role": by_user_id[user.id].role,
            "permission_sources": [
                {"type": "direct", "role": by_user_id[user.id].role}
            ],
            "can_be_assignee": by_user_id[user.id].role != "Viewer",
        }
        for user in users
    ]


def chat_group_role(
    db: Session, group_id: int | str, user_id: int, *, lock: bool = False
) -> BaseRole | None:
    """A group requires its own current approved grant and an active actor."""
    if lock:
        group = (
            db.query(CollaborationChatGroup)
            .filter(CollaborationChatGroup.id == str(group_id))
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        user = (
            db.query(User)
            .filter(User.id == user_id)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
    else:
        group = db.get(CollaborationChatGroup, str(group_id))
        user = db.get(User, user_id)
    if (
        group is None
        or user is None
        or not user.is_active
        or not loop_datetime_value_is_unset(group.deleted_at)
        or group.status not in {"active", "archived"}
    ):
        return None
    query = db.query(ResourceMember).filter(
        ResourceMember.resource_type == GROUP_RESOURCE_TYPE,
        ResourceMember.resource_id == int(group.id),
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status == "approved",
        ResourceMember.role.in_(GROUP_ROLES),
    )
    if lock:
        query = query.with_for_update().populate_existing()
    grant = query.one_or_none()
    return BaseRole(grant.role) if grant else None
