"""Group links resolve exact readable message scope without joining the reader."""

from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import MetaData, create_engine, update
from sqlalchemy.orm import Session

from app.api.ws import wework_runtime_namespace as runtime
from app.db.base import Base
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import ProjectChatSubscribe
from app.schemas.wework_navigation import validate_wework_url
from app.services.project_chat.service import project_chat_service
from app.services.thread_participation import is_participant
from app.services.wework_notifications import group_thread_url
from tests.services.test_thread_participation import make_group, make_thread, person


@pytest.mark.asyncio
async def test_old_message_link_loads_history_and_preserves_observer_membership(
    test_db, test_user, monkeypatch
):
    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    test_db.add_all(
        ProjectChatMessage(
            message_id=f"m{index}",
            project_id=group.id,
            task_id=thread.id,
            sender_type="user",
            sender_id=str(test_user.id),
            sender_name="Owner",
            content=f"Message {index}",
            metadata_json={},
        )
        for index in range(202)
    )
    test_db.flush()
    ordinary = project_chat_service.subscribe(
        test_db,
        user_id=reader.id,
        request=ProjectChatSubscribe(project_id=group.id, task_id=thread.id),
    )
    assert "m0" not in {row.message_id for row in ordinary}
    namespace = runtime.WeworkRuntimeNamespace()
    monkeypatch.setattr(
        namespace, "get_session", AsyncMock(return_value={"user_id": reader.id})
    )
    entered = AsyncMock()
    monkeypatch.setattr(namespace, "enter_room", entered)

    @contextmanager
    def session():
        yield test_db

    async def run(callback, *args):
        return callback(*args)

    monkeypatch.setattr(runtime, "get_db_session", session)
    monkeypatch.setattr(runtime, "run_sync_in_executor", run)
    result = await namespace.on_project_chat_subscribe(
        "reader",
        {
            "projectId": group.id,
            "taskId": thread.id,
            "focusMessageId": "m0",
        },
    )
    assert result["ok"] is True
    messages = result["result"]["messages"]
    assert [row["messageId"] for row in messages] == ["m0"]
    assert result["result"]["history"]["hasNewer"] is True
    pages = list(messages)
    cursor = result["result"]["latestSequence"]
    for _ in range(2):
        page = await namespace.on_project_chat_subscribe(
            "reader",
            {
                "projectId": group.id,
                "taskId": thread.id,
                "afterSequence": cursor,
                "historyWindow": True,
            },
        )
        assert page["ok"] is True
        assert len(page["result"]["messages"]) <= 200
        pages.extend(page["result"]["messages"])
        cursor = page["result"]["latestSequence"]
    assert [row["messageId"] for row in pages] == [f"m{index}" for index in range(202)]
    assert page["result"]["history"]["hasNewer"] is False
    assert is_participant(test_db, thread.id, reader.id) is False
    entered.assert_not_awaited()


def test_message_anchor_cannot_cross_conversation_scope(test_db, test_user):
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    test_db.add(
        ProjectChatMessage(
            message_id="foreign",
            project_id=group.id,
            task_id="another-thread",
            content="Do not disclose",
        )
    )
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        project_chat_service.subscribe(
            test_db,
            user_id=test_user.id,
            request=ProjectChatSubscribe(
                project_id=group.id, task_id=thread.id, focus_message_id="foreign"
            ),
        )
    assert denied.value.status_code == 404
    assert "Do not disclose" not in str(denied.value.detail)


def test_root_history_pagination_includes_legacy_null_and_empty_task_ids(
    tmp_path, monkeypatch
):
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(metadata)
    metadata.tables[ProjectChatMessage.__tablename__].c.task_id.nullable = True
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-chat.sqlite'}")
    metadata.create_all(engine)
    try:
        with Session(engine) as db:
            owner = person(db, "owner")
            group = make_group(db, owner, [])
            db.add_all(
                ProjectChatMessage(
                    message_id=f"root-{index}",
                    project_id=group.id,
                    task_id="" if index < 3 else "child",
                    sender_type="user",
                    sender_id=str(owner.id),
                    content=f"Root {index}",
                )
                for index in range(4)
            )
            db.flush()
            db.execute(
                update(ProjectChatMessage)
                .where(ProjectChatMessage.message_id.in_(["root-0", "root-2"]))
                .values(task_id=None)
            )
            db.expire_all()

            @contextmanager
            def session():
                yield db

            monkeypatch.setattr(runtime, "get_db_session", session)
            window = runtime._subscribe_project_chat_sync(
                owner.id,
                ProjectChatSubscribe(
                    project_id=group.id,
                    focus_message_id="root-1",
                    history_window=True,
                    limit=1,
                ),
            )
            assert [row["messageId"] for row in window["messages"]] == ["root-1"]
            assert window["history"]["hasOlder"] is True
            assert window["history"]["hasNewer"] is True
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "thread,comment",
    [(None, None), (None, "message"), ("GROUP-1", None), ("GROUP-1", "message:1/#")],
)
def test_group_notification_destinations_are_valid(thread, comment):
    url = group_thread_url("12", thread, comment)
    assert validate_wework_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "wework://groups/backend/0",
        "wework://groups/12",
        "wework://groups/backend/12/tasks/G-1",
        "wework://groups/backend/12/threads/G-1/comments/%00",
        "wework://groups/backend/12?join=true",
    ],
)
def test_invalid_group_links_grant_no_implicit_navigation(url):
    with pytest.raises(ValueError):
        validate_wework_url(url)
