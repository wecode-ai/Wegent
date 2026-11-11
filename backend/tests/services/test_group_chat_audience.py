"""Current group grants, not historical socket subscriptions, select recipients."""

from contextlib import contextmanager
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.ws.wework_runtime_namespace import wework_runtime_user_room
from app.db.base import Base
from app.models.delivery import CloudProject, LoopItemComment
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.services.project_chat import audience, push
from tests.services.test_thread_participation import make_group, make_thread, person


def test_group_publication_excludes_removed_members_and_inactive_accounts(
    test_db, test_user
):
    observer = person(test_db, "observer")
    inactive = person(test_db, "inactive")
    group = make_group(
        test_db, test_user, [(observer, "Viewer"), (inactive, "Developer")]
    )
    thread = make_thread(test_db, group, test_user)
    inactive.is_active = False
    test_db.flush()
    assert audience.subscription_room(test_db, group.id, thread.id, observer.id) is None
    assert audience.publication_rooms(test_db, group.id, thread.id) == [
        wework_runtime_user_room(test_user.id),
        wework_runtime_user_room(observer.id),
    ]
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_id=str(observer.id),
    ).delete()
    test_db.flush()
    assert audience.publication_rooms(test_db, group.id, thread.id) == [
        wework_runtime_user_room(test_user.id),
    ]
    with pytest.raises(HTTPException) as denied:
        audience.subscription_room(test_db, group.id, thread.id, observer.id)
    assert denied.value.status_code == 404


def test_group_publication_rejects_foreign_and_deleted_threads(test_db, test_user):
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    group.project_key = "FIRST"
    test_db.flush()
    other = make_group(test_db, test_user, [])
    assert audience.publication_rooms(test_db, other.id, thread.id) == []
    thread.deleted_at = datetime(2026, 11, 11)
    test_db.flush()
    assert audience.publication_rooms(test_db, group.id, thread.id) == []
    assert audience.publication_rooms(test_db, group.id, None) == [
        wework_runtime_user_room(test_user.id),
    ]


def test_group_publication_rejects_non_thread_nodes(test_db, test_user):
    group = make_group(test_db, test_user, [])
    comment = LoopItemComment(
        cloud_project_id=group.id,
        description="Not a Thread",
        created_by_user_id=test_user.id,
    )
    test_db.add(comment)
    test_db.flush()
    assert audience.publication_rooms(test_db, group.id, comment.id) == []


def test_group_push_routes_exclude_a_revoked_subscription(
    test_db, test_user, monkeypatch
):
    observer = person(test_db, "observer")
    group = make_group(test_db, test_user, [(observer, "Developer")])
    thread = make_thread(test_db, group, test_user)
    manager = MagicMock()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr(audience, "get_db_session", session)
    message = {"projectId": group.id, "taskId": thread.id, "messageId": "message"}
    push.push_project_chat_message(message)
    assert [call.kwargs["room"] for call in manager.emit.call_args_list] == [
        wework_runtime_user_room(test_user.id),
        wework_runtime_user_room(observer.id),
    ]
    manager.reset_mock()
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_id=str(observer.id),
    ).delete()
    test_db.flush()
    push.push_project_chat_message(message)
    assert [call.kwargs["room"] for call in manager.emit.call_args_list] == [
        wework_runtime_user_room(test_user.id),
    ]


def test_legacy_project_rooms_keep_the_existing_transport_scope(test_db, test_user):
    from app.api.ws.wework_runtime_namespace import project_chat_room

    project = CloudProject(name="Legacy", created_by_user_id=test_user.id)
    test_db.add(project)
    test_db.flush()
    assert audience.publication_rooms(test_db, project.id, "external-issue") == [
        project_chat_room(project.id, "external-issue"),
    ]


@pytest.mark.asyncio
async def test_async_message_emission_rechecks_group_roster(
    test_db, test_user, monkeypatch
):
    from app.api.ws import wework_runtime_namespace as runtime

    observer = person(test_db, "observer")
    group = make_group(test_db, test_user, [(observer, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    namespace = MagicMock()
    namespace.emit = AsyncMock()

    @contextmanager
    def session():
        yield test_db

    async def run(callback, *args):
        return callback(*args)

    monkeypatch.setattr(audience, "get_db_session", session)
    monkeypatch.setattr(runtime, "run_sync_in_executor", run)
    message = {"projectId": group.id, "taskId": thread.id, "messageId": "message"}
    await runtime.emit_project_chat_message(namespace, message)
    assert [call.kwargs["room"] for call in namespace.emit.await_args_list] == [
        wework_runtime_user_room(test_user.id),
        wework_runtime_user_room(observer.id),
    ]
    namespace.emit.reset_mock()
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_id=str(observer.id),
    ).delete()
    test_db.flush()
    await runtime.emit_project_chat_message(namespace, message)
    assert [call.kwargs["room"] for call in namespace.emit.await_args_list] == [
        wework_runtime_user_room(test_user.id),
    ]


def test_failed_audience_lookup_never_falls_back_to_public_room(monkeypatch, caplog):
    manager = MagicMock()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)

    def unavailable(_message):
        raise RuntimeError("Audience database unavailable")

    monkeypatch.setattr(push, "publication_rooms_for_message", unavailable)
    push.push_project_chat_message({"projectId": "1", "messageId": "message"})
    manager.emit.assert_not_called()
    assert "Audience database unavailable" in caplog.text


def test_fresh_publication_session_observes_committed_revocation(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'audience.sqlite'}")
    Base.metadata.create_all(engine)
    sessions = []

    @contextmanager
    def session():
        with Session(engine) as db:
            sessions.append(db)
            yield db

    monkeypatch.setattr(audience, "get_db_session", session)
    try:
        with Session(engine) as writer:
            owner = person(writer, "owner")
            observer = person(writer, "observer")
            group = make_group(writer, owner, [(observer, "Viewer")])
            thread = make_thread(writer, group, owner)
            group_id, thread_id = str(group.id), str(thread.id)
            owner_id, observer_id = owner.id, observer.id
            writer.commit()
        message = {"projectId": group_id, "taskId": thread_id}
        assert audience.publication_rooms_for_message(message) == [
            wework_runtime_user_room(owner_id),
            wework_runtime_user_room(observer_id),
        ]
        with Session(engine) as revoker:
            revoker.query(ResourceMember).filter_by(
                resource_type="CollaborationChatGroup",
                resource_id=int(group_id),
                entity_id=str(observer_id),
            ).delete()
            revoker.commit()
        assert audience.publication_rooms_for_message(message) == [
            wework_runtime_user_room(owner_id),
        ]
        assert len(sessions) == 2
        assert sessions[0] is not sessions[1]
    finally:
        engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["delta", "snapshot"])
async def test_runtime_projection_routes_next_packet_after_revocation(
    test_db, test_user, monkeypatch, mode
):
    from app.api.ws import device_namespace
    from app.api.ws.wework_runtime_namespace import (
        PROJECT_CHAT_AGENT_CHUNK_EVENT,
        PROJECT_CHAT_CREATED_EVENT,
    )

    observer = person(test_db, "observer")
    group = make_group(test_db, test_user, [(observer, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    activity = ProjectChatMessage(
        message_id="runtime-audience",
        project_id=group.id,
        task_id=thread.id,
        sender_type="agent",
        sender_id="agent",
        sender_name="Agent",
        message_type="text",
        status="streaming",
        content="",
        runtime_device_id="local-device",
        runtime_task_id="runtime-task",
    )
    test_db.add(activity)
    test_db.commit()
    namespace = device_namespace.DeviceNamespace()
    sio = AsyncMock()

    @contextmanager
    def session():
        yield test_db

    async def run(callback, *args):
        return callback(*args)

    monkeypatch.setattr(device_namespace, "get_db_session", session)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", run)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        "app.services.wework_api.events.publish_runtime_event", AsyncMock()
    )
    monkeypatch.setattr(
        namespace._local_task_responses,
        "forward_runtime_event_to_channels",
        AsyncMock(),
    )
    monkeypatch.setattr(namespace, "_notify_runtime_event", AsyncMock())
    event = (
        "response.output_text.delta" if mode == "delta" else "response.output_text.done"
    )
    expected_event = (
        PROJECT_CHAT_AGENT_CHUNK_EVENT
        if mode == "delta"
        else PROJECT_CHAT_CREATED_EVENT
    )

    async def forward(sequence, content):
        data = {"delta": content} if mode == "delta" else {"text": content}
        result = await namespace._forward_runtime_event(
            user_id=test_user.id,
            device_id="local-device",
            logical_device_id="local-device",
            data={
                "event": event,
                "payload": {
                    "taskId": "runtime-task",
                    "eventSeq": sequence,
                    "data": data,
                },
            },
        )
        assert result == {"success": True}
        return [
            call.kwargs["room"]
            for call in sio.emit.await_args_list
            if call.args[0] == expected_event
        ]

    assert await forward(1, "first") == [
        wework_runtime_user_room(test_user.id),
        wework_runtime_user_room(observer.id),
    ]
    sio.emit.reset_mock()
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_id=str(observer.id),
    ).delete()
    test_db.commit()
    assert await forward(2, "second") == [
        wework_runtime_user_room(test_user.id),
    ]
    test_db.refresh(activity)
    assert activity.content == ("firstsecond" if mode == "delta" else "second")
