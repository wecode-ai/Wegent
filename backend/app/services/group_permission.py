# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from functools import lru_cache
from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.namespace import GroupRole
from app.services.group_member_helper import (
    NAMESPACE_RESOURCE_TYPE,
    get_user_groups_with_roles,
    get_user_role_in_group,
)

# Simple in-memory cache for user groups with TTL
_user_groups_cache: dict[int, tuple[list[str], float]] = {}
_USER_GROUPS_CACHE_TTL = 60  # Cache for 60 seconds


def _get_cached_user_groups(user_id: int) -> Optional[list[str]]:
    """Get cached user groups if not expired."""
    if user_id in _user_groups_cache:
        groups, timestamp = _user_groups_cache[user_id]
        if time.time() - timestamp < _USER_GROUPS_CACHE_TTL:
            return groups
        # Cache expired, remove it
        del _user_groups_cache[user_id]
    return None


def _set_cached_user_groups(user_id: int, groups: list[str]) -> None:
    """Cache user groups with current timestamp."""
    _user_groups_cache[user_id] = (groups, time.time())


def invalidate_user_groups_cache(user_id: Optional[int] = None) -> None:
    """Invalidate user groups cache for a specific user or all users."""
    global _user_groups_cache
    if user_id is not None:
        _user_groups_cache.pop(user_id, None)
    else:
        _user_groups_cache.clear()


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
    from app.services.group_member_helper import (
        get_user_role_in_group as helper_get_role,
    )

    role_str = helper_get_role(db, user_id, group_name)
    if role_str:
        try:
            return GroupRole(role_str)
        except ValueError:
            return None
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
        GroupRole.RestrictedObserver: 4,
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
    import logging

    logger = logging.getLogger(__name__)

    # Check cache first
    cached = _get_cached_user_groups(user_id)
    if cached is not None:
        logger.debug(
            f"[get_user_groups] Cache hit for user_id={user_id}, returning {len(cached)} groups"
        )
        return cached

    start_time = time.time()

    # Get all active groups
    all_groups = db.query(Namespace).filter(Namespace.is_active == True).all()

    # Get user's direct memberships with roles
    direct_memberships = get_user_groups_with_roles(db, user_id)

    # Create a mapping of group_name -> role
    direct_group_names = {name for name, _ in direct_memberships}
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

    result = sorted(accessible_groups)

    # Cache the result
    _set_cached_user_groups(user_id, result)

    elapsed = time.time() - start_time
    logger.info(
        f"[get_user_groups] Computed and cached for user_id={user_id}, found {len(result)} groups, took {elapsed:.3f}s"
    )

    return result


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
    import logging

    logger = logging.getLogger(__name__)

    # First check direct membership
    logger.info(
        f"[get_effective_role_in_group] Checking direct membership for user={user_id} in group='{group_name}'"
    )
    direct_role = get_user_role_in_group(db, user_id, group_name)
    logger.info(
        f"[get_effective_role_in_group] Direct role for user={user_id} in group='{group_name}': {direct_role}"
    )
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
