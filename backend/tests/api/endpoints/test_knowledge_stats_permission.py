# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Permission tests for the single-KB stat endpoints.

Covers P1-2: ``_ensure_can_view_kb_stat`` must honor every KB access source
(creator, direct ResourceMember, namespace/group, entity bindings) by
delegating to the unified ACL resolver ``get_user_knowledge_base_permission``
— not just querying ``entity_type == "user"`` direct members.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints.knowledge_stats import _ensure_can_view_kb_stat
from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService


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
    test_db: Session, owner: User, name: str, level: str = "group"
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


def _add_namespace_member(
    test_db: Session, namespace: Namespace, user: User, role: GroupRole, inviter: User
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=inviter.id,
        share_link_id=0,
        reviewed_by_user_id=inviter.id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def _add_kb_member(
    test_db: Session,
    knowledge_base_id: int,
    user: User,
    role: ResourceRole,
    inviter: User,
) -> ResourceMember:
    member = ResourceMember(
        resource_type="KnowledgeBase",
        resource_id=knowledge_base_id,
        entity_type="user",
        entity_id=str(user.id),
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=inviter.id,
        share_link_id=0,
        reviewed_by_user_id=inviter.id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def _get_kind(test_db: Session, knowledge_base_id: int) -> Kind:
    kb = (
        test_db.query(Kind)
        .filter(Kind.id == knowledge_base_id, Kind.kind == "KnowledgeBase")
        .first()
    )
    assert kb is not None
    return kb


@pytest.mark.unit
def test_admin_bypasses_acl(test_db: Session) -> None:
    owner = _create_user(test_db, "stat-owner-admin")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="kb-admin", namespace="default")
    )
    kb = _get_kind(test_db, kb_id)
    admin = _create_user(test_db, "stat-admin", role="admin")

    # Admin must not be blocked even though they have no KB membership.
    _ensure_can_view_kb_stat(test_db, kb, admin)


@pytest.mark.unit
def test_creator_can_view_stat(test_db: Session) -> None:
    owner = _create_user(test_db, "stat-creator")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="kb-creator", namespace="default")
    )
    kb = _get_kind(test_db, kb_id)

    _ensure_can_view_kb_stat(test_db, kb, owner)


@pytest.mark.unit
def test_direct_kb_member_can_view_stat(test_db: Session) -> None:
    owner = _create_user(test_db, "stat-direct-owner")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="kb-direct", namespace="default")
    )
    kb = _get_kind(test_db, kb_id)
    member = _create_user(test_db, "stat-direct-member")
    _add_kb_member(test_db, kb_id, member, ResourceRole.Reporter, owner)

    # A direct ResourceMember (Reporter) could view the KB, so can view stats.
    _ensure_can_view_kb_stat(test_db, kb, member)


@pytest.mark.unit
def test_namespace_member_can_view_stat(test_db: Session) -> None:
    owner = _create_user(test_db, "stat-ns-owner")
    namespace = _create_namespace(test_db, owner, "stat-ns")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner)
    ns_member = _create_user(test_db, "stat-ns-member")
    _add_namespace_member(test_db, namespace, ns_member, GroupRole.Reporter, owner)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="kb-ns", namespace=namespace.name),
    )
    kb = _get_kind(test_db, kb_id)

    # The user has no direct KB ResourceMember row — access comes from the
    # namespace/group ACL. The old check (entity_type == "user" only) would
    # 403 them; the unified resolver must grant access.
    _ensure_can_view_kb_stat(test_db, kb, ns_member)


@pytest.mark.unit
def test_no_access_user_denied_403(test_db: Session) -> None:
    owner = _create_user(test_db, "stat-deny-owner")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="kb-deny", namespace="default")
    )
    kb = _get_kind(test_db, kb_id)
    stranger = _create_user(test_db, "stat-stranger")

    with pytest.raises(HTTPException) as exc:
        _ensure_can_view_kb_stat(test_db, kb, stranger)
    assert exc.value.status_code == 403


@pytest.mark.unit
def test_delegates_to_unified_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    """Entity bindings (group/department/external) and every other non-direct
    source are resolved by ``get_user_knowledge_base_permission``, not by
    ``_ensure_can_view_kb_stat`` itself. Verify the delegation contract: when
    the unified resolver reports ``has_access`` (entity member or any other
    source), stats are granted — and the resolver is actually called with the
    loaded KB so it covers all ACL sources."""
    from app.api.endpoints import knowledge_stats

    captured: dict = {}

    def fake_resolver(db, kb_id, user_id, *, kb=None):
        captured["called"] = True
        captured["kb_id"] = kb_id
        captured["user_id"] = user_id
        captured["kb"] = kb
        return SimpleNamespace(has_access=True)

    monkeypatch.setattr(
        knowledge_stats, "get_user_knowledge_base_permission", fake_resolver
    )

    kb = SimpleNamespace(id=42, user_id=1)
    user = SimpleNamespace(id=7, role="user")
    # has_access=True (e.g. an entity member resolved by the unified ACL) → grant.
    knowledge_stats._ensure_can_view_kb_stat(MagicMock(), kb, user)

    assert captured.get("called") is True
    assert captured["kb_id"] == 42
    assert captured["user_id"] == 7
    assert captured["kb"] is kb  # reuse the already-loaded KB, no extra is_active query
