# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Team deletion cascading to orphaned member Bots."""

from app.models.kind import Kind
from app.services.kind_impl import TeamKindService


def _add_kind(db, *, kind, name, namespace="default", user_id=1, spec=None):
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
    return _add_kind(
        db,
        kind="Team",
        name=name,
        namespace=namespace,
        user_id=user_id,
        spec={"members": [{"botRef": ref} for ref in bot_refs]},
    )


def _bot_names(db):
    return {
        bot.name
        for bot in db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True)
    }


def test_delete_team_removes_orphaned_bot(test_db):
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
    # Arrange
    team = _add_team(test_db, name="agent-a", bot_refs=[{"name": "bot-shared"}])
    _add_team(test_db, name="agent-b", bot_refs=[{"name": "bot-shared"}], user_id=2)
    _add_kind(test_db, kind="Bot", name="bot-shared")
    service = TeamKindService()

    # Act
    service._pre_delete_side_effects(test_db, team.user_id, team)
    test_db.commit()

    # Assert
    assert "bot-shared" in _bot_names(test_db)


def test_delete_team_keeps_bot_owned_by_another_user(test_db):
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
