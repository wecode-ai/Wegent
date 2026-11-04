# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise navigation fields against real stored ACLs and source spaces."""

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import ResourceRole
from app.schemas.knowledge import (
    AllGroupedKnowledgeResponse,
    KnowledgeBaseCreate,
    KnowledgeBaseWithGroupInfo,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_access_policy import (
    resolve_knowledge_base_permission,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from tests.services.knowledge.test_namespace_knowledge_permissions import (
    _add_kb_member,
    _add_member,
    _create_namespace,
    _create_user,
    _get_kind,
)


def _rows(
    response: AllGroupedKnowledgeResponse,
) -> list[KnowledgeBaseWithGroupInfo]:
    return [
        *response.personal.created_by_me,
        *response.personal.shared_with_me,
        *(kb for group in response.groups for kb in group.knowledge_bases),
        *response.organization.knowledge_bases,
    ]


@pytest.mark.unit
@pytest.mark.parametrize("space", ["group", "organization"])
def test_creator_discovers_cross_space_library_without_membership(
    test_db: Session, space: str
) -> None:
    creator = _create_user(test_db, "creator")
    ns = _create_namespace(test_db, creator, "source", level=space)
    member = _add_member(test_db, ns, creator, GroupRole.Developer, creator.id)
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, creator.id, KnowledgeBaseCreate(name="created", namespace=ns.name)
    )
    test_db.delete(member)
    test_db.commit()

    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, creator.id)

    rows = [row for row in _rows(response) if row.id == kb_id]
    assert rows
    assert all(row.namespace_level == space for row in rows)
    assert all(row.namespace_display_name == ns.display_name for row in rows)
    assert all(row.my_role == "Owner" for row in rows)


@pytest.mark.unit
@pytest.mark.parametrize("role", [ResourceRole.Reporter, ResourceRole.Maintainer])
def test_all_copies_use_source_space_and_authoritative_role(
    test_db: Session, role: ResourceRole
) -> None:
    owner = _create_user(test_db, "owner")
    viewer = _create_user(test_db, "viewer")
    ns = _create_namespace(test_db, owner, "source")
    ns.display_name = "Actual source space"
    _add_member(test_db, ns, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, ns, viewer, GroupRole.Reporter, owner.id)
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="shared", namespace=ns.name)
    )
    _add_kb_member(test_db, kb_id, viewer, role, owner.id)

    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, viewer.id)
    permission = resolve_knowledge_base_permission(
        test_db, _get_kind(test_db, kb_id), viewer.id
    )

    rows = [row for row in _rows(response) if row.id == kb_id]
    assert rows
    assert all(row.namespace_level == "group" for row in rows)
    assert all(row.namespace_display_name == "Actual source space" for row in rows)
    assert all(row.my_role == permission.role.value for row in rows)


@pytest.mark.unit
def test_unknown_space_is_not_invented(test_db: Session) -> None:
    creator = _create_user(test_db, "creator")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, creator.id, KnowledgeBaseCreate(name="orphan")
    )
    kb = _get_kind(test_db, kb_id)
    kb.namespace = "missing-space"
    test_db.commit()

    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, creator.id)

    row = next(row for row in _rows(response) if row.id == kb_id)
    assert row.namespace_level is None
    assert row.namespace_display_name is None
    assert row.my_role == "Owner"


@pytest.mark.unit
def test_direct_access_gate_still_excludes_reader_and_explicit_denial(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner")
    viewer = _create_user(test_db, "viewer")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="restricted", direct_access_requirement="edit"),
    )
    member = _add_kb_member(test_db, kb_id, viewer, ResourceRole.Reporter, owner.id)
    assert kb_id not in {
        row.id
        for row in _rows(
            KnowledgeService.get_all_knowledge_bases_grouped(test_db, viewer.id)
        )
    }
    member.role = ResourceRole.RestrictedAnalyst.value
    test_db.commit()
    assert kb_id not in {
        row.id
        for row in _rows(
            KnowledgeService.get_all_knowledge_bases_grouped(test_db, viewer.id)
        )
    }
