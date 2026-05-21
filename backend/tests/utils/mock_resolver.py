# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared mock resolver and fixtures for entity permission tests."""

from typing import Optional

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.services.share.external_entity_resolver import (
    IExternalEntityResolver,
    _external_entity_resolvers,
    register_entity_resolver,
)


class MockDepartmentResolver(IExternalEntityResolver):
    """Mock resolver for external entity types.

    Accepts entity_type at construction to support any registered type.
    """

    def __init__(
        self,
        user_dept_map: Optional[dict[int, set[str]]] = None,
        entity_type: str = "mock_department",
    ):
        self.user_dept_map = user_dept_map or {}
        self._entity_type = entity_type

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
        if entity_type != self._entity_type:
            return []
        user_depts = self.user_dept_map.get(user_id, set())
        return list(user_depts & set(entity_ids))

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        resource_type: str = ResourceType.KNOWLEDGE_BASE.value,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != self._entity_type:
            return []
        user_depts = self.user_dept_map.get(user_id, set())
        if not user_depts:
            return []
        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == resource_type,
                ResourceMember.entity_type == self._entity_type,
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
