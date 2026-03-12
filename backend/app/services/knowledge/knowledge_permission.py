# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base permission checking utilities.

This module contains permission checking functions for knowledge bases
to avoid circular imports between knowledge_service and knowledge_share_service.
"""

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.group_permission import check_group_permission


def is_organization_namespace(db: Session, namespace_name: str) -> bool:
    """
    Check if a namespace is an organization-level namespace.

    Args:
        db: Database session
        namespace_name: Namespace name

    Returns:
        True if the namespace has level='organization', False otherwise
    """
    # Special case: 'default' namespace is never organization-level
    if namespace_name == "default":
        return False

    namespace = (
        db.query(Namespace)
        .filter(
            Namespace.name == namespace_name,
            Namespace.is_active == True,
        )
        .first()
    )

    return namespace is not None and namespace.level == GroupLevel.organization.value


def check_organization_kb_permission(
    db: Session,
    namespace_name: str,
    user_id: int,
    action: str = "access",
) -> None:
    """
    Check if user has permission to perform action on organization-level knowledge base.

    Args:
        db: Database session
        namespace_name: Namespace name
        user_id: User ID
        action: Action description for error message

    Raises:
        ValueError: If user is not admin
    """
    if not is_organization_namespace(db, namespace_name):
        return

    from app.models.user import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user or user.role != "admin":
        raise ValueError(f"Only admin can {action} organization knowledge base")


def check_team_kb_permission(
    db: Session,
    namespace_name: str,
    user_id: int,
    required_role: GroupRole = GroupRole.Maintainer,
    action: str = "modify",
) -> None:
    """
    Check if user has permission to perform action on team knowledge base.

    Args:
        db: Database session
        namespace_name: Namespace name
        user_id: User ID
        required_role: Minimum required role
        action: Action description for error message

    Raises:
        ValueError: If user does not have required permission
    """
    if namespace_name == "default":
        return

    if not check_group_permission(db, user_id, namespace_name, required_role):
        raise ValueError(
            f"Only Owner or Maintainer can {action} knowledge base in this group"
        )


def check_kb_write_permission(
    db: Session,
    namespace_name: str,
    user_id: int,
    kb_creator_id: int,
    action: str = "modify",
) -> None:
    """
    Check if user has write permission for a knowledge base.

    This checks:
    1. Organization KB: admin only
    2. Team KB: Maintainer or above
    3. Personal KB: creator only

    Args:
        db: Database session
        namespace_name: Namespace name
        user_id: User ID
        kb_creator_id: Creator user ID of the knowledge base
        action: Action description for error message

    Raises:
        ValueError: If user does not have write permission
    """
    # Check organization-level permission
    check_organization_kb_permission(db, namespace_name, user_id, action)

    # Check team-level permission
    if namespace_name != "default":
        if not is_organization_namespace(db, namespace_name):
            if not check_group_permission(
                db, user_id, namespace_name, GroupRole.Maintainer
            ):
                raise ValueError(
                    f"Only Owner or Maintainer can {action} knowledge base in this group"
                )
    else:
        # Personal KB: only creator can modify
        if kb_creator_id != user_id:
            raise ValueError(f"Only the creator can {action} this knowledge base")
