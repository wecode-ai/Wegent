# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for NamespaceEntityResolver."""

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.namespace import GroupRole
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver

resolver = NamespaceEntityResolver()


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
    test_db: Session,
    namespace: Namespace,
    user: User,
    role: str,
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


def _add_kb_entity_member(
    test_db: Session,
    kb_id: int,
    entity_id: str,
    role: str = ResourceRole.Reporter.value,
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


class TestMatchEntityBindings:
    def test_match_single_namespace_returns_matched_id(self, test_db: Session):
        owner = _create_user(test_db, "owner1")
        user = _create_user(test_db, "user1")
        ns = _create_namespace(test_db, owner, "ns1")
        _add_ns_member(test_db, ns, user, ResourceRole.Maintainer.value)

        result = resolver.match_entity_bindings(
            test_db, user.id, "namespace", [str(ns.id)]
        )
        assert result == [str(ns.id)]

    def test_match_multiple_namespaces_returns_matched_ids(self, test_db: Session):
        owner = _create_user(test_db, "owner2")
        user = _create_user(test_db, "user2")
        ns1 = _create_namespace(test_db, owner, "ns1")
        ns2 = _create_namespace(test_db, owner, "ns2")
        _add_ns_member(test_db, ns1, user, ResourceRole.Reporter.value)
        _add_ns_member(test_db, ns2, user, ResourceRole.Maintainer.value)

        result = resolver.match_entity_bindings(
            test_db, user.id, "namespace", [str(ns1.id), str(ns2.id)]
        )
        assert set(result) == {str(ns1.id), str(ns2.id)}

    def test_no_match_returns_empty_list(self, test_db: Session):
        owner = _create_user(test_db, "owner3")
        user = _create_user(test_db, "user3")
        ns = _create_namespace(test_db, owner, "ns3")
        # user is NOT a member of ns

        result = resolver.match_entity_bindings(
            test_db, user.id, "namespace", [str(ns.id)]
        )
        assert result == []

    def test_non_namespace_entity_returns_empty_list(self, test_db: Session):
        result = resolver.match_entity_bindings(test_db, 1, "org_department", ["dept1"])
        assert result == []

    def test_empty_entity_ids_returns_empty_list(self, test_db: Session):
        result = resolver.match_entity_bindings(test_db, 1, "namespace", [])
        assert result == []


class TestGetResourceIdsByEntity:
    def test_returns_kb_ids_for_member_namespaces(self, test_db: Session):
        owner = _create_user(test_db, "owner4")
        user = _create_user(test_db, "user4")
        ns = _create_namespace(test_db, owner, "ns4")
        _add_ns_member(test_db, ns, user, ResourceRole.Reporter.value)

        kb = Kind(
            name="kb1",
            namespace="default",
            kind="KnowledgeBase",
            user_id=owner.id,
            is_active=True,
            json={},
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        _add_kb_entity_member(test_db, kb.id, str(ns.id))

        result = resolver.get_resource_ids_by_entity(test_db, user.id, "namespace")
        assert result == [kb.id]

    def test_returns_empty_for_non_member(self, test_db: Session):
        owner = _create_user(test_db, "owner5")
        user = _create_user(test_db, "user5")
        ns = _create_namespace(test_db, owner, "ns5")
        # user is NOT a member

        kb = Kind(
            name="kb2",
            namespace="default",
            kind="KnowledgeBase",
            user_id=owner.id,
            is_active=True,
            json={},
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        _add_kb_entity_member(test_db, kb.id, str(ns.id))

        result = resolver.get_resource_ids_by_entity(test_db, user.id, "namespace")
        assert result == []

    def test_non_namespace_entity_returns_empty(self, test_db: Session):
        result = resolver.get_resource_ids_by_entity(test_db, 1, "org_department")
        assert result == []
