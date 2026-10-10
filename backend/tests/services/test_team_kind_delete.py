# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Team deletion cascading to orphaned member Bots."""

from app.models.kind import Kind
from app.services.kind_impl import TeamKindService


def _add_kind(db, *, kind, name, namespace="default", user_id=1, spec=None):
    """Insert an active Kind row with the given spec and return it."""
    resource = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": namespace},
            "spec": spec or {},
        },
    )
    db.add(resource)
    db.commit()
    return resource


def _add_team(db, *, name, bot_refs, namespace="default", user_id=1):
    """Insert an active Team whose members reference the given Bots."""
    return _add_kind(
        db,
        kind="Team",
        name=name,
        namespace=namespace,
        user_id=user_id,
        spec={"members": [{"botRef": ref} for ref in bot_refs]},
    )


def _bot_names(db):
    """Return the names of all active Bots."""
    return {
        bot.name
        for bot in db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True)
    }


class _SessionContext:
    """Wrap a session as a context manager without closing it on exit."""

    def __init__(self, session):
        self._session = session

    def __enter__(self):
        return self._session

    def __exit__(self, *args):
        return False


def test_delete_team_removes_orphaned_bot(test_db):
    """An exclusive member Bot is deleted together with its Team."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(test_db, kind="Bot", name="bot-a")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-a" not in _bot_names(test_db)


def test_delete_team_keeps_bot_referenced_by_other_team(test_db):
    """A Bot referenced by another active Team of the same owner is kept."""
    # Arrange: in the default namespace references are per-user, so the
    # blocking Team must belong to the same user
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-shared"}])
    _add_team(test_db, name="agent-b", bot_refs=[{"name": "bot-shared"}])
    _add_kind(test_db, kind="Bot", name="bot-shared")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-shared" in _bot_names(test_db)


def test_delete_team_keeps_bot_referenced_by_group_team_of_other_user(test_db):
    """Group-namespace references resolve namespace-wide, so a group Team of
    another user referencing the Bot blocks cleanup."""
    # Arrange
    team = _add_team(
        test_db, name="agent-a", namespace="group-a", bot_refs=[{"name": "bot-shared"}]
    )
    _add_team(
        test_db,
        name="agent-b",
        namespace="group-a",
        bot_refs=[{"name": "bot-shared"}],
        user_id=2,
    )
    _add_kind(test_db, kind="Bot", name="bot-shared", namespace="group-a")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-shared" in _bot_names(test_db)


def test_delete_team_keeps_bot_owned_by_another_user(test_db):
    """A Bot owned by another user is kept even when unreferenced elsewhere."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-foreign"}])
    _add_kind(test_db, kind="Bot", name="bot-foreign", user_id=2)
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-foreign" in _bot_names(test_db)


def test_delete_team_keeps_bot_in_other_namespace(test_db):
    """A botRef into another namespace never deletes that foreign Bot."""
    # Arrange: the botRef points at another namespace than the deleted Team
    team = _add_team(
        test_db,
        name="agent-a",
        bot_refs=[{"name": "bot-elsewhere", "namespace": "group-a"}],
    )
    _add_kind(test_db, kind="Bot", name="bot-elsewhere", namespace="group-a")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-elsewhere" in _bot_names(test_db)


def test_delete_group_team_removes_group_bot(test_db):
    """A group-namespace Team cleans up its same-namespace member Bot."""
    # Arrange: reproduce the incident shape - group namespace Team with a
    # same-namespace member Bot referencing a shared Model
    team = _add_team(
        test_db,
        name="review-agent",
        namespace="group-review",
        bot_refs=[{"name": "review-bot", "namespace": "group-review"}],
    )
    _add_kind(
        test_db,
        kind="Bot",
        name="review-bot",
        namespace="group-review",
        spec={
            "modelRef": {
                "name": "shared-model",
                "namespace": "group-review",
            }
        },
    )
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "review-bot" not in _bot_names(test_db)


def test_delete_team_ignores_inactive_team_references(test_db):
    """An inactive Team referencing the Bot does not block cleanup."""
    # Arrange: the referencing Team belongs to the same owner so that, if it
    # were active, it would block the cleanup
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-stale"}])
    stale_team = _add_team(test_db, name="agent-old", bot_refs=[{"name": "bot-stale"}])
    stale_team.is_active = False
    test_db.commit()
    _add_kind(test_db, kind="Bot", name="bot-stale")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-stale" not in _bot_names(test_db)


def test_delete_team_keeps_same_name_bot_in_other_namespace(test_db):
    """A same-named Bot in another namespace is not matched or deleted."""
    # Arrange: the Team references the default-namespace Bot; a second Bot
    # with the same name exists in another namespace and must survive
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-dup"}])
    _add_kind(test_db, kind="Bot", name="bot-dup")
    _add_kind(test_db, kind="Bot", name="bot-dup", namespace="group-b", user_id=2)
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    remaining = {
        (bot.namespace, bot.name)
        for bot in test_db.query(Kind).filter(
            Kind.kind == "Bot", Kind.is_active == True
        )
    }
    assert remaining == {("group-b", "bot-dup")}


def test_delete_resource_removes_orphaned_bot(test_db, monkeypatch):
    """The full delete_resource lifecycle also cleans up orphaned Bots."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(test_db, kind="Bot", name="bot-a")
    service = TeamKindService()
    monkeypatch.setattr(
        TeamKindService, "get_db", lambda self: _SessionContext(test_db)
    )

    # Act
    assert service.delete_resource(team.user_id, "default", "agent-a") is True

    # Assert
    assert "bot-a" not in _bot_names(test_db)
    active_teams = (
        test_db.query(Kind)
        .filter(Kind.kind == "Team", Kind.name == "agent-a", Kind.is_active == True)
        .count()
    )
    assert active_teams == 0


def test_delete_team_removes_orphaned_ghost(test_db):
    """An exclusive Ghost referenced by the deleted Bot is removed too."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(
        test_db,
        kind="Bot",
        name="bot-a",
        spec={"ghostRef": {"name": "ghost-a"}},
    )
    _add_kind(test_db, kind="Ghost", name="ghost-a")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    remaining = {
        (kind.kind, kind.name)
        for kind in test_db.query(Kind).filter(Kind.is_active == True)
    }
    assert ("Bot", "bot-a") not in remaining
    assert ("Ghost", "ghost-a") not in remaining


def test_delete_team_keeps_ghost_referenced_by_other_bot(test_db):
    """A Ghost referenced by another active Bot is kept."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(
        test_db,
        kind="Bot",
        name="bot-a",
        spec={"ghostRef": {"name": "ghost-shared"}},
    )
    _add_kind(
        test_db,
        kind="Bot",
        name="bot-b",
        spec={"ghostRef": {"name": "ghost-shared"}},
    )
    _add_kind(test_db, kind="Ghost", name="ghost-shared")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert: bot-a is gone, its shared Ghost survives for bot-b
    remaining = {
        (kind.kind, kind.name)
        for kind in test_db.query(Kind).filter(Kind.is_active == True)
    }
    assert ("Bot", "bot-a") not in remaining
    assert ("Ghost", "ghost-shared") in remaining


def test_delete_with_user_removes_orphaned_bot(test_db):
    """The /api/teams adapter delete path also cleans up orphaned Bots."""
    from app.services.adapters.team_kinds import team_kinds_service

    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(test_db, kind="Bot", name="bot-a")

    # Act
    team_kinds_service.delete_with_user(
        db=test_db,
        team_id=team.id,
        user_id=team.user_id,
        force=True,
        confirm_name="agent-a",
    )

    # Assert
    assert "bot-a" not in _bot_names(test_db)
    remaining_teams = (
        test_db.query(Kind)
        .filter(Kind.kind == "Team", Kind.name == "agent-a", Kind.is_active == True)
        .count()
    )
    assert remaining_teams == 0


def test_default_namespace_references_are_owner_scoped(test_db):
    """Another user's Team referencing the same default-namespace Bot name
    points at that user's Bot and must not block this owner's cleanup."""
    # Arrange: user 2 has a Team referencing "bot-x" (their own default Bot)
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-x"}])
    _add_team(test_db, name="agent-b", bot_refs=[{"name": "bot-x"}], user_id=2)
    _add_kind(test_db, kind="Bot", name="bot-x")
    _add_kind(test_db, kind="Bot", name="bot-x", user_id=2)
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert: user 1's Bot is deleted, user 2's same-named Bot survives
    remaining = {
        (bot.user_id, bot.name)
        for bot in test_db.query(Kind).filter(
            Kind.kind == "Bot", Kind.is_active == True
        )
    }
    assert remaining == {(2, "bot-x")}


def test_default_namespace_ghost_references_are_owner_scoped(test_db):
    """Another user's Bot referencing the same default-namespace Ghost name
    must not block this owner's Ghost cleanup."""
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-a"}])
    _add_kind(test_db, kind="Bot", name="bot-a", spec={"ghostRef": {"name": "ghost-x"}})
    _add_kind(test_db, kind="Ghost", name="ghost-x")
    _add_kind(
        test_db,
        kind="Bot",
        name="bot-b",
        user_id=2,
        spec={"ghostRef": {"name": "ghost-x"}},
    )
    _add_kind(test_db, kind="Ghost", name="ghost-x", user_id=2)
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert: user 1's Bot and Ghost are deleted, user 2's survive
    remaining = {
        (kind.kind, kind.user_id, kind.name)
        for kind in test_db.query(Kind).filter(Kind.is_active == True)
    }
    assert ("Bot", 1, "bot-a") not in remaining
    assert ("Ghost", 1, "ghost-x") not in remaining
    assert ("Bot", 2, "bot-b") in remaining
    assert ("Ghost", 2, "ghost-x") in remaining
