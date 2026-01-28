# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission service for knowledge base access control.

Provides functions to check and manage permissions for knowledge bases
including personal, group, and organization-level access control.
"""

from typing import Optional

from sqlalchemy import case
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.permission import Permission
from app.models.user import User
from app.schemas.namespace import GroupRole
from app.services.group_permission import get_effective_role_in_group


def can_access_knowledge_base(db: Session, user_id: int, kb: Kind) -> bool:
    """
    Check if user has access permission to a knowledge base.

    Permission logic:
    1. Organization KB (namespace="organization"): All users have access
    2. Group KB (namespace != "default" and != "organization"): Group members have access
    3. Personal KB (namespace="default"): Owner or explicit grant

    Args:
        db: Database session
        user_id: User ID to check
        kb: Knowledge base Kind object

    Returns:
        True if user has access permission
    """
    namespace = kb.namespace

    # 1. Organization KB - all users have access
    if namespace == "organization":
        return True

    # 2. Group KB - check group membership
    if namespace != "default":
        role = get_effective_role_in_group(db, user_id, namespace)
        return role is not None

    # 3. Personal KB - check owner or explicit permission
    if kb.user_id == user_id:
        return True

    permission = (
        db.query(Permission)
        .filter(
            Permission.kind_id == kb.id,
            Permission.resource_type == "knowledge_base",
            Permission.user_id == user_id,
            Permission.permission_type.in_(["read", "download", "write", "manage"]),
            Permission.is_active == True,
        )
        .first()
    )

    return permission is not None


def can_manage_knowledge_base(db: Session, user: User, kb: Kind) -> bool:
    """
    Check if user has management permission for a knowledge base.

    Management permission allows:
    - Managing other users' permissions
    - Deleting the knowledge base

    Permission logic:
    1. Organization KB: Only system admins
    2. Group KB: Owner or Maintainer role
    3. Personal KB: Owner or explicit "manage" permission

    Args:
        db: Database session
        user: User object
        kb: Knowledge base Kind object

    Returns:
        True if user has management permission
    """
    namespace = kb.namespace

    # 1. Organization KB - only system admin
    if namespace == "organization":
        return user.role == "admin"

    # 2. Group KB - Owner or Maintainer
    if namespace != "default":
        role = get_effective_role_in_group(db, user.id, namespace)
        return role in [GroupRole.Owner, GroupRole.Maintainer]

    # 3. Personal KB - owner or explicit manage permission
    if kb.user_id == user.id:
        return True

    permission = (
        db.query(Permission)
        .filter(
            Permission.kind_id == kb.id,
            Permission.resource_type == "knowledge_base",
            Permission.user_id == user.id,
            Permission.permission_type == "manage",
            Permission.is_active == True,
        )
        .first()
    )

    return permission is not None


def can_write_knowledge_base(db: Session, user: User, kb: Kind) -> bool:
    """
    Check if user has write permission for a knowledge base.

    Write permission allows:
    - Adding documents
    - Editing documents
    - Deleting documents

    Permission logic:
    1. Organization KB: Only system admins
    2. Group KB: Maintainer or higher role
    3. Personal KB: Owner or explicit "write" or "manage" permission

    Args:
        db: Database session
        user: User object
        kb: Knowledge base Kind object

    Returns:
        True if user has write permission
    """
    namespace = kb.namespace

    # 1. Organization KB - only system admin
    if namespace == "organization":
        return user.role == "admin"

    # 2. Group KB - Maintainer or higher
    if namespace != "default":
        role = get_effective_role_in_group(db, user.id, namespace)
        return role in [GroupRole.Owner, GroupRole.Maintainer]

    # 3. Personal KB - owner or write/manage permission
    if kb.user_id == user.id:
        return True

    permission = (
        db.query(Permission)
        .filter(
            Permission.kind_id == kb.id,
            Permission.resource_type == "knowledge_base",
            Permission.user_id == user.id,
            Permission.permission_type.in_(["write", "manage"]),
            Permission.is_active == True,
        )
        .first()
    )

    return permission is not None


def get_user_permission_type(db: Session, user: User, kb: Kind) -> Optional[str]:
    """
    Get user's permission type for a knowledge base.

    Returns the highest permission level the user has.

    Permission hierarchy (highest to lowest):
    - manage: Full control including permission management
    - write: Can modify documents
    - download: Can view and download
    - read: Can only view

    Args:
        db: Database session
        user: User object
        kb: Knowledge base Kind object

    Returns:
        Permission type string or None if no permission
    """
    namespace = kb.namespace

    # Organization KB
    if namespace == "organization":
        if user.role == "admin":
            return "manage"
        return "read"  # All users have read access

    # Group KB - map group role to permission type
    if namespace != "default":
        role = get_effective_role_in_group(db, user.id, namespace)
        if role in [GroupRole.Owner, GroupRole.Maintainer]:
            return "manage"
        elif role == GroupRole.Developer:
            return "write"
        elif role == GroupRole.Reporter:
            return "read"
        return None

    # Personal KB
    if kb.user_id == user.id:
        return "manage"

    # Check explicit permission - get highest permission
    permission = (
        db.query(Permission)
        .filter(
            Permission.kind_id == kb.id,
            Permission.resource_type == "knowledge_base",
            Permission.user_id == user.id,
            Permission.is_active == True,
        )
        .order_by(
            case(
                (Permission.permission_type == "manage", 1),
                (Permission.permission_type == "write", 2),
                (Permission.permission_type == "download", 3),
                (Permission.permission_type == "read", 4),
            )
        )
        .first()
    )

    return permission.permission_type if permission else None


def get_permission_source(db: Session, user: User, kb: Kind) -> str:
    """
    Get the source of user's permission for a knowledge base.

    Possible sources:
    - owner: User is the knowledge base creator
    - group_role: User has access through group membership
    - explicit_grant: User has explicit permission granted
    - organization_member: User has access as organization member
    - system_admin: User is system admin
    - none: User has no permission

    Args:
        db: Database session
        user: User object
        kb: Knowledge base Kind object

    Returns:
        Permission source string
    """
    namespace = kb.namespace

    # Organization KB
    if namespace == "organization":
        if user.role == "admin":
            return "system_admin"
        return "organization_member"

    # Group KB
    if namespace != "default":
        role = get_effective_role_in_group(db, user.id, namespace)
        if role is not None:
            return "group_role"

    # Personal KB - check if owner
    if kb.user_id == user.id:
        return "owner"

    # Check explicit permission
    permission = (
        db.query(Permission)
        .filter(
            Permission.kind_id == kb.id,
            Permission.resource_type == "knowledge_base",
            Permission.user_id == user.id,
            Permission.is_active == True,
        )
        .first()
    )

    if permission:
        return "explicit_grant"

    return "none"


def get_or_create_organization_knowledge_base(
    db: Session, user: User
) -> Optional[Kind]:
    """
    Get or create the organization knowledge base.

    Only system admins can trigger creation of the organization KB.
    All users can access the existing organization KB.

    Args:
        db: Database session
        user: User object (must be admin to create)

    Returns:
        Organization knowledge base Kind object, or None if KB doesn't exist
        and user is not admin

    Note:
        The organization KB is typically created during system initialization.
        If it doesn't exist and user is not admin, returns None instead of
        raising an error to provide a better user experience.
    """
    from datetime import datetime

    # Look for existing organization KB
    existing = (
        db.query(Kind)
        .filter(
            Kind.kind == "KnowledgeBase",
            Kind.namespace == "organization",
            Kind.is_active == True,
        )
        .first()
    )

    if existing:
        return existing

    # Only system admin can create
    if user.role != "admin":
        # Return None instead of raising error for better UX
        # The organization KB should be created during system initialization
        return None

    # Create organization KB
    org_kb = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name="organization-knowledge-base",
        namespace="organization",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": "organization-knowledge-base",
                "namespace": "organization",
            },
            "spec": {
                "name": "公司知识库",
                "description": "公司级别的共享知识库，所有员工可访问",
                "kbType": "classic",
                "summaryEnabled": False,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    db.add(org_kb)
    db.commit()
    db.refresh(org_kb)

    return org_kb
