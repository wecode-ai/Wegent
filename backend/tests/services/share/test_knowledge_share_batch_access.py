# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.services.share.knowledge_share_service import KnowledgeShareService


def _namespace(db: Session, owner: User, name: str, level: str) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="internal",
        description="test namespace",
        level=level,
        is_active=True,
    )
    db.add(namespace)
    db.flush()
    return namespace


def _knowledge_base(db: Session, owner_id: int, name: str, namespace: str) -> Kind:
    knowledge_base = Kind(
        user_id=owner_id,
        kind="KnowledgeBase",
        name=name,
        namespace=namespace,
        is_active=True,
        json={"spec": {"name": name}},
    )
    db.add(knowledge_base)
    db.flush()
    return knowledge_base


def test_batch_access_includes_personal_group_and_organization_sources(
    test_db: Session,
    test_user: User,
) -> None:
    other = User(
        user_name="knowledge-owner-other",
        password_hash="unused",
        email="knowledge-owner-other@example.com",
        is_active=True,
        role="user",
    )
    test_db.add(other)
    test_db.flush()
    group = _namespace(test_db, other, "knowledge-team-space", "group")
    organization = _namespace(
        test_db,
        other,
        "knowledge-organization-space",
        "organization",
    )
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Developer",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=other.id,
            share_link_id=0,
            reviewed_by_user_id=other.id,
            copied_resource_id=0,
        )
    )
    personal = _knowledge_base(test_db, test_user.id, "Personal", "default")
    group_kb = _knowledge_base(test_db, other.id, "Group", group.name)
    organization_kb = _knowledge_base(
        test_db,
        other.id,
        "Organization",
        organization.name,
    )
    inaccessible = _knowledge_base(test_db, other.id, "Private", "default")
    test_db.commit()

    accessible = KnowledgeShareService().get_accessible_resources_by_ids(
        test_db,
        [personal.id, group_kb.id, organization_kb.id, inaccessible.id],
        test_user.id,
    )

    assert set(accessible) == {personal.id, group_kb.id, organization_kb.id}
