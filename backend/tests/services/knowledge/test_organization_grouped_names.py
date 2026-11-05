# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.mark.unit
@pytest.mark.parametrize("display_name", [None, "", "Company Knowledge"])
def test_grouped_company_knowledge_uses_namespace_name_when_label_is_missing(
    test_db: Session, test_user: User, display_name: str | None
) -> None:
    test_user.role = "admin"
    namespace = Namespace(
        name="company-space",
        display_name=display_name,
        owner_user_id=test_user.id,
        level="organization",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="company-kb", namespace=namespace.name),
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, test_user.id)

    expected_label = display_name or namespace.name
    assert grouped.organization.display_name == expected_label
    assert grouped.organization.namespace == namespace.name
    assert len(grouped.organization.knowledge_bases) == 1
    company_kb = grouped.organization.knowledge_bases[0]
    assert company_kb.id == knowledge_base_id
    assert company_kb.namespace == namespace.name
    assert company_kb.group_name == expected_label
