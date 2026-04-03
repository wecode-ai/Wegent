# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Centralized namespace and knowledge-base permission policies."""

from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.namespace import GroupRole
from app.services.group_permission import get_effective_role_in_group
from shared.telemetry.decorators import trace_sync

RoleResolver = Callable[[Session, int, str], Optional[GroupRole]]


def _resolve_role(
    db: Session,
    user_id: int,
    namespace_name: str,
    role_resolver: RoleResolver | None = None,
) -> Optional[GroupRole]:
    resolver = role_resolver or get_effective_role_in_group
    return resolver(db, user_id, namespace_name)


@trace_sync(
    span_name="can_create_namespace_knowledge_base",
    tracer_name="knowledge.permission_policy",
    extract_attributes=lambda db, user, namespace_name, role_resolver=None: {
        "user.id": user.id,
        "user.role": user.role,
        "namespace.name": namespace_name,
    },
)
def can_create_namespace_knowledge_base(
    db: Session,
    user: User,
    namespace_name: str,
    role_resolver: RoleResolver | None = None,
) -> bool:
    """Return whether the user can create a KB in the target namespace."""
    if namespace_name == "default":
        return True

    if user.role == "admin":
        return True

    role = _resolve_role(db, user.id, namespace_name, role_resolver)
    return role is not None and has_permission(role, GroupRole.Developer)


@trace_sync(
    span_name="can_manage_namespace_knowledge_base",
    tracer_name="knowledge.permission_policy",
    extract_attributes=lambda db, user_id, namespace_name, kb_owner_id, user_role=None, role_resolver=None: {
        "user.id": user_id,
        "user.role": user_role or "",
        "namespace.name": namespace_name,
        "knowledge_base.owner_user_id": kb_owner_id,
    },
)
def can_manage_namespace_knowledge_base(
    db: Session,
    user_id: int,
    namespace_name: str,
    kb_owner_id: int,
    user_role: str | None = None,
    role_resolver: RoleResolver | None = None,
) -> bool:
    """Return whether the user can manage the target KB."""
    if namespace_name == "default":
        return kb_owner_id == user_id

    if user_role == "admin":
        return True

    role = _resolve_role(db, user_id, namespace_name, role_resolver)
    if role is None:
        return False

    if has_permission(role, GroupRole.Maintainer):
        return True

    return role == GroupRole.Developer and kb_owner_id == user_id


@trace_sync(
    span_name="can_manage_namespace",
    tracer_name="knowledge.permission_policy",
    extract_attributes=lambda db, user, namespace_name, role_resolver=None: {
        "user.id": user.id,
        "user.role": user.role,
        "namespace.name": namespace_name,
    },
)
def can_manage_namespace(
    db: Session,
    user: User,
    namespace_name: str,
    role_resolver: RoleResolver | None = None,
) -> bool:
    """Return whether the user can manage namespace settings/members."""
    if user.role == "admin":
        return True

    role = _resolve_role(db, user.id, namespace_name, role_resolver)
    return role == GroupRole.Owner


def can_manage_accessible_knowledge_base(
    has_access: bool,
    role: BaseRole | None,
    is_creator: bool,
) -> bool:
    """Return whether merged KB access allows KB-level management."""
    if not has_access:
        return False

    if is_creator:
        return True

    return role is not None and has_permission(role, BaseRole.Maintainer)


def can_manage_accessible_knowledge_base_documents(
    has_access: bool,
    role: BaseRole | None,
    is_creator: bool,
) -> bool:
    """Return whether merged KB access allows document uploads."""
    if not has_access:
        return False

    if is_creator:
        return True

    return role is not None and has_permission(role, BaseRole.Developer)


def can_manage_accessible_knowledge_document(
    has_access: bool,
    role: BaseRole | None,
    is_creator: bool,
    user_id: int,
    document_owner_id: int,
) -> bool:
    """Return whether merged KB access allows document management."""
    if not has_access:
        return False

    if is_creator:
        return True

    if role is None:
        return False

    if has_permission(role, BaseRole.Maintainer):
        return True

    return role == BaseRole.Developer and document_owner_id == user_id
