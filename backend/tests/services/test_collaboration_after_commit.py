"""Public group comments publish from committed state after releasing the writer."""

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification
from app.services.loop_items.service import loop_item_service
from tests.services.test_thread_participation import make_group, make_thread, person


@pytest.fixture
def committed_scope(tmp_path, monkeypatch):
    # One connection proves publishers do not query while the writer holds it.
    engine = create_engine(
        f"sqlite:///{tmp_path / 'committed.sqlite'}",
        pool_size=1,
        max_overflow=0,
        pool_timeout=1,
    )
    Base.metadata.create_all(engine)
    pushed, changed, scheduled = MagicMock(), MagicMock(), MagicMock()
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", pushed
    )
    monkeypatch.setattr(
        "app.services.loop_item_events.publish_loop_item_changed", changed
    )
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", scheduled)

    @contextmanager
    def fresh():
        with Session(engine) as current:
            yield current

    monkeypatch.setattr("app.db.session.get_db_session", fresh)
    with Session(engine, expire_on_commit=False) as writer:
        owner, reader = person(writer, "owner"), person(writer, "reader")
        group = make_group(writer, owner, [(reader, "Developer")])
        thread = make_thread(writer, group, owner, reader)
        writer.commit()
        yield writer, owner.id, thread.id, pushed, changed, scheduled
    engine.dispose()


@pytest.mark.parametrize(
    "outcome", ["commit", "rollback", "close", "savepoint_commit", "savepoint_rollback"]
)
def test_comment_publication_follows_final_transaction(committed_scope, outcome):
    writer, actor, thread_id, pushed, changed, scheduled = committed_scope
    nested = writer.begin_nested() if outcome.startswith("savepoint") else None
    loop_item_service.add_comment(
        writer, thread_id, actor, "Atomic discussion", commit=False
    )
    pushed.assert_not_called()
    changed.assert_not_called()
    scheduled.assert_not_called()
    if nested:
        nested.commit() if outcome == "savepoint_commit" else nested.rollback()
        pushed.assert_not_called()
        changed.assert_not_called()
        scheduled.assert_not_called()
    if outcome == "close":
        writer.close()
        writer.commit()
    else:
        writer.rollback() if outcome == "rollback" else writer.commit()
    expected = int(outcome in {"commit", "savepoint_commit"})
    assert writer.query(ProjectChatMessage).count() == expected
    assert writer.query(WeworkNotification).count() == expected
    assert pushed.call_count == changed.call_count == scheduled.call_count == expected


def test_failed_inner_comment_preserves_outer_notification(committed_scope):
    writer, actor, thread_id, pushed, changed, scheduled = committed_scope
    outer = loop_item_service.add_comment(
        writer, thread_id, actor, "Keep outer", commit=False
    )
    nested = writer.begin_nested()
    loop_item_service.add_comment(
        writer, thread_id, actor, "Discard inner", commit=False
    )
    nested.rollback()
    writer.commit()
    assert [row.content for row in writer.query(ProjectChatMessage)] == ["Keep outer"]
    assert [row.body for row in writer.query(WeworkNotification)] == ["Keep outer"]
    pushed.assert_called_once()
    assert pushed.call_args.args[0]["messageId"] == outer["id"]
    changed.assert_called_once()
    scheduled.assert_called_once()
