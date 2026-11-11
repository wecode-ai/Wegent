"""Project classification aggregates Threads without granting group authority."""

from collections import defaultdict

from sqlalchemy import BigInteger, cast, select
from sqlalchemy.orm import Session, aliased
from sqlalchemy.sql import Select

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    ThreadProjectLink,
    loop_datetime_is_unset,
)
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.chat_group_access import (
    GROUP_RESOURCE_TYPE,
    GROUP_ROLES,
    chat_group_role,
)
from app.services.cloud_projects.access import CloudProjectAccess


def linked_thread_ids(
    project_id: str, user_id: int, *, include_archived: bool = False
) -> Select:
    """Select potentially readable Threads inside the board's existing query."""
    group = aliased(CollaborationChatGroup)
    thread = aliased(LoopItem)
    link = aliased(ThreadProjectLink)
    query = (
        select(thread.id)
        .select_from(group)
        .join(thread, thread.cloud_project_id == group.id)
        .join(link, link.loop_item_id == thread.id)
        .join(ResourceMember, ResourceMember.resource_id == cast(group.id, BigInteger))
        .join(User, User.id == user_id)
        .filter(
            User.is_active.is_(True),
            ResourceMember.resource_type == GROUP_RESOURCE_TYPE,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == "approved",
            ResourceMember.role.in_(GROUP_ROLES),
            group.status.in_(("active", "archived")),
            loop_datetime_is_unset(group.deleted_at),
            link.parent_id == str(project_id),
            link.status == "active",
            loop_datetime_is_unset(link.deleted_at),
        )
    )
    return (
        query
        if include_archived
        else query.filter(loop_datetime_is_unset(thread.deleted_at))
    )


def linked_thread_values(
    db: Session, items: list[LoopItem], user_id: int
) -> list[dict[str, object]]:
    """Each projection uses its owning group role, never the project role."""
    from app.services.loop_items.service import loop_item_service

    grouped: dict[str, list[LoopItem]] = defaultdict(list)
    for item in items:
        grouped[str(item.cloud_project_id)].append(item)
    result = []
    for group_id, threads in grouped.items():
        # Reject noncanonical IDs before the numeric role lookup. The SQL join
        # avoids mixed text collations; the projection requires an exact identity.
        if (
            not group_id.isascii()
            or not group_id.isdecimal()
            or str(int(group_id)) != group_id
        ):
            continue
        role = chat_group_role(db, group_id, user_id)
        if role is None:
            continue
        owner = db.get(CollaborationChatGroup, group_id)
        access = CloudProjectAccess(project=owner, role=role)
        result.extend(
            loop_item_service.response_values_many(db, threads, user_id, access=access)
        )
    return result


def external_project_thread_values(
    db: Session, project_id: str, user_id: int, **filters: str | None
) -> list[dict[str, object]]:
    from app.services.loop_items.listing import filtered_items

    query = db.query(LoopItem).filter(
        LoopItem.id.in_(linked_thread_ids(project_id, user_id)),
        loop_datetime_is_unset(LoopItem.deleted_at),
    )
    return linked_thread_values(db, filtered_items(query, **filters), user_id)
