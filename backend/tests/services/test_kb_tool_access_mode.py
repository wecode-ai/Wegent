# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB tool access mode resolution."""

import importlib
from unittest.mock import Mock, patch

from sqlalchemy.orm import Session

from app.schemas.namespace import GroupRole
from app.services.group_permission import get_restricted_analyst_groups
from app.services.knowledge.knowledge_access_policy import (
    get_knowledge_base_tool_access_mode_by_ids,
)

knowledge_share_module = importlib.import_module(
    "app.services.knowledge.knowledge_access_policy"
)


class TestRestrictedAnalystBatchLookup:
    """Tests for batched RestrictedAnalyst resolution."""

    def test_get_restricted_analyst_groups_supports_inherited_roles(
        self, test_db, test_user
    ):
        """Parent-group restrictions apply to children using real memberships."""
        from app.models.namespace import Namespace
        from app.models.resource_member import ResourceMember

        groups = [
            Namespace(name=name, owner_user_id=test_user.id, is_active=True)
            for name in ["team", "team/subgroup", "other"]
        ]
        test_db.add_all(groups)
        test_db.flush()
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=groups[0].id,
                entity_type="user",
                entity_id=str(test_user.id),
                role="RestrictedAnalyst",
                status="approved",
            )
        )
        test_db.flush()
        restricted_groups = get_restricted_analyst_groups(
            test_db, user_id=test_user.id, group_names=["team/subgroup", "other"]
        )
        assert restricted_groups == {"team/subgroup"}


class TestKnowledgeBaseToolAccessMode:
    """Tests for KB tool access mode resolution."""

    def test_explicit_restricted_member_uses_search_only(self):
        """Explicit KB RestrictedAnalyst role should force search-only mode."""
        db = Mock(spec=Session)
        kb = Mock(id=10, namespace="default")

        kb_query = Mock()
        kb_query.filter.return_value.all.return_value = [kb]

        member_query = Mock()
        member_query.filter.return_value.first.return_value = (10,)

        db.query.side_effect = [kb_query, member_query]

        access_mode, reason = get_knowledge_base_tool_access_mode_by_ids(
            db,
            user_id=1,
            knowledge_base_ids=[10],
        )

        assert access_mode == "restricted_search_only"
        assert "search only" in reason

    def test_group_restricted_member_uses_search_only(self):
        """Group RestrictedAnalyst role should force search-only mode."""
        db = Mock(spec=Session)
        kb = Mock(id=11, namespace="team")

        kb_query = Mock()
        kb_query.filter.return_value.all.return_value = [kb]

        member_query = Mock()
        member_query.filter.return_value.first.return_value = None

        db.query.side_effect = [kb_query, member_query]

        with (
            patch.object(
                knowledge_share_module,
                "is_organization_namespace",
                return_value=False,
            ),
            patch.object(
                knowledge_share_module,
                "get_restricted_analyst_groups",
                return_value={"team"},
            ),
        ):
            access_mode, reason = get_knowledge_base_tool_access_mode_by_ids(
                db,
                user_id=1,
                knowledge_base_ids=[11],
            )

        assert access_mode == "restricted_search_only"
        assert "search only" in reason
