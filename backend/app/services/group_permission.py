# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.base_role import has_permission
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.group_member_helper import (
    NAMESPACE_RESOURCE_TYPE,
    get_namespace_id_by_name,
    iter_user_groups_with_roles,
)

RoleResolver = Callable[[Session, int, str], Optional[GroupRole]]


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


def _resolve_entity_roles_in_namespace(
    db: Session, user_id: int, namespace_id: int
) -> list[str]:
    """Resolve entity-derived roles for a user in a namespace.

    Pulls all approved entity-type members (excluding 'user' and 'namespace')
    for the namespace, groups by entity_type, calls resolver.match_entity_bindings,
    and returns matched roles.

    Args:
        db: Database session
        user_id: User ID
        namespace_id: Namespace ID

    Returns:
        List of role strings from matched entity bindings
    """
    from app.services.external_entity_resolver import (
        resolve_entity_roles_for_resource,
    )

    return resolve_entity_roles_for_resource(
        db,
        resource_type=NAMESPACE_RESOURCE_TYPE,
        resource_id=namespace_id,
        user_id=user_id,
        exclude_entity_types=["user", "namespace"],
    )


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
    user_role = get_effective_role_in_group(db, user_id, group_name)

    if user_role is None:
        return False

    # Use shared has_permission function from base_role
    return has_permission(user_role, required_role)


def get_user_groups(db: Session, user_id: int) -> list[str]:
    """
    Get all group names that user has access to, including inherited permissions
    from parent groups and entity-derived memberships.

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

    # Get user's direct + entity memberships with roles
    all_memberships = iter_user_groups_with_roles(db, user_id)

    # Create a mapping of group_name -> role
    direct_group_names = {name for name, _, _, _ in all_memberships}
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
    Get user's effective role in a group, considering direct membership,
    entity-derived memberships, and inheritance from parent groups.

    Resolution rules:
    - Collect roles from direct user membership, entity bindings, and parent groups
    - Return the highest privilege role among all sources

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name

    Returns:
        GroupRole if user has access (direct, entity, or inherited), None otherwise
    """
    from app.schemas.base_role import get_highest_role

    candidates = []

    # 1) Direct user membership
    direct_role_str = get_user_role_in_group(db, user_id, group_name)
    if direct_role_str is not None:
        candidates.append(direct_role_str.value)

    # 2) Entity-derived memberships
    namespace_id = get_namespace_id_by_name(db, group_name)
    if namespace_id is not None:
        entity_roles = _resolve_entity_roles_in_namespace(db, user_id, namespace_id)
        candidates.extend(entity_roles)

    # 3) Parent group inheritance (only if no direct/entity hit)
    if not candidates and "/" in group_name:
        parts = group_name.split("/")
        # Check from nearest parent upward
        for i in range(len(parts) - 1, 0, -1):
            parent_name = "/".join(parts[:i])
            parent_role = get_effective_role_in_group(db, user_id, parent_name)
            if parent_role is not None:
                candidates.append(parent_role.value)
                break

    if not candidates:
        return None

    highest_role_str = get_highest_role(candidates)
    try:
        return GroupRole(highest_role_str)
    except ValueError:
        return None


def get_view_role_in_group(
    db: Session,
    user_id: int,
    group_name: str,
    user_role: str | None = None,
    group_level: str | None = None,
    role_resolver: RoleResolver | None = None,
) -> Optional[GroupRole]:
    """Return the role that should be used for group read/view access."""
    resolver = role_resolver or get_effective_role_in_group
    role = resolver(db, user_id, group_name)
    if role is not None:
        return role

    if user_role == "admin" and group_level == GroupLevel.organization.value:
        return GroupRole.Owner

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
    return group_name in get_restricted_analyst_groups(db, user_id, [group_name])


def get_effective_roles_in_groups(
    db: Session, user_id: int, group_names: list[str]
) -> dict[str, GroupRole]:
    """Get effective roles for multiple groups with a single membership fetch.

    Covers direct user memberships, entity-derived memberships, and parent
    group inheritance. Uses iter_user_groups_with_roles for the user-side
    batch resolution to avoid N x namespace resolver calls.
    """
    if not group_names:
        return {}

    from app.schemas.base_role import get_highest_role

    # Batch fetch all user memberships (direct + entity)
    all_memberships = iter_user_groups_with_roles(db, user_id)

    # group_name -> list of role strings
    role_map: dict[str, list[str]] = {}
    for group_name, role, _src_type, _src_id in all_memberships:
        role_map.setdefault(group_name, []).append(role)

    effective_roles: dict[str, GroupRole] = {}
    for group_name in dict.fromkeys(group_names):
        roles = role_map.get(group_name, [])

        # Parent group inheritance
        if not roles and "/" in group_name:
            parts = group_name.split("/")
            for i in range(len(parts) - 1, 0, -1):
                parent_name = "/".join(parts[:i])
                parent_roles = role_map.get(parent_name)
                if parent_roles:
                    roles = parent_roles
                    break

        if roles:
            highest = get_highest_role(roles)
            try:
                effective_roles[group_name] = GroupRole(highest)
            except ValueError:
                continue

    return effective_roles


def get_restricted_analyst_groups(
    db: Session, user_id: int, group_names: list[str]
) -> set[str]:
    """Return group names where the user's effective role is RestrictedAnalyst."""
    effective_roles = get_effective_roles_in_groups(db, user_id, group_names)
    return {
        group_name
        for group_name, role in effective_roles.items()
        if role == GroupRole.RestrictedAnalyst
    }


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
