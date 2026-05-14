# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for check_entity_permission with bool resolver semantics."""

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.share.base_service import UnifiedShareService
from app.services.share.external_entity_resolver import register_entity_resolver
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver


class DummyShareService(UnifiedShareService):
    """Minimal subclass for testing base permission logic."""

    def _get_resource(self, db, resource_id, user_id):
        return db.query(Kind).filter(Kind.id == resource_id).first()

    def _get_resource_name(self, resource):
        return resource.json.get("spec", {}).get("name", "")

    def _get_resource_owner_id(self, resource):
        return resource.user_id

    def _get_share_url_base(self):
        return "http://test"

    def _on_member_approved(self, db, member, resource):
        return None


def _create_user(test_db: Session, username: str) -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-pass"),
        email=f"{username}@example.com",
        is_active=True,
        role="user",
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_namespace(test_db: Session, owner: User, name: str) -> Namespace:
    ns = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="internal",
        description="test",
        level="group",
        is_active=True,
    )
    test_db.add(ns)
    test_db.commit()
    test_db.refresh(ns)
    return ns


def _add_ns_member(
    test_db: Session, namespace: Namespace, user: User, role: str
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=namespace.owner_user_id,
        share_link_id=0,
        reviewed_by_user_id=namespace.owner_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def _create_kb(test_db: Session, owner: User, name: str, ns: str = "default") -> Kind:
    kb = Kind(
        name=name,
        namespace=ns,
        kind="KnowledgeBase",
        user_id=owner.id,
        is_active=True,
        json={"spec": {"name": name}},
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)
    return kb


def _add_kb_entity_member(
    test_db: Session, kb_id: int, entity_id: str, role: str
) -> ResourceMember:
    member = ResourceMember(
        resource_type=ResourceType.KNOWLEDGE_BASE.value,
        resource_id=kb_id,
        entity_type="namespace",
        entity_id=entity_id,
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=0,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


class TestCheckEntityPermission:
    def test_entity_binding_with_sufficient_role(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        user = _create_user(test_db, "user")
        ns = _create_namespace(test_db, owner, "ns1")
        _add_ns_member(test_db, ns, user, ResourceRole.Maintainer.value)
        kb = _create_kb(test_db, owner, "kb1")
        _add_kb_entity_member(test_db, kb.id, str(ns.id), ResourceRole.Maintainer.value)

        service = DummyShareService(ResourceType.KNOWLEDGE_BASE)
        result = service.check_entity_permission(
            test_db, kb.id, user.id, BaseRole.Maintainer
        )
        assert result is True

    def test_entity_binding_with_insufficient_role(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        user = _create_user(test_db, "user")
        ns = _create_namespace(test_db, owner, "ns1")
        _add_ns_member(test_db, ns, user, ResourceRole.Reporter.value)
        kb = _create_kb(test_db, owner, "kb1")
        _add_kb_entity_member(test_db, kb.id, str(ns.id), ResourceRole.Reporter.value)

        service = DummyShareService(ResourceType.KNOWLEDGE_BASE)
        result = service.check_entity_permission(
            test_db, kb.id, user.id, BaseRole.Maintainer
        )
        assert result is False

    def test_no_matching_entity_binding(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        user = _create_user(test_db, "user")
        ns = _create_namespace(test_db, owner, "ns1")
        # user is NOT a member of ns
        kb = _create_kb(test_db, owner, "kb1")
        _add_kb_entity_member(test_db, kb.id, str(ns.id), ResourceRole.Maintainer.value)

        service = DummyShareService(ResourceType.KNOWLEDGE_BASE)
        result = service.check_entity_permission(
            test_db, kb.id, user.id, BaseRole.Reporter
        )
        assert result is False

    def test_multiple_bindings_only_one_matches(self, test_db: Session):
        """User matches ns1 (Reporter) but not ns2 (Owner). Should get Reporter."""
        owner = _create_user(test_db, "owner")
        user = _create_user(test_db, "user")
        ns1 = _create_namespace(test_db, owner, "ns1")
        ns2 = _create_namespace(test_db, owner, "ns2")
        _add_ns_member(test_db, ns1, user, ResourceRole.Reporter.value)
        # user is NOT a member of ns2
        kb = _create_kb(test_db, owner, "kb1")
        _add_kb_entity_member(test_db, kb.id, str(ns1.id), ResourceRole.Reporter.value)
        _add_kb_entity_member(test_db, kb.id, str(ns2.id), ResourceRole.Owner.value)

        service = DummyShareService(ResourceType.KNOWLEDGE_BASE)
        # Reporter should NOT satisfy Maintainer requirement
        assert (
            service.check_entity_permission(
                test_db, kb.id, user.id, BaseRole.Maintainer
            )
            is False
        )
        # Reporter SHOULD satisfy Reporter requirement
        assert (
            service.check_entity_permission(test_db, kb.id, user.id, BaseRole.Reporter)
            is True
        )
