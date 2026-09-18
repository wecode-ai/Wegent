# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Team write paths must keep working while the Kind reader cache is warm.

``CachedKindReader`` returns session-detached instances on cache hits, so any
write path that reloads a Team through ``kindReader`` silently loses its
changes (and fails on ``db.refresh`` / ``db.delete``). These tests warm the
cache and then mutate through the service to catch such a regression.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.team import TeamUpdate
from app.services.adapters import team_kinds as team_kinds_module
from app.services.adapters.team_kinds import team_kinds_service
from app.services.readers.kind_cache import CachedKindReader, KindCacheStore
from app.services.readers.kinds import KindReader, KindType


class _FakeRedis:
    def __init__(self):
        self.data = {}

    def mget(self, keys):
        return [self.data.get(key) for key in keys]

    def setex(self, key, ttl, value):
        self.data[key] = value

    def incr(self, key):
        self.data[key] = str(int(self.data.get(key, 0)) + 1)
        return int(self.data[key])


def _create_team(db: Session, user_id: int, name: str = "dev-team") -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "pipeline"},
            "status": {"state": "Available"},
        },
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _warm_cache(db: Session, monkeypatch: pytest.MonkeyPatch, team_id: int) -> None:
    """Point the service at a warm cache whose hits are detached instances."""
    store = KindCacheStore()
    store._client = _FakeRedis()
    reader = CachedKindReader(KindReader(), store)
    monkeypatch.setattr(team_kinds_module, "kindReader", reader)

    reader.get_by_id(db, KindType.TEAM, team_id)  # miss -> populates the cache
    db.expunge_all()  # force every later read through a fresh query
    cached = reader.get_by_id(db, KindType.TEAM, team_id)
    assert cached not in db  # the cache hit is detached, as expected


def test_update_with_user_persists_while_cache_is_warm(
    test_db: Session, test_user, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = _create_team(test_db, test_user.id)
    _warm_cache(test_db, monkeypatch, team.id)

    team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(displayName="Cached Dev Team"),
        user_id=test_user.id,
    )

    test_db.expire_all()
    stored = test_db.query(Kind).filter(Kind.id == team.id).one()
    assert stored.json["metadata"]["displayName"] == "Cached Dev Team"


def test_delete_with_user_removes_row_while_cache_is_warm(
    test_db: Session, test_user, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = _create_team(test_db, test_user.id, name="delete-me")
    _warm_cache(test_db, monkeypatch, team.id)

    team_kinds_service.delete_with_user(
        test_db,
        team_id=team.id,
        user_id=test_user.id,
        force=True,
        confirm_name="delete-me",
    )

    assert test_db.query(Kind).filter(Kind.id == team.id).first() is None
