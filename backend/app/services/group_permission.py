# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.schemas.namespace import GroupRole


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
    member = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    if member:
        return GroupRole(member.role)

    return None


def check_group_permission(
    db: Session, user_id: int, group_name: str, required_role: GroupRole
) -> bool:
    """
    Check if user has required permission level in a group.

    Permission hierarchy: Owner > Maintainer > Developer > Reporter
    A user with a higher role can perform actions of lower roles.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name
        required_role: Minimum required role

    Returns:
        True if user has permission, False otherwise
    """
    # Define role hierarchy (lower number = higher permission)
    role_hierarchy = {
        GroupRole.Owner: 0,
        GroupRole.Maintainer: 1,
        GroupRole.Developer: 2,
        GroupRole.Reporter: 3,
    }

    user_role = get_user_role_in_group(db, user_id, group_name)

    if user_role is None:
        return False

    # Check if user's role level is equal or higher than required
    return role_hierarchy[user_role] <= role_hierarchy[required_role]


def get_user_groups(db: Session, user_id: int) -> list[str]:
    """
    Get all group names that user has access to, including inherited permissions
    from parent groups.

    Permission inheritance logic:
    - If user is a member of 'aaa', they have access to 'aaa/bbb', 'aaa/bbb/ccc', etc.
    - Direct memberships take precedence over inherited permissions

    Args:
        db: Database session
        user_id: User ID

    Returns:
        List of group names (without duplicates)
    """
    # Get all active groups
    all_groups = db.query(Namespace).filter(Namespace.is_active == True).all()

    # Get user's direct memberships
    direct_memberships = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .all()
    )

    direct_group_names = {m.group_name for m in direct_memberships}
    accessible_groups = set(direct_group_names)

    # Check permission inheritance for all groups
    for group in all_groups:
        # Skip if already in accessible set
        if group.name in accessible_groups:
            continue

        # Check if user has access via parent group membership
        # Example: if user is member of 'aaa', they have access to 'aaa/bbb', 'aaa/bbb/ccc'
        if "/" in group.name:
            # Check each parent in the hierarchy
            parts = group.name.split("/")
            for i in range(1, len(parts)):
                parent_name = "/".join(parts[:i])
                if parent_name in direct_group_names:
                    accessible_groups.add(group.name)
                    break

    return sorted(accessible_groups)


def get_effective_role_in_group(
    db: Session, user_id: int, group_name: str
) -> Optional[GroupRole]:
    """
    Get user's effective role in a group, considering inheritance from parent groups.

    Inheritance rules:
    - Direct membership role takes precedence
    - If no direct membership, inherits from nearest parent group
    - Inherited roles maintain their level (Owner stays Owner, etc.)

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name

    Returns:
        GroupRole if user has access (direct or inherited), None otherwise
    """
    # First check direct membership
    direct_role = get_user_role_in_group(db, user_id, group_name)
    if direct_role is not None:
        return direct_role

    # Check parent groups (from nearest to farthest)
    if "/" in group_name:
        parts = group_name.split("/")
        # Check from nearest parent upward
        for i in range(len(parts) - 1, 0, -1):
            parent_name = "/".join(parts[:i])
            parent_role = get_user_role_in_group(db, user_id, parent_name)
            if parent_role is not None:
                # Return the same role level from parent
                return parent_role

    return None


def check_user_group_permission(
    user_id: int, group_name: str, min_role: str = "Reporter"
) -> bool:
    """
    Check if user has required permission level in a group.
    This is a standalone function that manages its own DB session.

    Permission hierarchy: Owner > Maintainer > Developer > Reporter
    A user with a higher role can perform actions of lower roles.

    Args:
        user_id: User ID
        group_name: Group name (namespace)
        min_role: Minimum required role as string ("Reporter", "Developer", "Maintainer", "Owner")

    Returns:
        True if user has permission, False otherwise
    """
    from app.db.session import SessionLocal

    # Convert string role to GroupRole enum
    try:
        required_role = GroupRole(min_role)
    except ValueError:
        return False

    with SessionLocal() as db:
        return check_group_permission(db, user_id, group_name, required_role)
