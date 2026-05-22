# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Group membership helper using ResourceMember model.

This module provides helper functions for group membership operations
using the unified resource_members table with resource_type='Namespace'.

This replaces the direct usage of NamespaceMember model.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.namespace import GroupRole

# Define epoch time for default datetime values
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


# Resource type for namespace/group memberships
NAMESPACE_RESOURCE_TYPE = "Namespace"

# Maximum entity members per group (configurable)
MAX_ENTITY_MEMBERS_PER_GROUP = settings.MAX_ENTITY_MEMBERS_PER_GROUP


def get_namespace_id_by_name(db: Session, group_name: str) -> Optional[int]:
    """Get namespace ID by name."""
    namespace = (
        db.query(Namespace)
        .filter(Namespace.name == group_name, Namespace.is_active)
        .first()
    )
    return namespace.id if namespace else None


def get_group_member(
    db: Session, group_name: str, user_id: int
) -> Optional[ResourceMember]:
    """
    Get group membership record for a user.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID

    Returns:
        ResourceMember if found, None otherwise
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return None

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )


def get_user_role_in_group(
    db: Session, user_id: int, group_name: str
) -> Optional[GroupRole]:
    """
    Get user's role in a specific group.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name

    Returns:
        GroupRole if user is a member, None otherwise
    """
    member = get_group_member(db, group_name, user_id)
    if member and member.role:
        try:
            return GroupRole(member.role)
        except ValueError:
            return None
    return None


def is_group_member(db: Session, group_name: str, user_id: int) -> bool:
    """
    Check if user is a member of a group.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID

    Returns:
        True if user is a member, False otherwise
    """
    return get_group_member(db, group_name, user_id) is not None


def get_group_members(db: Session, group_name: str) -> list[ResourceMember]:
    """
    Get all approved members of a group.

    Args:
        db: Database session
        group_name: Group name

    Returns:
        List of ResourceMember records
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return []

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )


def get_group_member_count(db: Session, group_name: str) -> int:
    """
    Get the number of approved members in a group.

    Args:
        db: Database session
        group_name: Group name

    Returns:
        Number of approved members
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return 0

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .count()
    )


def create_group_member(
    db: Session,
    group_name: str,
    user_id: int,
    role: str,
    invited_by_user_id: int,
) -> Optional[ResourceMember]:
    """
    Create a new group membership.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID
        role: Role to assign
        invited_by_user_id: User ID of the inviter

    Returns:
        Created ResourceMember or None if group not found
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return None

    member = ResourceMember(
        resource_type=NAMESPACE_RESOURCE_TYPE,
        resource_id=namespace_id,
        entity_type="user",
        entity_id=str(user_id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=invited_by_user_id,
        share_link_id=0,
        reviewed_by_user_id=0,
        reviewed_at=EPOCH_TIME,
        copied_resource_id=0,
        requested_at=datetime.now(),
    )

    db.add(member)
    db.flush()

    return member


def delete_group_member(db: Session, group_name: str, user_id: int) -> bool:
    """
    Delete a group membership.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID

    Returns:
        True if deleted, False if not found
    """
    member = get_group_member(db, group_name, user_id)
    if member:
        db.delete(member)
        db.flush()
        return True
    return False


def count_group_members_by_role(db: Session, group_name: str, role: str) -> int:
    """
    Count members with a specific role in a group.

    Args:
        db: Database session
        group_name: Group name
        role: Role to count

    Returns:
        Number of members with the role
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return 0

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.role == role,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .count()
    )


def create_group_entity_member(
    db: Session,
    group_name: str,
    entity_type: str,
    entity_id: str,
    role: str,
    entity_display_name: Optional[str] = None,
    invited_by_user_id: int = 0,
) -> Optional[ResourceMember]:
    """Create a new entity-type group membership.

    Args:
        db: Database session
        group_name: Group name
        entity_type: Entity type (e.g., 'org_department')
        entity_id: Entity identifier
        role: Role to assign
        entity_display_name: Optional display name snapshot
        invited_by_user_id: User ID of the inviter

    Returns:
        Created ResourceMember or None if group not found
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return None

    member = ResourceMember.create(
        resource_type=NAMESPACE_RESOURCE_TYPE,
        resource_id=namespace_id,
        entity_type=entity_type,
        entity_id=entity_id,
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=invited_by_user_id,
        entity_display_name=entity_display_name,
    )
    db.add(member)
    db.flush()
    return member


def get_group_entity_members(db: Session, group_name: str) -> list[ResourceMember]:
    """Get all approved entity-type (non-user) members of a group.

    Args:
        db: Database session
        group_name: Group name

    Returns:
        List of ResourceMember records with entity_type != 'user'
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return []

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.entity_type != "user",
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )


def delete_group_entity_member(
    db: Session, group_name: str, entity_type: str, entity_id: str
) -> bool:
    """Delete an entity-type group membership.

    Does not filter by status so pending/rejected bindings can also be
    cleaned up.
        db: Database session
        group_name: Group name
        entity_type: Entity type
        entity_id: Entity identifier

    Returns:
        True if deleted, False if not found
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return False

    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.entity_type == entity_type,
            ResourceMember.entity_id == entity_id,
        )
        .first()
    )
    if member:
        db.delete(member)
        db.flush()
        return True
    return False


def update_group_entity_member_role(
    db: Session,
    group_name: str,
    entity_type: str,
    entity_id: str,
    role: str,
) -> Optional[ResourceMember]:
    """Update the role of an entity-type group membership.

    Args:
        db: Database session
        group_name: Group name
        entity_type: Entity type
        entity_id: Entity identifier
        role: New role to assign

    Returns:
        Updated ResourceMember or None if not found
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return None

    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.entity_type == entity_type,
            ResourceMember.entity_id == entity_id,
        )
        .first()
    )
    if member:
        member.role = role
        db.flush()
        return member
    return None


def create_group_entity_members_batch(
    db: Session,
    group_name: str,
    members: list,
    invited_by_user_id: int,
) -> tuple[list[ResourceMember], list]:
    """Batch create entity members, returning (succeeded, failed).

    Args:
        db: Database session
        group_name: Group name
        members: List of GroupEntityMemberCreate objects
        invited_by_user_id: User ID of the inviter

    Returns:
        Tuple of (succeeded ResourceMember list, failed dict list)

    Raises:
        ValueError: If group not found or limit exceeded
    """
    from app.schemas.group_entity_member import BatchFailedItem

    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        raise ValueError(f"Group not found: {group_name}")

    existing_members = get_group_entity_members(db, group_name)
    existing_count = len(existing_members)
    existing_keys = {(m.entity_type, m.entity_id) for m in existing_members}

    if existing_count >= MAX_ENTITY_MEMBERS_PER_GROUP:
        raise ValueError(
            f"Group entity member limit reached: {existing_count} >= {MAX_ENTITY_MEMBERS_PER_GROUP}"
        )

    remaining_slots = MAX_ENTITY_MEMBERS_PER_GROUP - existing_count
    if len(members) > remaining_slots:
        raise ValueError(
            f"Batch size ({len(members)}) exceeds remaining slots ({remaining_slots})"
        )

    succeeded: list[ResourceMember] = []
    failed: list = []

    for member_create in members:
        key = (member_create.entity_type, member_create.entity_id)

        if key in existing_keys:
            failed.append(
                BatchFailedItem(
                    entity_id=member_create.entity_id,
                    entity_type=member_create.entity_type,
                    error="Entity member already exists in this group",
                )
            )
            continue

        member = ResourceMember.create(
            resource_type=NAMESPACE_RESOURCE_TYPE,
            resource_id=namespace_id,
            entity_type=member_create.entity_type,
            entity_id=member_create.entity_id,
            role=member_create.role.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=invited_by_user_id,
            entity_display_name=member_create.entity_display_name,
        )
        db.add(member)
        succeeded.append(member)

    if succeeded:
        try:
            db.flush()
            db.commit()
        except Exception:
            # On commit failure, rollback and move succeeded to failed.
            # This supports idempotent retry: on retry, duplicate items
            # will be filtered by existing_keys check in next call.
            db.rollback()
            for m in succeeded:
                failed.append(
                    BatchFailedItem(
                        entity_id=m.entity_id,
                        entity_type=m.entity_type,
                        error="Database constraint violation",
                    )
                )
            succeeded.clear()

    return succeeded, failed


def get_group_all_members(db: Session, group_name: str) -> list[ResourceMember]:
    """Get all approved members of a group (user + entity).

    Args:
        db: Database session
        group_name: Group name

    Returns:
        List of all approved ResourceMember records
    """
    namespace_id = get_namespace_id_by_name(db, group_name)
    if not namespace_id:
        return []

    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )


def iter_user_groups_with_roles(
    db: Session, user_id: int
) -> list[tuple[str, str, Optional[str], Optional[str]]]:
    """Get all group names and roles for a user, including entity paths.

    Returns tuples of (group_name, role, source_entity_type, source_entity_id).
    For direct user memberships, source is ('user', user_id).
    For entity-derived memberships, source is (entity_type, entity_id).

    When the same group is reached via multiple paths, the highest role wins.

    Args:
        db: Database session
        user_id: User ID

    Returns:
        List of tuples (group_name, role, source_entity_type, source_entity_id)
    """
    from app.schemas.base_role import get_highest_role
    from app.services.share.external_entity_resolver import (
        get_all_entity_types,
        get_entity_resolver,
    )

    # 1) Direct user memberships
    direct_memberships = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )

    # Collect namespace info
    namespace_ids = [m.resource_id for m in direct_memberships]
    namespaces = (
        (
            db.query(Namespace)
            .filter(Namespace.id.in_(namespace_ids), Namespace.is_active)
            .all()
        )
        if namespace_ids
        else []
    )
    namespace_map = {n.id: n.name for n in namespaces}

    # group_name -> list of (role, source_entity_type, source_entity_id)
    group_entries: dict[str, list[tuple[str, Optional[str], Optional[str]]]] = {}

    for m in direct_memberships:
        group_name = namespace_map.get(m.resource_id)
        if group_name:
            group_entries.setdefault(group_name, []).append(
                (m.role, "user", str(user_id))
            )

    # 2) Entity-derived memberships
    for entity_type in get_all_entity_types():
        resolver = get_entity_resolver(entity_type)
        if not resolver:
            continue

        matched_resource_ids = resolver.get_resource_ids_by_entity(
            db, user_id, entity_type, resource_type=NAMESPACE_RESOURCE_TYPE
        )
        if not matched_resource_ids:
            continue

        # Batch query: matched_resource_ids already filtered by resolver,
        # so no per-row entity_id check is needed here.
        entity_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.resource_id.in_(matched_resource_ids),
                ResourceMember.entity_type == entity_type,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )

        entity_namespace_ids = [m.resource_id for m in entity_members]
        entity_namespaces = (
            (
                db.query(Namespace)
                .filter(Namespace.id.in_(entity_namespace_ids), Namespace.is_active)
                .all()
            )
            if entity_namespace_ids
            else []
        )
        entity_namespace_map = {n.id: n.name for n in entity_namespaces}

        for m in entity_members:
            group_name = entity_namespace_map.get(m.resource_id)
            if group_name:
                group_entries.setdefault(group_name, []).append(
                    (m.role, entity_type, m.entity_id)
                )

    # Deduplicate: same group -> highest role, keep source of winning role
    result = []
    for group_name, entries in group_entries.items():
        roles = [e[0] for e in entries]
        highest = get_highest_role(roles)
        # Find first entry with highest role as representative source
        for role, src_type, src_id in entries:
            if role == highest:
                result.append((group_name, highest, src_type, src_id))
                break

    return result


def get_user_groups_with_roles(db: Session, user_id: int) -> list[tuple[str, str]]:
    """Get all group names and roles for a user (backward-compatible format).

    Args:
        db: Database session
        user_id: User ID

    Returns:
        List of tuples (group_name, role)
    """
    return [
        (group_name, role)
        for group_name, role, _src_type, _src_id in iter_user_groups_with_roles(
            db, user_id
        )
    ]
