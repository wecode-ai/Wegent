# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for SharedTaskService._get_public_task_display_config."""

from unittest.mock import MagicMock, patch

import pytest

from app.services.shared_task import SharedTaskService


@pytest.fixture
def service():
    return SharedTaskService()


@pytest.fixture
def db():
    return MagicMock()


def _make_task(*, team_ref, user_id=1):
    task = MagicMock()
    task.user_id = user_id
    task.json = {"spec": {"teamRef": team_ref}}
    return task


class TestGetPublicTaskDisplayConfig:
    def test_uses_team_id_when_present(self, service, db):
        """teamRef.id takes precedence and does not fall back to same-name Team."""
        team = MagicMock()
        team.json = {"spec": {"displayConfig": {"show_header": True}}}
        task = _make_task(team_ref={"id": 7, "name": "team", "namespace": "default"})

        with patch(
            "app.services.shared_task.resolve_kind_reference",
        ) as mock_resolve:
            mock_resolve.return_value.resource = team
            result = service._get_public_task_display_config(db, task)

        assert result == {"show_header": True}
        mock_resolve.assert_called_once()
        call_kwargs = mock_resolve.call_args.kwargs
        assert call_kwargs["kind"] == "Team"
        assert call_kwargs["ref"]["id"] == 7
        assert call_kwargs["actor_user_id"] == 1

    def test_no_fallback_when_id_is_invalid(self, service, db):
        """An invalid/obsolete teamRef.id must not resolve to a same-name Team."""
        task = _make_task(team_ref={"id": 999, "name": "team", "namespace": "default"})

        with patch(
            "app.services.shared_task.resolve_kind_reference",
        ) as mock_resolve:
            mock_resolve.return_value.resource = None
            result = service._get_public_task_display_config(db, task)

        assert result == {}
        mock_resolve.assert_called_once()

    def test_legacy_name_query_without_id(self, service, db):
        """Old shared tasks without teamRef.id still resolve by name+namespace."""
        team = MagicMock()
        team.json = {"spec": {"displayConfig": {"theme": "dark"}}}
        task = _make_task(team_ref={"name": "legacy-team", "namespace": "default"})

        with patch(
            "app.services.shared_task.kindReader.get_by_name_and_namespace",
            return_value=team,
        ) as mock_reader:
            result = service._get_public_task_display_config(db, task)

        assert result == {"theme": "dark"}
        mock_reader.assert_called_once_with(db, 1, "Team", "default", "legacy-team")

    def test_legacy_user_id_query_without_id(self, service, db):
        """teamRef.user_id + name path still works for legacy data."""
        team = MagicMock()
        team.json = {"spec": {"displayConfig": {"compact": True}}}
        task = _make_task(
            team_ref={
                "name": "owner-team",
                "namespace": "default",
                "user_id": 42,
            }
        )

        db.query.return_value.filter.return_value.first.return_value = team
        result = service._get_public_task_display_config(db, task)

        assert result == {"compact": True}

    def test_missing_name_returns_empty(self, service, db):
        task = _make_task(team_ref={"id": 7})
        assert service._get_public_task_display_config(db, task) == {}

    def test_invalid_team_ref_returns_empty(self, service, db):
        task = MagicMock()
        task.json = {"spec": {"teamRef": "not-a-dict"}}
        assert service._get_public_task_display_config(db, task) == {}
