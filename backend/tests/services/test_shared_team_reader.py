# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for shared Team database and cache readers."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.services.readers.shared_teams import SharedTeamReader
from wecode.cache import shared_teams as cached_shared_teams


def _add_member(
    db: Session,
    *,
    team_id: int,
    user_id: int,
    resource_type: str,
    status: str,
) -> ResourceMember:
    member = ResourceMember(
        resource_type=resource_type,
        resource_id=team_id,
        entity_type="user",
        entity_id=str(user_id),
        role="Reporter",
        status=status,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def test_reader_supports_canonical_and_legacy_share_values(
    test_db: Session,
) -> None:
    user_id = 101
    _add_member(
        test_db,
        team_id=201,
        user_id=user_id,
        resource_type=ResourceType.TEAM.value,
        status=MemberStatus.APPROVED.value,
    )
    _add_member(
        test_db,
        team_id=202,
        user_id=user_id,
        resource_type=ResourceType.TEAM.name,
        status=MemberStatus.APPROVED.name,
    )
    reader = SharedTeamReader()

    result = reader.get_shared_team_ids(test_db, user_id)

    assert set(result) == {201, 202}
    assert reader.is_shared_to_user(test_db, 202, user_id)


def test_cache_extension_registers_resource_member_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = Mock()
    register_events = Mock()
    monkeypatch.setattr(cached_shared_teams, "get_redis_client", lambda: redis)
    monkeypatch.setattr(cached_shared_teams, "register_events", register_events)
    monkeypatch.setattr(cached_shared_teams, "_events_registered", False)

    reader = cached_shared_teams.wrap(SharedTeamReader())

    assert isinstance(reader, cached_shared_teams.CachedSharedTeamReader)
    register_events.assert_called_once_with(
        ResourceMember,
        cached_shared_teams._on_change,
        reader,
    )


def test_cache_change_invalidates_direct_team_member() -> None:
    reader = Mock()
    target = SimpleNamespace(
        resource_type=ResourceType.TEAM.value,
        resource_id=301,
        entity_type="user",
        entity_id="401",
    )

    cached_shared_teams._on_change("INSERT", target, reader)

    reader.on_change.assert_called_once_with(team_id=301, user_id=401)


@pytest.mark.parametrize(
    ("resource_type", "entity_type"),
    [
        (ResourceType.TASK.value, "user"),
        (ResourceType.TEAM.value, "namespace"),
    ],
)
def test_cache_change_ignores_unrelated_members(
    resource_type: str,
    entity_type: str,
) -> None:
    reader = Mock()
    target = SimpleNamespace(
        resource_type=resource_type,
        resource_id=501,
        entity_type=entity_type,
        entity_id="601",
    )

    cached_shared_teams._on_change("UPDATE", target, reader)

    reader.on_change.assert_not_called()
