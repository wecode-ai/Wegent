# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for KnowledgeBaseNameResolver.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.openapi.kb_resolver import (
    KnowledgeBaseNameResolver,
    KnowledgeBaseResolutionResult,
    ResolvedKnowledgeBase,
    resolve_knowledge_base_names,
)


class TestKnowledgeBaseNameResolver:
    """Test cases for KnowledgeBaseNameResolver."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def resolver(self, mock_db):
        """Create a KnowledgeBaseNameResolver instance."""
        return KnowledgeBaseNameResolver(mock_db, user_id=1)

    def _create_mock_accessible_kb(self, kb_id, namespace, name):
        """Helper to create a mock accessible KB for _get_accessible_kb_lookup."""
        mock_kb = MagicMock()
        mock_kb.id = kb_id
        mock_kb.namespace = namespace
        mock_kb.name = name
        return mock_kb

    def _create_mock_grouped_response(
        self, created_by_me=None, shared_with_me=None, groups=None, org_kbs=None
    ):
        """Helper to create a mock AllGroupedKnowledgeResponse."""
        mock_response = MagicMock()
        mock_response.personal.created_by_me = created_by_me or []
        mock_response.personal.shared_with_me = shared_with_me or []
        mock_response.groups = groups or []
        mock_response.organization.knowledge_bases = org_kbs or []
        return mock_response

    def test_resolve_single_kb_success(self, resolver, mock_db):
        """Test resolving a single knowledge base successfully."""
        accessible_kb = self._create_mock_accessible_kb(123, "default", "my_kb")
        grouped_response = self._create_mock_grouped_response(
            created_by_me=[accessible_kb]
        )

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "default", "name": "my_kb"}]
            result = resolver.resolve(kb_names, raise_on_error=True)

            assert len(result.resolved) == 1
            assert result.resolved[0].kb_id == 123
            assert result.resolved[0].namespace == "default"
            assert result.resolved[0].name == "my_kb"
            assert len(result.not_found) == 0
            assert len(result.no_access) == 0

    def test_resolve_multiple_kbs_success(self, resolver, mock_db):
        """Test resolving multiple knowledge bases successfully."""
        accessible_kb1 = self._create_mock_accessible_kb(1, "default", "kb1")
        accessible_kb2 = self._create_mock_accessible_kb(2, "org", "kb2")
        grouped_response = self._create_mock_grouped_response(
            created_by_me=[accessible_kb1], org_kbs=[accessible_kb2]
        )

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [
                {"namespace": "default", "name": "kb1"},
                {"namespace": "org", "name": "kb2"},
            ]
            result = resolver.resolve(kb_names, raise_on_error=True)

            assert len(result.resolved) == 2
            kb_ids = {r.kb_id for r in result.resolved}
            assert kb_ids == {1, 2}

    def test_resolve_kb_not_found(self, resolver, mock_db):
        """Test resolving a KB that doesn't exist."""
        grouped_response = self._create_mock_grouped_response()

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "default", "name": "nonexistent"}]

            with pytest.raises(HTTPException) as exc_info:
                resolver.resolve(kb_names, raise_on_error=True)

            assert exc_info.value.status_code == 403

    def test_resolve_kb_no_access(self, resolver, mock_db):
        """Test resolving a KB without access permission."""
        # KB exists in database but not in accessible list
        grouped_response = self._create_mock_grouped_response()

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "default", "name": "private_kb"}]

            with pytest.raises(HTTPException) as exc_info:
                resolver.resolve(kb_names, raise_on_error=True)

            assert exc_info.value.status_code == 403

    def test_resolve_partial_failure_no_raise(self, resolver, mock_db):
        """Test partial failure with raise_on_error=False."""
        accessible_kb = self._create_mock_accessible_kb(123, "default", "existing_kb")
        grouped_response = self._create_mock_grouped_response(
            created_by_me=[accessible_kb]
        )

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [
                {"namespace": "default", "name": "existing_kb"},
                {"namespace": "default", "name": "nonexistent"},
            ]
            result = resolver.resolve(kb_names, raise_on_error=False)

            assert len(result.resolved) == 1
            assert len(result.no_access) == 1

    def test_resolve_empty_name(self, resolver, mock_db):
        """Test resolving with empty name."""
        grouped_response = self._create_mock_grouped_response()

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "default", "name": ""}]
            result = resolver.resolve(kb_names, raise_on_error=False)

            assert len(result.resolved) == 0
            assert len(result.not_found) == 1

    def test_resolve_organization_kb_access(self, resolver, mock_db):
        """Test resolving organization KB - all users have access."""
        accessible_kb = self._create_mock_accessible_kb(100, "org-namespace", "org_kb")
        grouped_response = self._create_mock_grouped_response(org_kbs=[accessible_kb])

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "org-namespace", "name": "org_kb"}]
            result = resolver.resolve(kb_names, raise_on_error=True)

            assert len(result.resolved) == 1
            assert result.resolved[0].kb_id == 100

    def test_resolve_team_kb_with_group_membership(self, resolver, mock_db):
        """Test resolving team KB with group membership."""
        accessible_kb = self._create_mock_accessible_kb(200, "team-ns", "team_kb")
        mock_group = MagicMock()
        mock_group.knowledge_bases = [accessible_kb]
        grouped_response = self._create_mock_grouped_response(groups=[mock_group])

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "team-ns", "name": "team_kb"}]
            result = resolver.resolve(kb_names, raise_on_error=True)

            assert len(result.resolved) == 1
            assert result.resolved[0].kb_id == 200

    def test_resolve_team_kb_no_group_membership(self, resolver, mock_db):
        """Test resolving team KB without group membership."""
        # KB not in accessible list (user not in group)
        grouped_response = self._create_mock_grouped_response()

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = grouped_response

            kb_names = [{"namespace": "team-ns", "name": "team_kb"}]

            with pytest.raises(HTTPException) as exc_info:
                resolver.resolve(kb_names, raise_on_error=True)

            assert exc_info.value.status_code == 403

    def test_resolve_empty_list(self, resolver, mock_db):
        """Test resolving empty list of KB names."""
        result = resolver.resolve([], raise_on_error=True)

        assert len(result.resolved) == 0
        assert len(result.not_found) == 0
        assert len(result.no_access) == 0


class TestGetAccessibleKbLookup:
    """Test cases for _get_accessible_kb_lookup method."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def resolver(self, mock_db):
        """Create a KnowledgeBaseNameResolver instance."""
        return KnowledgeBaseNameResolver(mock_db, user_id=1)

    def test_get_accessible_kb_lookup_personal(self, resolver, mock_db):
        """Test _get_accessible_kb_lookup includes personal KBs."""
        mock_kb = MagicMock()
        mock_kb.id = 1
        mock_kb.namespace = "default"
        mock_kb.name = "my_kb"

        mock_response = MagicMock()
        mock_response.personal.created_by_me = [mock_kb]
        mock_response.personal.shared_with_me = []
        mock_response.groups = []
        mock_response.organization.knowledge_bases = []

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            lookup = resolver._get_accessible_kb_lookup()

            assert lookup == {("default", "my_kb"): 1}

    def test_get_accessible_kb_lookup_shared(self, resolver, mock_db):
        """Test _get_accessible_kb_lookup includes shared KBs."""
        mock_kb = MagicMock()
        mock_kb.id = 2
        mock_kb.namespace = "default"
        mock_kb.name = "shared_kb"

        mock_response = MagicMock()
        mock_response.personal.created_by_me = []
        mock_response.personal.shared_with_me = [mock_kb]
        mock_response.groups = []
        mock_response.organization.knowledge_bases = []

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            lookup = resolver._get_accessible_kb_lookup()

            assert lookup == {("default", "shared_kb"): 2}

    def test_get_accessible_kb_lookup_group(self, resolver, mock_db):
        """Test _get_accessible_kb_lookup includes group KBs."""
        mock_kb = MagicMock()
        mock_kb.id = 3
        mock_kb.namespace = "team-ns"
        mock_kb.name = "team_kb"

        mock_group = MagicMock()
        mock_group.knowledge_bases = [mock_kb]

        mock_response = MagicMock()
        mock_response.personal.created_by_me = []
        mock_response.personal.shared_with_me = []
        mock_response.groups = [mock_group]
        mock_response.organization.knowledge_bases = []

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            lookup = resolver._get_accessible_kb_lookup()

            assert lookup == {("team-ns", "team_kb"): 3}

    def test_get_accessible_kb_lookup_organization(self, resolver, mock_db):
        """Test _get_accessible_kb_lookup includes organization KBs."""
        mock_kb = MagicMock()
        mock_kb.id = 4
        mock_kb.namespace = "org-ns"
        mock_kb.name = "org_kb"

        mock_response = MagicMock()
        mock_response.personal.created_by_me = []
        mock_response.personal.shared_with_me = []
        mock_response.groups = []
        mock_response.organization.knowledge_bases = [mock_kb]

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            lookup = resolver._get_accessible_kb_lookup()

            assert lookup == {("org-ns", "org_kb"): 4}

    def test_get_accessible_kb_lookup_combined(self, resolver, mock_db):
        """Test _get_accessible_kb_lookup combines all sources."""
        personal_kb = MagicMock()
        personal_kb.id = 1
        personal_kb.namespace = "default"
        personal_kb.name = "personal_kb"

        shared_kb = MagicMock()
        shared_kb.id = 2
        shared_kb.namespace = "default"
        shared_kb.name = "shared_kb"

        group_kb = MagicMock()
        group_kb.id = 3
        group_kb.namespace = "team-ns"
        group_kb.name = "group_kb"

        org_kb = MagicMock()
        org_kb.id = 4
        org_kb.namespace = "org-ns"
        org_kb.name = "org_kb"

        mock_group = MagicMock()
        mock_group.knowledge_bases = [group_kb]

        mock_response = MagicMock()
        mock_response.personal.created_by_me = [personal_kb]
        mock_response.personal.shared_with_me = [shared_kb]
        mock_response.groups = [mock_group]
        mock_response.organization.knowledge_bases = [org_kb]

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            lookup = resolver._get_accessible_kb_lookup()

            assert lookup == {
                ("default", "personal_kb"): 1,
                ("default", "shared_kb"): 2,
                ("team-ns", "group_kb"): 3,
                ("org-ns", "org_kb"): 4,
            }


class TestResolveKnowledgeBaseNamesFunction:
    """Test cases for resolve_knowledge_base_names convenience function."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    def test_convenience_function(self, mock_db):
        """Test the convenience function works correctly."""
        accessible_kb = MagicMock()
        accessible_kb.id = 789
        accessible_kb.namespace = "default"
        accessible_kb.name = "test_kb"

        mock_response = MagicMock()
        mock_response.personal.created_by_me = [accessible_kb]
        mock_response.personal.shared_with_me = []
        mock_response.groups = []
        mock_response.organization.knowledge_bases = []

        with patch(
            "app.services.openapi.kb_resolver.KnowledgeService.get_all_knowledge_bases_grouped"
        ) as mock_get_grouped:
            mock_get_grouped.return_value = mock_response

            kb_names = [{"namespace": "default", "name": "test_kb"}]
            result = resolve_knowledge_base_names(mock_db, 1, kb_names)

            assert len(result.resolved) == 1
            assert result.resolved[0].kb_id == 789


class TestResolvedKnowledgeBase:
    """Test cases for ResolvedKnowledgeBase named tuple."""

    def test_named_tuple_fields(self):
        """Test ResolvedKnowledgeBase has correct fields."""
        resolved = ResolvedKnowledgeBase(
            kb_id=1, namespace="default", name="test", display_name="Test KB"
        )

        assert resolved.kb_id == 1
        assert resolved.namespace == "default"
        assert resolved.name == "test"
        assert resolved.display_name == "Test KB"


class TestKnowledgeBaseResolutionResult:
    """Test cases for KnowledgeBaseResolutionResult named tuple."""

    def test_named_tuple_fields(self):
        """Test KnowledgeBaseResolutionResult has correct fields."""
        resolved = [ResolvedKnowledgeBase(1, "default", "kb1", "KB1")]
        not_found = [{"namespace": "default", "name": "missing"}]
        no_access = [{"namespace": "org", "name": "private"}]

        result = KnowledgeBaseResolutionResult(
            resolved=resolved, not_found=not_found, no_access=no_access
        )

        assert len(result.resolved) == 1
        assert len(result.not_found) == 1
        assert len(result.no_access) == 1
