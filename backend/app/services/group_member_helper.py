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

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.namespace import GroupRole

# Define epoch time for default datetime values
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


# Resource type for namespace/group memberships
NAMESPACE_RESOURCE_TYPE = "Namespace"


def get_namespace_id_by_name(db: Session, group_name: str) -> Optional[int]:
    """Get namespace ID by name."""
    namespace = (
        db.query(Namespace)
        .filter(Namespace.name == group_name, Namespace.is_active == True)
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
            ResourceMember.user_id == user_id,
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


def get_user_groups_with_roles(db: Session, user_id: int) -> list[tuple[str, str]]:
    """
    Get all group names and roles for a user.

    Args:
        db: Database session
        user_id: User ID

    Returns:
        List of tuples (group_name, role)
    """
    # Get all approved memberships for user
    memberships = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.user_id == user_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )

    # Get namespace names for each membership
    result = []
    namespace_ids = [m.resource_id for m in memberships]
    if namespace_ids:
        namespaces = (
            db.query(Namespace)
            .filter(Namespace.id.in_(namespace_ids), Namespace.is_active == True)
            .all()
        )
        namespace_map = {n.id: n.name for n in namespaces}

        for membership in memberships:
            group_name = namespace_map.get(membership.resource_id)
            if group_name:
                result.append((group_name, membership.role))

    return result


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
        user_id=user_id,
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
