# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for external entity resolver integration in knowledge permissions.

Covers:
- External entity resolver registration and resolution paths
- get_resource_ids_by_entity batch resolver behavior
- Entity display name snapshot persistence for external types
- ResourceMember factory method and event listener edge cases
- Role merging across user and external entity bindings
"""

from typing import Optional
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, ResourceScope
from app.schemas.share import MemberRole
from app.services.group_permission import get_user_groups_with_roles
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.share import knowledge_share_service
from app.services.share.external_entity_resolver import (
    IExternalEntityResolver,
    _external_entity_resolvers,
    get_entity_resolver,
    register_entity_resolver,
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


def _add_namespace_member(
    test_db: Session,
    namespace: Namespace,
    user: User,
    role: str,
    invited_by_user_id: int,
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role,
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


class MockDepartmentResolver(IExternalEntityResolver):
    """Mock resolver for testing external entity permission paths."""

    def __init__(self, user_dept_map: Optional[dict[int, set[str]]] = None):
        self.user_dept_map = user_dept_map or {}

    @property
    def requires_display_name_snapshot(self) -> bool:
        return True

    def get_display_name(self, db: Session, entity_id: str) -> Optional[str]:
        return f"Dept-{entity_id}"

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        if entity_type != "mock_department":
            return []
        user_depts = self.user_dept_map.get(user_id, set())
        return list(user_depts & set(entity_ids))

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != "mock_department":
            return []
        user_depts = self.user_dept_map.get(user_id, set())
        if not user_depts:
            return []
        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.entity_type == "mock_department",
                ResourceMember.entity_id.in_(list(user_depts)),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return list(set(r.resource_id for r in results))


@pytest.fixture(autouse=True)
def cleanup_resolvers():
    """Clean up mock resolver registrations after each test."""
    original = dict(_external_entity_resolvers)
    yield
    _external_entity_resolvers.clear()
    _external_entity_resolvers.update(original)


@pytest.mark.unit
def test_external_entity_resolver_registration() -> None:
    """Resolver registry should store and retrieve implementations."""
    register_entity_resolver("mock_department", MockDepartmentResolver)

    resolver = get_entity_resolver("mock_department")
    assert resolver is not None
    assert isinstance(resolver, MockDepartmentResolver)

    unknown = get_entity_resolver("nonexistent")
    assert unknown is None


@pytest.mark.unit
def test_external_entity_permission_check_via_share_service(test_db: Session) -> None:
    """check_permission should invoke external resolver for entity-type members."""
    owner = _create_user(test_db, "ext-owner")
    member = _create_user(test_db, "ext-member")
    namespace = _create_namespace(test_db, owner, "ext-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="ext-kb", namespace="default"),
    )

    # Register resolver: member belongs to dept_1
    register_entity_resolver(
        "mock_department", lambda: MockDepartmentResolver({member.id: {"dept_1"}})
    )

    # Add mock_department entity binding
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
        entity_display_name="OldSnapshot",
    )

    # Member should have access via resolver
    has_access = knowledge_share_service.check_permission(
        test_db, kb_id, member.id, MemberRole.Reporter
    )
    assert has_access is True


@pytest.mark.unit
def test_external_entity_permission_denied_when_not_in_dept(
    test_db: Session,
) -> None:
    """Resolver should deny access when user is not in the department."""
    owner = _create_user(test_db, "ext-deny-owner")
    member = _create_user(test_db, "ext-deny-member")
    namespace = _create_namespace(test_db, owner, "ext-deny-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="ext-deny-kb", namespace="default"),
    )

    # Member is NOT in dept_1
    register_entity_resolver(
        "mock_department", lambda: MockDepartmentResolver({member.id: {"dept_2"}})
    )

    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )

    has_access = knowledge_share_service.check_permission(
        test_db, kb_id, member.id, MemberRole.Reporter
    )
    assert has_access is False


@pytest.mark.unit
def test_get_resource_ids_by_entity_batch_resolver_behavior(
    test_db: Session,
) -> None:
    """get_resource_ids_by_entity should resolve KBs across multiple resolver calls."""
    owner = _create_user(test_db, "batch-owner")
    member = _create_user(test_db, "batch-member")
    namespace = _create_namespace(test_db, owner, "batch-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_a = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="batch-kb-a", namespace="default"),
    )
    kb_b = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="batch-kb-b", namespace="default"),
    )

    # Member belongs to dept_1 and dept_2
    register_entity_resolver(
        "mock_department",
        lambda: MockDepartmentResolver({member.id: {"dept_1", "dept_2"}}),
    )

    # Bind KBs to different departments
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_a,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_b,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_2",
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, member.id)
    accessible_ids = {kb.id for kb in grouped.personal.shared_with_me}
    assert kb_a in accessible_ids
    assert kb_b in accessible_ids


@pytest.mark.unit
def test_entity_display_name_snapshot_persisted_for_external_type(
    test_db: Session,
) -> None:
    """External entity types should have display_name snapshot persisted."""
    owner = _create_user(test_db, "snapshot-owner")
    namespace = _create_namespace(test_db, owner, "snapshot-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="snapshot-kb", namespace="default"),
    )

    register_entity_resolver("mock_department", MockDepartmentResolver)

    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_99",
        entity_display_name="CustomDeptName",
    )

    member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "KnowledgeBase",
            ResourceMember.resource_id == kb_id,
            ResourceMember.entity_type == "mock_department",
        )
        .first()
    )
    assert member is not None
    assert member.entity_display_name == "CustomDeptName"

    # get_members should use the snapshot for external types
    members = knowledge_share_service.get_members(test_db, kb_id, owner.id)
    dept_member = next(
        (m for m in members.members if m.entity_type == "mock_department"), None
    )
    assert dept_member is not None
    assert dept_member.display_name == "CustomDeptName"


@pytest.mark.unit
def test_role_merge_user_and_external_entity(test_db: Session) -> None:
    """get_user_kb_permission should return the highest role across user and entity."""
    owner = _create_user(test_db, "merge-ext-owner")
    member = _create_user(test_db, "merge-ext-member")
    namespace = _create_namespace(test_db, owner, "merge-ext-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="merge-ext-kb", namespace="default"),
    )

    # Direct user share: Maintainer
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=member.id,
        role=MemberRole.Maintainer,
    )

    # External entity share: Reporter
    register_entity_resolver(
        "mock_department", lambda: MockDepartmentResolver({member.id: {"dept_1"}})
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )

    has_access, role, is_creator = knowledge_share_service.get_user_kb_permission(
        test_db, kb_id, member.id
    )
    assert has_access is True
    assert role == ResourceRole.Maintainer.value
    assert is_creator is False


@pytest.mark.unit
def test_resource_member_factory_method_sets_user_id() -> None:
    """ResourceMember.create should sync user_id for user-type members."""
    member = ResourceMember.create(
        resource_type="KnowledgeBase",
        resource_id=1,
        entity_type="user",
        entity_id="42",
        role=ResourceRole.Developer.value,
        status=MemberStatus.APPROVED.value,
    )
    assert member.entity_type == "user"
    assert member.entity_id == "42"
    assert member.user_id == 42


@pytest.mark.unit
def test_resource_member_factory_method_clears_user_id_for_entity() -> None:
    """ResourceMember.create should set user_id=0 for non-user entity types."""
    member = ResourceMember.create(
        resource_type="KnowledgeBase",
        resource_id=1,
        entity_type="namespace",
        entity_id="99",
        role=ResourceRole.Reporter.value,
    )
    assert member.entity_type == "namespace"
    assert member.entity_id == "99"
    assert member.user_id == 0


@pytest.mark.unit
def test_resource_member_factory_requires_entity_id_for_user() -> None:
    """ResourceMember.create should reject user-type members without entity_id."""
    with pytest.raises(ValueError, match="entity_id is required"):
        ResourceMember.create(
            resource_type="KnowledgeBase",
            resource_id=1,
            entity_type="user",
            entity_id=None,
        )


@pytest.mark.unit
def test_event_listener_syncs_user_id_on_bulk_insert_bypass(test_db: Session) -> None:
    """Factory method provides invariant when event listeners are bypassed.

    SQLAlchemy before_insert events do NOT fire for bulk_insert_mappings.
    The factory method ensures user_id is set regardless.
    """
    member = ResourceMember.create(
        resource_type="KnowledgeBase",
        resource_id=1,
        entity_type="user",
        entity_id="123",
    )
    # Verify pre-insert state is consistent
    assert member.user_id == 123

    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)

    # Verify post-insert state remains consistent
    assert member.user_id == 123


@pytest.mark.unit
def test_event_listener_handles_non_numeric_entity_id(test_db: Session) -> None:
    """Event listener should gracefully handle entity_id that cannot be cast to int."""
    member = ResourceMember(
        resource_type="KnowledgeBase",
        resource_id=1,
        entity_type="user",
        entity_id="not-a-number",
        role=ResourceRole.Reporter.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=0,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)

    assert member.user_id == 0


@pytest.mark.unit
def test_multiple_external_entity_types_isolated(test_db: Session) -> None:
    """Different external entity types should not interfere with each other."""
    owner = _create_user(test_db, "multi-type-owner")
    member = _create_user(test_db, "multi-type-member")
    namespace = _create_namespace(test_db, owner, "multi-type-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="multi-type-kb", namespace="default"),
    )

    # Register two different resolvers
    class MockTeamResolver(IExternalEntityResolver):
        def match_entity_bindings(
            self, db, user_id, entity_type, entity_ids, user_context=None
        ):
            if entity_type == "mock_team" and "team_a" in entity_ids:
                return ["team_a"]
            return []

        def get_resource_ids_by_entity(
            self, db, user_id, entity_type, user_context=None
        ):
            if entity_type != "mock_team":
                return []
            return [kb_id]

    register_entity_resolver("mock_department", MockDepartmentResolver)
    register_entity_resolver("mock_team", MockTeamResolver)

    # Add both entity types to the same KB
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_team",
        entity_id="team_a",
    )

    members = knowledge_share_service.get_members(test_db, kb_id, owner.id)
    entity_members = [m for m in members.members if m.entity_type != "user"]
    assert len(entity_members) == 2
    types = {m.entity_type for m in entity_members}
    assert types == {"mock_department", "mock_team"}


@pytest.mark.unit
def test_entity_shared_kb_appears_in_personal_listings(test_db: Session) -> None:
    """Entity-type shared KBs must surface in all three personal-scope list endpoints.

    Regression for Task #19: list_knowledge_bases(scope=PERSONAL),
    get_personal_knowledge_bases_grouped, and get_accessible_knowledge all
    previously filtered only entity_type='user' ResourceMember rows, so KBs
    shared via external entity resolvers (e.g. department bindings) were
    missing from chat context selectors and personal groupings.
    """
    owner = _create_user(test_db, "entity-list-owner")
    member = _create_user(test_db, "entity-list-member")
    namespace = _create_namespace(test_db, owner, "entity-list-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="entity-list-kb", namespace="default"),
    )

    register_entity_resolver(
        "mock_department",
        lambda: MockDepartmentResolver({member.id: {"dept_1"}}),
    )

    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )

    # 1. list_knowledge_bases(scope=PERSONAL)
    personal_list = KnowledgeService.list_knowledge_bases(
        test_db, member.id, scope=ResourceScope.PERSONAL
    )
    assert kb_id in {kb.id for kb in personal_list}

    # 2. get_personal_knowledge_bases_grouped -> shared_with_me
    grouped = KnowledgeService.get_personal_knowledge_bases_grouped(test_db, member.id)
    shared_ids = {kb.id for kb in grouped["shared_with_me"]}
    assert kb_id in shared_ids

    # 3. get_accessible_knowledge -> personal
    accessible = KnowledgeService.get_accessible_knowledge(test_db, member.id)
    accessible_ids = {kb.id for kb in accessible.personal}
    assert kb_id in accessible_ids


@pytest.mark.unit
def test_entity_shared_kb_not_leaked_to_unmatched_user(test_db: Session) -> None:
    """Users not matched by the resolver must not see the entity-shared KB."""
    owner = _create_user(test_db, "entity-leak-owner")
    member = _create_user(test_db, "entity-leak-member")
    outsider = _create_user(test_db, "entity-leak-outsider")
    namespace = _create_namespace(test_db, owner, "entity-leak-space")
    _add_namespace_member(test_db, namespace, owner, "Owner", owner.id)

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="entity-leak-kb", namespace="default"),
    )

    # Only `member` belongs to dept_1; `outsider` is unmapped.
    register_entity_resolver(
        "mock_department",
        lambda: MockDepartmentResolver({member.id: {"dept_1"}}),
    )

    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="mock_department",
        entity_id="dept_1",
    )

    personal_list = KnowledgeService.list_knowledge_bases(
        test_db, outsider.id, scope=ResourceScope.PERSONAL
    )
    assert kb_id not in {kb.id for kb in personal_list}

    grouped = KnowledgeService.get_personal_knowledge_bases_grouped(
        test_db, outsider.id
    )
    assert kb_id not in {kb.id for kb in grouped["shared_with_me"]}

    accessible = KnowledgeService.get_accessible_knowledge(test_db, outsider.id)
    assert kb_id not in {kb.id for kb in accessible.personal}


@pytest.mark.unit
def test_unknown_entity_type_rejected(test_db: Session) -> None:
    """add_member should reject unregistered entity types."""
    owner = _create_user(test_db, "unknown-type-owner")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="unknown-type-kb", namespace="default"),
    )

    with pytest.raises(HTTPException) as exc_info:
        knowledge_share_service.add_member(
            test_db,
            resource_id=kb_id,
            current_user_id=owner.id,
            target_user_id=0,
            role=MemberRole.Reporter,
            entity_type="nonexistent_type",
            entity_id="xxx",
        )
    assert exc_info.value.status_code == 400
    assert "Unknown entity type" in str(exc_info.value.detail)


@pytest.mark.unit
def test_entity_member_removed_permission_downgrade(
    test_db: Session,
) -> None:
    """Removing an entity member should downgrade user permissions accordingly."""
    owner = _create_user(test_db, "downgrade-owner")
    member = _create_user(test_db, "downgrade-member")

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="downgrade-kb", namespace="default"),
    )

    # Grant direct Reporter access
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=member.id,
        role=MemberRole.Reporter,
    )

    # Also grant via mock_department Maintainer
    register_entity_resolver(
        "mock_department",
        lambda: MockDepartmentResolver({member.id: {"dept_1"}}),
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Maintainer,
        entity_type="mock_department",
        entity_id="dept_1",
    )

    # Effective role should be Maintainer
    _, role, _ = knowledge_share_service.get_user_kb_permission(
        test_db, kb_id, member.id
    )
    assert role == ResourceRole.Maintainer.value

    # Remove the entity member
    members = knowledge_share_service.get_members(test_db, kb_id, owner.id)
    entity_member = next(
        (m for m in members.members if m.entity_type == "mock_department"), None
    )
    assert entity_member is not None
    knowledge_share_service.remove_member(test_db, kb_id, entity_member.id, owner.id)

    # Effective role should downgrade to Reporter
    _, role_after, _ = knowledge_share_service.get_user_kb_permission(
        test_db, kb_id, member.id
    )
    assert role_after == ResourceRole.Reporter.value


@pytest.mark.unit
def test_batch_add_members_duplicate_handling(
    test_db: Session,
) -> None:
    """Batch add should deduplicate entries within the same request."""
    owner = _create_user(test_db, "batch-dup-owner")
    user_a = _create_user(test_db, "batch-dup-a")

    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="batch-dup-kb", namespace="default"),
    )

    # Same user appears twice in the batch
    result = knowledge_share_service.batch_add_members(
        test_db,
        resource_id=kb_id,
        current_user_id=owner.id,
        members_data=[
            (user_a.id, MemberRole.Developer, None, None, None),
            (user_a.id, MemberRole.Reporter, None, None, None),
        ],
    )

    assert len(result.succeeded) == 1
    assert len(result.failed) == 1
    assert result.failed[0].error == "Duplicate entry in request"
