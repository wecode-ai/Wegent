# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep the shared grouped API independent of knowledge-page navigation."""

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import ResourceRole
from app.schemas.knowledge import (
    AllGroupedKnowledgeResponse,
    KnowledgeBaseCreate,
    KnowledgeBaseWithGroupInfo,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService
from tests.services.knowledge.test_namespace_knowledge_permissions import (
    _add_kb_member,
    _add_member,
    _create_namespace,
    _create_user,
)


@pytest.mark.unit
def test_creator_team_library_stays_in_its_native_group(test_db: Session) -> None:
    owner = _create_user(test_db, "namespace-owner")
    creator = _create_user(test_db, "library-creator")
    namespace = _create_namespace(test_db, owner, "team-source")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, creator, GroupRole.Developer, owner.id)
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        creator.id,
        KnowledgeBaseCreate(name="team-library", namespace=namespace.name),
    )

    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, creator.id)

    assert kb_id not in {row.id for row in response.personal.created_by_me}
    group = next(
        group for group in response.groups if group.group_name == namespace.name
    )
    row = next(row for row in group.knowledge_bases if row.id == kb_id)
    assert row.namespace == namespace.name
    assert row.user_id == creator.id
    assert row.my_role == "Developer"
    assert "namespace_level" not in row.model_dump()
    assert "namespace_display_name" not in row.model_dump()


def _rows(response: AllGroupedKnowledgeResponse) -> list[KnowledgeBaseWithGroupInfo]:
    return [
        *response.personal.created_by_me,
        *response.personal.shared_with_me,
        *(kb for group in response.groups for kb in group.knowledge_bases),
        *response.organization.knowledge_bases,
    ]


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
