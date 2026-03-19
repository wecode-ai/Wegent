# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.base_role import has_permission
from app.schemas.namespace import GroupRole
from app.services.group_member_helper import (
    NAMESPACE_RESOURCE_TYPE,
    get_user_groups_with_roles,
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

    Permission hierarchy: Owner > Maintainer > Developer > Reporter > RestrictedAnalyst
    A user with a higher role can perform actions of lower roles.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name
        required_role: Minimum required role

    Returns:
        True if user has permission, False otherwise
    """
    user_role = get_user_role_in_group(db, user_id, group_name)

    if user_role is None:
        return False

    # Use shared has_permission function from base_role
    return has_permission(user_role, required_role)


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

    Permission hierarchy: Owner > Maintainer > Developer > Reporter > RestrictedAnalyst
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


def is_restricted_analyst(db: Session, user_id: int, group_name: str) -> bool:
    """
    Check if user is a Restricted Analyst in the specified group.

    Restricted Analysts have limited access to knowledge base content.
    They can view conversations but cannot access document content,
    document structure, or summaries.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name (namespace)

    Returns:
        True if user is a Restricted Analyst in the group, False otherwise
    """
    user_role = get_effective_role_in_group(db, user_id, group_name)
    return user_role == GroupRole.RestrictedAnalyst


def check_knowledge_base_access_for_restricted_analyst(
    db: Session,
    user_id: int,
    knowledge_base_namespace: str,
) -> tuple[bool, str]:
    """
    Check if a user can access knowledge base content.

    For Restricted Analysts, they are prevented from accessing non-default (group)
    knowledge bases but are allowed to access the default (personal) namespace
    and shared personal KBs. This prevents them from extracting document content
    through conversation while maintaining access to their own personal KBs.

    Args:
        db: Database session
        user_id: User ID
        knowledge_base_namespace: Knowledge base namespace (group name or 'default')

    Returns:
        Tuple of (has_access, reason)
        - has_access: True if user can access KB content
        - reason: Explanation if access is denied
    """
    # Check if user is a Restricted Analyst in this group (for group KBs)
    if knowledge_base_namespace != "default":
        if is_restricted_analyst(db, user_id, knowledge_base_namespace):
            return (
                False,
                "Restricted Analysts cannot access knowledge base content. "
                "You can view conversations but cannot retrieve document content, "
                "structure, or summaries from group knowledge bases.",
            )

    return True, ""


def check_knowledge_base_access_for_restricted_analyst_by_ids(
    db: Session,
    user_id: int,
    knowledge_base_ids: list[int],
) -> tuple[bool, str]:
    """
    Check if a user can access knowledge base content by KB IDs.

    For Restricted Analysts, they are prevented from accessing non-default (group)
    knowledge bases but are allowed to access the default (personal) namespace
    and shared personal KBs. This prevents them from extracting document content
    through conversation while maintaining access to their own personal KBs.

    Args:
        db: Database session
        user_id: User ID
        knowledge_base_ids: List of knowledge base IDs to check

    Returns:
        Tuple of (has_access, reason)
        - has_access: True if user can access KB content
        - reason: Explanation if access is denied
    """
    from app.models.kind import Kind

    if not knowledge_base_ids:
        return True, ""

    # Get knowledge bases to check their namespaces
    kbs = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active,
        )
        .all()
    )

    for kb in kbs:
        # Personal knowledge bases (namespace='default') are always accessible
        if kb.namespace == "default":
            continue

        # Check if user is a Restricted Analyst in this group
        has_access, reason = check_knowledge_base_access_for_restricted_analyst(
            db, user_id, kb.namespace
        )
        if not has_access:
            return has_access, reason

    return True, ""
