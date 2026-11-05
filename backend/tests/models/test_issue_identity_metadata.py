"""Issue identity persists in the existing metadata without schema changes."""

import pytest
from sqlalchemy import update

from app.db.base import Base
from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemUpdate
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import (
    _make_item,
    _make_member,
    _make_project,
)


def test_identity_does_not_add_database_columns_or_tables():
    assert "reporter_user_id" not in LoopItem.__table__.columns
    assert "issue_followers" not in Base.metadata.tables


def test_legacy_issue_defaults_reporter_without_rewriting_metadata(test_db, test_user):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    original = dict(item.metadata_json or {})
    assert item.reporter_user_id == test_user.id
    test_db.expire_all()
    restored = test_db.get(LoopItem, item.id)
    assert restored.reporter_user_id == test_user.id
    assert restored.metadata_json == original


@pytest.mark.parametrize("following", [True, False])
def test_stale_content_write_preserves_current_subscriptions(
    test_db, test_user, following
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {
        "follower_user_ids": [] if following else [test_user.id],
        "follower_since": {},
    }
    test_db.commit()
    original = dict(item.metadata_json)
    current = {
        **original,
        "follower_user_ids": [test_user.id] if following else [],
        "follower_since": {str(test_user.id): 123} if following else {},
    }
    # Reproduce another writer committing after this session loaded the Issue.
    test_db.connection().execute(
        update(LoopItem.__table__)
        .where(LoopItem.id == item.id)
        .values(metadata=current)
    )
    item.metadata_json = {**original, "tags": ["edited"]}
    test_db.commit()
    test_db.refresh(item)
    assert item.metadata_json == {**current, "tags": ["edited"]}


def test_reporter_and_tags_persist_together_without_changing_creator_or_follows(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    reporter = _make_member(test_db, project, "new-reporter", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {
        **(item.metadata_json or {}),
        "follower_user_ids": [test_user.id],
    }
    test_db.commit()
    saved = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=item.version, reporter_user_id=reporter.id, tags=["updated"]
        ),
    )
    test_db.expire_all()
    saved = test_db.get(LoopItem, saved.id)
    assert saved.created_by_user_id == test_user.id
    assert saved.reporter_user_id == reporter.id
    assert saved.metadata_json["reporter_user_id"] == reporter.id
    assert saved.tags == ["updated"]
    assert saved.follower_user_ids == [test_user.id]


def test_external_issue_projection_uses_metadata_and_is_scoped_to_reader(
    test_db, test_user
):
    from app.services.loop_items.external_provider import external_loop_item_provider

    project = _make_project(test_db, test_user)
    reporter = _make_member(test_db, project, "external-reporter", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {
        "reporter_user_id": reporter.id,
        "follower_user_ids": [test_user.id],
    }
    test_db.commit()
    response = {
        "id": item.id,
        "can_view_detail": True,
        "created_by_user_id": test_user.id,
    }
    mine = external_loop_item_provider._attach_badges(
        test_db, [dict(response)], test_user.id
    )[0]
    other = external_loop_item_provider._attach_badges(
        test_db, [dict(response)], reporter.id
    )[0]
    assert mine["reporter_user_id"] == other["reporter_user_id"] == reporter.id
    assert (
        mine["reporter_user_name"] == other["reporter_user_name"] == reporter.user_name
    )
    assert mine["is_following"] is True
    assert other["is_following"] is False


def test_content_metadata_replacement_preserves_identity_and_nested_edits(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {
        "ai_state": {"status": "running"},
        "reporter_user_id": test_user.id,
        "follower_user_ids": [test_user.id],
        "follower_since": {str(test_user.id): 123},
    }
    test_db.commit()
    metadata = dict(item.metadata_json)
    metadata["ai_state"]["status"] = "completed"
    metadata.pop("reporter_user_id")
    metadata.pop("follower_user_ids")
    metadata.pop("follower_since")
    item.metadata_json = metadata
    test_db.commit()
    test_db.refresh(item)
    assert item.metadata_json["ai_state"]["status"] == "completed"
    assert item.reporter_user_id == test_user.id
    assert item.follower_user_ids == [test_user.id]
    assert item.metadata_json["follower_since"] == {str(test_user.id): 123}
