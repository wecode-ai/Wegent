# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Factories for group namespaces and their members in service tests."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User


def group_namespace(db: Session, name: str, *, owner_user_id: int) -> Namespace:
    """Create an active group namespace owned by the given user id."""
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner_user_id,
        visibility="internal",
        level="group",
        is_active=True,
    )
    db.add(namespace)
    db.commit()
    db.refresh(namespace)
    return namespace


def add_group_member(
    db: Session, group: Namespace, user: User, role: str = "Reporter"
) -> None:
    """Approve a direct user membership in the group."""
    db.add(
        ResourceMember.create(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=group.owner_user_id,
        )
    )
    db.commit()
