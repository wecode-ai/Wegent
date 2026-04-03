# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.namespace import GroupRole
from app.services.knowledge.permission_policy import (
    can_create_namespace_knowledge_base,
    can_manage_accessible_knowledge_base,
    can_manage_accessible_knowledge_base_documents,
    can_manage_accessible_knowledge_document,
    can_manage_namespace,
    can_manage_namespace_knowledge_base,
)


def _create_user(test_db: Session, username: str, role: str = "user") -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-secret"),
        email=f"{username}@example.com",
        is_active=True,
        git_info=None,
        role=role,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_namespace(
    test_db: Session,
    owner: User,
    name: str,
    level: str = "group",
) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="internal",
        description="test namespace",
        level=level,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


def _add_member(
    test_db: Session,
    namespace: Namespace,
    user: User,
    role: GroupRole,
    invited_by_user_id: int,
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        user_id=user.id,
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=invited_by_user_id,
        share_link_id=0,
        reviewed_by_user_id=invited_by_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


@pytest.mark.unit
def test_developer_can_create_non_default_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "team-alpha")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    assert can_create_namespace_knowledge_base(
        db=test_db,
        user=developer,
        namespace_name=namespace.name,
    )


@pytest.mark.unit
def test_default_namespace_short_circuits_for_personal_kb_ownership(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "personal-owner")
    other_user = _create_user(test_db, "personal-other")

    assert can_create_namespace_knowledge_base(
        db=test_db,
        user=owner,
        namespace_name="default",
    )
    assert can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=owner.id,
        namespace_name="default",
        kb_owner_id=owner.id,
        user_role=owner.role,
    )
    assert not can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=other_user.id,
        namespace_name="default",
        kb_owner_id=owner.id,
        user_role=other_user.role,
    )


@pytest.mark.unit
def test_developer_can_only_manage_owned_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "team-beta")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    assert can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=developer.id,
        namespace_name=namespace.name,
        kb_owner_id=developer.id,
        user_role=developer.role,
    )
    assert not can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=developer.id,
        namespace_name=namespace.name,
        kb_owner_id=owner.id,
        user_role=developer.role,
    )


@pytest.mark.unit
def test_maintainer_can_manage_any_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    maintainer = _create_user(test_db, "maintainer")
    namespace = _create_namespace(test_db, owner, "team-gamma")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, maintainer, GroupRole.Maintainer, owner.id)

    assert can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=maintainer.id,
        namespace_name=namespace.name,
        kb_owner_id=owner.id,
        user_role=maintainer.role,
    )


@pytest.mark.unit
def test_admin_short_circuits_namespace_permission_checks(test_db: Session) -> None:
    owner = _create_user(test_db, "team-owner")
    admin = _create_user(test_db, "admin-user", role="admin")
    namespace = _create_namespace(test_db, owner, "team-admin-short-circuit")

    assert can_create_namespace_knowledge_base(
        db=test_db,
        user=admin,
        namespace_name=namespace.name,
    )
    assert can_manage_namespace_knowledge_base(
        db=test_db,
        user_id=admin.id,
        namespace_name=namespace.name,
        kb_owner_id=owner.id,
        user_role=admin.role,
    )
    assert can_manage_namespace(test_db, admin, namespace.name)


@pytest.mark.unit
def test_only_owner_can_manage_namespace_settings(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    maintainer = _create_user(test_db, "maintainer")
    namespace = _create_namespace(test_db, owner, "org-space", level="organization")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, maintainer, GroupRole.Maintainer, owner.id)

    assert can_manage_namespace(test_db, owner, namespace.name)
    assert not can_manage_namespace(test_db, maintainer, namespace.name)


@pytest.mark.unit
def test_explicit_kb_maintainer_can_manage_accessible_knowledge_base() -> None:
    assert can_manage_accessible_knowledge_base(
        has_access=True,
        role=BaseRole.Maintainer,
        is_creator=False,
    )


@pytest.mark.unit
def test_explicit_kb_developer_can_manage_documents_but_not_kb_settings() -> None:
    assert not can_manage_accessible_knowledge_base(
        has_access=True,
        role=BaseRole.Developer,
        is_creator=False,
    )
    assert can_manage_accessible_knowledge_base_documents(
        has_access=True,
        role=BaseRole.Developer,
        is_creator=False,
    )


@pytest.mark.unit
def test_explicit_kb_developer_can_manage_only_owned_document() -> None:
    assert can_manage_accessible_knowledge_document(
        has_access=True,
        role=BaseRole.Developer,
        is_creator=False,
        user_id=2,
        document_owner_id=2,
    )
    assert not can_manage_accessible_knowledge_document(
        has_access=True,
        role=BaseRole.Developer,
        is_creator=False,
        user_id=2,
        document_owner_id=1,
    )
