"""Group visibility, explicit participation and legacy isolation contracts."""

from datetime import datetime
from io import BytesIO
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    Delivery,
    DeliveryAsset,
    LoopItem,
    LoopItemComment,
    ProjectMilestone,
    ThreadParticipant,
    ThreadProjectLink,
)
from app.models.kind import Kind
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatSend, ProjectChatSubscribe
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.project_chat.service import project_chat_service
from app.services.thread_lifecycle import record_thread_lifecycle
from app.services.thread_participation import (
    initialize_historical_participants,
    initialize_thread_participants,
    is_participant,
    join_thread,
    participant_id,
)


def test_thread_states_are_shared_and_tags_remain_free(
    test_db: Session, test_user: User
):
    from app.schemas.delivery import LoopItemUpdate
    from app.services.loop_item_status_history import (
        project_board_config,
        project_board_statuses,
    )
    from app.services.loop_items.service import loop_item_service

    group = make_group(test_db, test_user, [])
    group.metadata_json = {
        "board_config": {"statuses": [{"id": "custom", "name": "Custom"}]}
    }
    thread = make_thread(test_db, group, test_user)
    test_db.flush()
    assert [key for key, _ in project_board_statuses(group)] == [
        "inbox",
        "pending",
        "in_progress",
        "in_review",
        "completed",
    ]
    assert project_board_config(group).processing_start_status_id == "pending"
    for invalid in ("", "custom"):
        version = thread.version
        with pytest.raises(HTTPException) as rejected:
            loop_item_service.update(
                test_db,
                thread.id,
                test_user.id,
                LoopItemUpdate(version=version, status=invalid),
            )
        assert rejected.value.status_code == 422
        assert thread.version == version
    loop_item_service.update(
        test_db,
        thread.id,
        test_user.id,
        LoopItemUpdate(version=thread.version, status="in_review", tags=["任意新标签"]),
    )
    test_db.refresh(thread)
    assert thread.status == "in_review"
    assert thread.metadata_json["tags"] == ["任意新标签"]


def person(db: Session, name: str) -> User:
    user = User(
        user_name=name,
        email=f"{name}@example.com",
        password_hash="unused",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


@pytest.mark.parametrize(
    "fields",
    [
        {"title": "Changed"},
        {"status": "completed"},
        {"assignee_user_id": None},
        {"title": "Changed", "status": "completed", "assignee_user_id": None},
    ],
)
def test_archived_group_rejects_thread_updates_without_side_effects(
    test_db, test_user, fields
):
    from app.models.loop_item_execution import LoopItemExecution
    from app.schemas.delivery import LoopItemUpdate
    from app.services.loop_items.service import loop_item_service

    developer = person(test_db, "developer")
    group = make_group(test_db, test_user, [(developer, "Developer")])
    thread = make_thread(test_db, group, test_user, developer)
    group.status = "archived"
    test_db.flush()
    version, assignee = thread.version, thread.assignee_user_id
    event_count = test_db.query(ProjectChatMessage).count()
    execution_count = test_db.query(LoopItemExecution).count()
    with pytest.raises(HTTPException) as denied:
        loop_item_service.update(
            test_db, thread.id, developer.id, LoopItemUpdate(version=version, **fields)
        )
    assert denied.value.status_code == 409
    test_db.refresh(thread)
    assert thread.version == version
    assert thread.title == "Thread"
    assert thread.status == "pending"
    assert thread.assignee_user_id == assignee
    assert test_db.query(ProjectChatMessage).count() == event_count
    assert test_db.query(LoopItemExecution).count() == execution_count
    values = loop_item_service.response_values(test_db, thread, developer.id)
    assert values["can_edit"] is False
    assert values["permissions"] == {
        "edit_content": False,
        "assign": False,
        "comment": False,
        "execute": False,
    }


def test_completed_thread_allows_discussion_but_requires_reopening_for_execution(
    test_db, test_user
):
    from app.models.delivery import LoopItemTaskBinding
    from app.schemas.delivery import LoopItemTaskBind
    from app.services.loop_items.service import loop_item_service

    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    thread.status = "completed"
    test_db.flush()
    values = loop_item_service.response_values(test_db, thread, test_user.id)
    assert values["permissions"]["comment"] is True
    assert values["permissions"]["execute"] is False
    with pytest.raises(HTTPException) as denied:
        loop_item_service.bind_task(
            test_db,
            thread.id,
            LoopItemTaskBind(device_id="device", task_id="task"),
            test_user.id,
        )
    assert denied.value.status_code == 409
    assert test_db.query(LoopItemTaskBinding).count() == 0
    result = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id="after-completion",
            project_id=group.id,
            task_id=thread.id,
            content="Additional discussion",
        ),
    )
    assert result.created is True


@pytest.mark.parametrize("thread_status", ["completed", "cancelled", "archived"])
def test_terminal_group_thread_rejects_agent_activity_before_creating_state(
    test_db, test_user, thread_status
):
    from app.schemas.project_chat import ProjectChatAgentStart

    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    thread.status = thread_status
    test_db.flush()
    before = test_db.query(ProjectChatMessage).count()
    with pytest.raises(HTTPException) as denied:
        project_chat_service.start_agent_response(
            test_db,
            user_id=test_user.id,
            request=ProjectChatAgentStart(
                project_id=str(group.id),
                task_id=str(thread.id),
                agent_id="not-resolved-before-permission",
                runtime_device_id="private-device",
                runtime_task_id="private-task",
            ),
        )
    assert denied.value.status_code == 409
    assert test_db.query(ProjectChatMessage).count() == before


@pytest.mark.parametrize("inactive_member", [False, True])
@pytest.mark.parametrize("existing_thread", [False, True])
def test_unauthorized_sender_cannot_distinguish_thread_existence(
    test_db, test_user, inactive_member, existing_thread
):
    actor = person(test_db, "unauthorized-sender")
    group = make_group(
        test_db, test_user, [(actor, "Developer")] if inactive_member else []
    )
    thread = make_thread(test_db, group, test_user)
    actor.is_active = not inactive_member
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        project_chat_service.send(
            test_db,
            user_id=actor.id,
            user_name=actor.user_name,
            request=ProjectChatSend(
                project_id=group.id,
                task_id=thread.id if existing_thread else "unknown-thread",
                client_message_id="cannot-probe-thread",
                content="Probe",
            ),
        )
    assert denied.value.status_code == 404
    assert denied.value.detail == "Chat group not found"


@pytest.mark.asyncio
async def test_completed_group_thread_rejects_comment_execution_before_trigger_lookup(
    test_db, test_user
):
    from app.schemas.project_chat import ProjectChatCommentExecution
    from app.services.project_chat.comment_execution import execute_comment

    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    thread.status = "completed"
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        await execute_comment(
            test_db,
            user_id=test_user.id,
            request=ProjectChatCommentExecution(
                project_id=str(group.id),
                task_id=str(thread.id),
                trigger_message_id="not-resolved-before-permission",
            ),
        )
    assert denied.value.status_code == 409


@pytest.mark.parametrize(
    "role,participation,archived",
    [
        ("Viewer", "active", False),
        ("Developer", "never", False),
        ("Developer", "left", False),
        ("Developer", "active", True),
        ("Developer", "active", False),
    ],
)
def test_group_draft_asset_upload_requires_current_write_and_participation(
    test_db, test_user, role, participation, archived
):
    from app.services.delivery.service import DeliveryService

    actor = person(test_db, "contributor")
    group = make_group(test_db, test_user, [(actor, role)])
    thread = make_thread(test_db, group, test_user)
    if participation != "never":
        join_thread(test_db, thread, actor.id)
        test_db.flush()
        row = test_db.get(ThreadParticipant, participant_id(thread.id, actor.id))
        row.status = participation
    if archived:
        group.status = "archived"
    delivery = Delivery(
        id="draft",
        cloud_project_id=group.id,
        loop_item_id=thread.id,
        status="draft",
        created_by_user_id=test_user.id,
        markdown_object_key="draft.md",
    )
    test_db.add(delivery)
    test_db.flush()
    storage = MagicMock()
    service = DeliveryService(storage=storage)

    def upload():
        return service.add_asset(
            test_db,
            delivery.id,
            actor.id,
            "notes.txt",
            "notes.txt",
            "text/plain",
            BytesIO(b"Shared notes"),
        )

    if role == "Developer" and participation == "active" and not archived:
        asset = upload()
        assert asset.size_bytes == len(b"Shared notes")
        storage.put_stream.assert_called_once()
        assert test_db.query(DeliveryAsset).count() == 1
    else:
        with pytest.raises(HTTPException) as denied:
            upload()
        assert denied.value.status_code == (409 if archived else 403)
        storage.put_stream.assert_not_called()
        assert test_db.query(DeliveryAsset).count() == 0


def make_group(
    db: Session, owner: User, members: list[tuple[User, str]]
) -> CollaborationChatGroup:
    group = CollaborationChatGroup(
        name="Independent group",
        project_key="GROUP",
        description="",
        created_by_user_id=owner.id,
        metadata_json={"task_provider": "local"},
    )
    db.add(group)
    db.flush()
    for user, role in [(owner, "Owner"), *members]:
        db.add(
            ResourceMember(
                resource_type=GROUP_RESOURCE_TYPE,
                resource_id=int(group.id),
                entity_type="user",
                entity_id=str(user.id),
                user_id=user.id,
                role=role,
                status="approved",
            )
        )
    db.flush()
    return group


def make_thread(
    db: Session,
    group: CollaborationChatGroup,
    owner: User,
    assignee: User | None = None,
) -> LoopItem:
    row = LoopItem(
        id="GROUP-1",
        cloud_project_id=group.id,
        title="Thread",
        status="pending",
        created_by_user_id=owner.id,
        assignee_user_id=assignee.id if assignee else None,
        version=1,
    )
    db.add(row)
    db.flush()
    initialize_thread_participants(db, row)
    db.flush()
    return row


def test_group_is_not_a_project_or_project_authority(
    test_db: Session, test_user: User
) -> None:
    group = make_group(test_db, test_user, [])
    assert group.resource_type == "chat_group"
    assert not isinstance(group, CloudProject)
    assert (
        test_db.query(CloudProject).filter(CloudProject.id == group.id).first() is None
    )
    assert (
        require_collaboration_container_access(test_db, group.id, test_user.id).role
        == BaseRole.Owner
    )
    with pytest.raises(HTTPException) as denied:
        require_cloud_project_role(test_db, group.id, test_user.id)
    assert denied.value.status_code == 404


def test_only_creator_and_current_assignee_participate(
    test_db: Session, test_user: User
) -> None:
    assignee, observer = person(test_db, "assignee"), person(test_db, "observer")
    group = make_group(
        test_db, test_user, [(assignee, "Developer"), (observer, "Developer")]
    )
    thread = make_thread(test_db, group, test_user, assignee)
    assert is_participant(test_db, thread.id, test_user.id)
    assert is_participant(test_db, thread.id, assignee.id)
    assert not is_participant(test_db, thread.id, observer.id)
    assert (
        project_chat_service.subscribe(
            test_db,
            user_id=observer.id,
            request=ProjectChatSubscribe(project_id=group.id, task_id=thread.id),
        )
        == []
    )
    with pytest.raises(HTTPException) as denied:
        project_chat_service.send(
            test_db,
            user_id=observer.id,
            user_name=observer.user_name,
            request=ProjectChatSend(
                client_message_id="message",
                project_id=group.id,
                task_id=thread.id,
                content="hello",
            ),
        )
    assert denied.value.status_code == 403
    join_thread(test_db, thread, observer.id)
    test_db.flush()
    join_thread(test_db, thread, observer.id)
    test_db.flush()
    assert test_db.query(ThreadParticipant).filter_by(parent_id=thread.id).count() == 3
    project_chat_service._require_scope(
        test_db,
        user_id=observer.id,
        project_id=group.id,
        task_id=thread.id,
        required_role=BaseRole.Developer,
    )


def test_archived_group_cannot_send_even_for_a_joined_owner(
    test_db: Session, test_user: User
) -> None:
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    group.status = "archived"
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        project_chat_service._require_scope(
            test_db,
            user_id=test_user.id,
            project_id=group.id,
            task_id=thread.id,
            required_role=BaseRole.Developer,
        )
    assert denied.value.status_code == 409
    project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(project_id=group.id, task_id=thread.id),
    )


def test_read_only_participation_does_not_grant_sending(
    test_db: Session, test_user: User
) -> None:
    viewer = person(test_db, "viewer")
    group = make_group(test_db, test_user, [(viewer, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    join_thread(test_db, thread, viewer.id)
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        project_chat_service._require_scope(
            test_db,
            user_id=viewer.id,
            project_id=group.id,
            task_id=thread.id,
            required_role=BaseRole.Developer,
        )
    assert denied.value.status_code == 403


@pytest.mark.parametrize("thread_scope", [False, True])
def test_group_execute_requires_capability_even_with_a_viewer_read_scope(
    test_db: Session, test_user: User, thread_scope: bool
) -> None:
    viewer = person(test_db, "execution-viewer")
    group = make_group(test_db, test_user, [(viewer, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    join_thread(test_db, thread, viewer.id)
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        project_chat_service._require_scope(
            test_db,
            user_id=viewer.id,
            project_id=group.id,
            task_id=thread.id if thread_scope else None,
            required_role=BaseRole.Viewer,
            execute=True,
        )
    assert denied.value.status_code == 403


def test_group_lifecycle_is_one_fact_without_thread_chat(
    test_db: Session, test_user: User
) -> None:
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    thread.status = "completed"
    thread.version = 2
    test_db.flush()
    record_thread_lifecycle(test_db, thread, test_user.id, "status_changed")
    test_db.flush()
    record_thread_lifecycle(test_db, thread, test_user.id, "status_changed")
    test_db.flush()
    messages = test_db.query(ProjectChatMessage).filter_by(project_id=group.id).all()
    assert len(messages) == 1
    assert not messages[0].task_id
    assert messages[0].message_type == "thread_lifecycle"
    assert messages[0].metadata_json["thread_id"] == thread.id


def test_participant_identity_is_stable_and_scoped() -> None:
    assert participant_id("thread", 7) == participant_id("thread", 7)
    assert participant_id("thread", 7) != participant_id("thread", 8)
    assert participant_id("thread", 7) != participant_id("other", 7)


@pytest.mark.parametrize(
    ("kind", "overrides", "expected"),
    [
        ("comment", {}, True),
        ("comment", {"description": "   "}, False),
        ("comment", {"metadata_json": {"event_type": "assignment"}}, False),
        ("comment", {"metadata_json": {"event_type": "unknown"}}, False),
        ("comment", {"metadata_json": {"event_type": False}}, False),
        ("comment", {"deleted_at": datetime(2026, 1, 1)}, False),
        ("comment", {"cloud_project_id": "wrong"}, False),
        ("chat", {}, True),
        ("chat", {"metadata_json": {"stand_in_reply_to": "bot"}}, True),
        ("chat", {"sender_type": "agent"}, False),
        ("chat", {"sender_type": "system"}, False),
        ("chat", {"message_type": "agent_status"}, False),
        ("chat", {"task_id": ""}, False),
        ("chat", {"project_id": "wrong"}, False),
        ("chat", {"sender_id": "１２３"}, False),
        ("chat", {"sender_id": "stand-in:7"}, False),
        ("chat", {"sender_id": "9" * 128}, False),
        ("chat", {"content": "   "}, False),
        ("chat", {"deleted_at": datetime(2026, 1, 1)}, False),
    ],
)
def test_historical_participation_uses_discussion_facts(
    test_db: Session, test_user: User, kind: str, overrides: dict, expected: bool
) -> None:
    author = person(test_db, "historical-author")
    group = make_group(test_db, test_user, [(author, "Developer")])
    thread = make_thread(test_db, group, test_user)
    if kind == "comment":
        values = dict(
            loop_item_id=thread.id,
            cloud_project_id=group.id,
            created_by_user_id=author.id,
            description="Discussion",
            metadata_json={},
        )
        values.update(overrides)
        test_db.add(LoopItemComment(**values))
    else:
        values = dict(
            message_id="historical",
            project_id=group.id,
            task_id=thread.id,
            sender_type="user",
            sender_id=str(author.id),
            message_type="text",
            content="Discussion",
            metadata_json={},
        )
        values.update(overrides)
        test_db.add(ProjectChatMessage(**values))
    test_db.flush()
    initialized = initialize_historical_participants(
        test_db, thread, source_container_id=group.id
    )
    assert (author.id in initialized) is expected
    assert is_participant(test_db, thread.id, author.id) is expected


@pytest.mark.parametrize(
    "identity", ["canonical", "leading-zero", "0", "+7", " 7", "2147483648"]
)
def test_historical_participation_requires_an_exact_persisted_author(
    test_db: Session, test_user: User, identity: str
) -> None:
    author = person(test_db, "exact-author")
    group = make_group(test_db, test_user, [(author, "Developer")])
    thread = make_thread(test_db, group, test_user)
    sender_id = (
        str(author.id)
        if identity == "canonical"
        else (f"00{author.id}" if identity == "leading-zero" else identity)
    )
    test_db.add(
        ProjectChatMessage(
            message_id="exact-author-message",
            project_id=group.id,
            task_id=thread.id,
            sender_type="user",
            sender_id=sender_id,
            message_type="text",
            content="Discussion",
        )
    )
    test_db.flush()
    initialized = initialize_historical_participants(
        test_db, thread, source_container_id=group.id
    )
    assert (author.id in initialized) is (identity == "canonical")
    assert is_participant(test_db, thread.id, author.id) is (identity == "canonical")


def test_historical_participation_preserves_choices_and_current_group_boundary(
    test_db: Session, test_user: User
) -> None:
    member, reader = person(test_db, "member"), person(test_db, "reader")
    removed, inactive = person(test_db, "removed"), person(test_db, "inactive")
    group = make_group(
        test_db,
        test_user,
        [(member, "Viewer"), (reader, "Developer"), (inactive, "Developer")],
    )
    thread = make_thread(test_db, group, test_user, member)
    inactive.is_active = False
    for user in (member, removed, inactive):
        test_db.add(
            LoopItemComment(
                loop_item_id=thread.id,
                cloud_project_id=group.id,
                created_by_user_id=user.id,
                description="Historical discussion",
            )
        )
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, member.id))
    participant.status = "left"
    participant.metadata_json = {"notifications": "muted"}
    thread.status = "completed"
    test_db.flush()
    assert (
        initialize_historical_participants(
            test_db, thread, source_container_id=group.id
        )
        == []
    )
    assert participant.status == "left"
    assert participant.metadata_json == {"notifications": "muted"}
    assert thread.status == "completed"
    assert not is_participant(test_db, thread.id, reader.id)
    assert not is_participant(test_db, thread.id, removed.id)
    assert not is_participant(test_db, thread.id, inactive.id)


def test_lifecycle_push_waits_for_outer_commit_and_discards_savepoint_rollback(
    test_db: Session, monkeypatch
) -> None:
    from app.services.project_chat import push

    published = []
    monkeypatch.setattr(push, "push_project_chat_message", published.append)
    test_db.connection()
    push.queue_project_chat_after_commit(test_db, {"messageId": "outer"})
    with test_db.begin_nested():
        push.queue_project_chat_after_commit(test_db, {"messageId": "inner"})
    assert published == []
    with pytest.raises(ValueError), test_db.begin_nested():
        push.queue_project_chat_after_commit(test_db, {"messageId": "rolled-back"})
        raise ValueError("rollback")
    test_db.commit()
    assert published == [{"messageId": "outer"}, {"messageId": "inner"}]
    test_db.connection()
    push.queue_project_chat_after_commit(test_db, {"messageId": "discarded"})
    test_db.rollback()
    assert len(published) == 2


def test_history_reads_original_project_before_remapping_and_deduplicates_authors(
    test_db: Session, test_user: User
) -> None:
    author, assignee = person(test_db, "author"), person(test_db, "assigned")
    project = CloudProject(
        name="Original", project_key="OLD", created_by_user_id=test_user.id
    )
    test_db.add(project)
    test_db.flush()
    group = make_group(
        test_db, test_user, [(author, "Developer"), (assignee, "Developer")]
    )
    thread = LoopItem(
        id="OLD-1",
        cloud_project_id=group.id,
        title="Migrated",
        created_by_user_id=test_user.id,
        assignee_user_id=assignee.id,
    )
    test_db.add(thread)
    test_db.flush()
    for index, deleted_at in enumerate(
        (None, datetime(1970, 1, 1), datetime(1970, 1, 1, 0, 0, 1))
    ):
        test_db.add(
            LoopItemComment(
                cloud_project_id=project.id,
                loop_item_id=thread.id,
                description="Original discussion",
                created_by_user_id=author.id,
                deleted_at=deleted_at,
            )
        )
        test_db.add(
            ProjectChatMessage(
                message_id=f"old-{index}",
                project_id=project.id,
                task_id=thread.id,
                sender_type="user",
                sender_id=str(author.id),
                message_type="text",
                content="Original chat",
                deleted_at=deleted_at,
            )
        )
    test_db.flush()
    assert initialize_historical_participants(
        test_db, thread, source_container_id=project.id
    ) == sorted([test_user.id, assignee.id, author.id])
    assert test_db.query(ThreadParticipant).filter_by(parent_id=thread.id).count() == 3
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, author.id))
    participant.metadata_json = {"notifications": "muted"}
    test_db.flush()
    assert (
        initialize_historical_participants(
            test_db, thread, source_container_id=project.id
        )
        == []
    )
    assert participant.metadata_json == {"notifications": "muted"}
    assert is_participant(test_db, thread.id, author.id)


@pytest.mark.parametrize("metadata", [["invalid"], "invalid"])
def test_malformed_history_metadata_stops_initialization_without_guessing(
    test_db: Session, test_user: User, metadata
) -> None:
    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    comment = LoopItemComment(
        cloud_project_id=group.id,
        loop_item_id=thread.id,
        description="Discussion",
        created_by_user_id=test_user.id,
        metadata_json=metadata,
    )
    test_db.add(comment)
    test_db.flush()
    with pytest.raises(
        ValueError, match=f"Invalid discussion metadata on comment {comment.id}"
    ):
        initialize_historical_participants(
            test_db, thread, source_container_id=group.id
        )


def test_independent_group_reuses_real_thread_creation_and_board_http(
    test_client, test_db: Session, test_user: User, test_token: str
) -> None:
    group = make_group(test_db, test_user, [])
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    created = test_client.post(
        f"/api/v1/cloud-projects/{group.id}/loop-items",
        headers=headers,
        json={"title": "Independent Thread", "notify_assignee": False},
    )
    assert created.status_code == 201, created.text
    thread = created.json()
    assert thread["group_id"] == group.id
    assert thread["joined"] is True
    snapshot = test_client.get(
        f"/api/v1/cloud-projects/{group.id}/board-snapshot", headers=headers
    )
    assert snapshot.status_code == 200, snapshot.text
    assert [item["id"] for item in snapshot.json()["items"]] == [thread["id"]]
    assert [member["user_id"] for member in snapshot.json()["members"]] == [
        test_user.id
    ]
    updated = test_client.patch(
        f"/api/v1/loop-items/{thread['id']}",
        headers=headers,
        json={"version": thread["version"], "status": "completed"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "completed"
    test_db.refresh(group)
    assert group.status == "active"


@pytest.mark.parametrize(
    ("project_role", "expected"), [("Developer", None), ("Viewer", 403), (None, 404)]
)
@pytest.mark.parametrize("clearing", [False, True])
def test_thread_milestone_requires_its_linked_project_authority(
    test_db: Session,
    test_user: User,
    project_role: str | None,
    expected: int | None,
    clearing: bool,
) -> None:
    from app.services.thread_project_links import require_thread_milestone

    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    project = CloudProject(
        name="Independent project",
        project_key="LINKED",
        created_by_user_id=test_user.id,
    )
    test_db.add(project)
    test_db.flush()
    workspace_owner = person(test_db, "milestone-workspace-owner")
    workspace = Kind(
        kind="CollaborationWorkspace",
        namespace="default",
        name="Milestone workspace",
        user_id=workspace_owner.id,
        json={"spec": {}},
        is_active=True,
    )
    test_db.add(workspace)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="workspace",
            entity_id=str(workspace.id),
            user_id=workspace_owner.id,
            role="Maintainer",
            status="approved",
        )
    )
    milestone = ProjectMilestone(
        cloud_project_id=project.id, title="Release", status="open"
    )
    link = ThreadProjectLink(
        parent_id=project.id, loop_item_id=thread.id, status="active"
    )
    test_db.add_all([milestone, link])
    if project_role:
        test_db.add(
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(project.id),
                entity_type="user",
                entity_id=str(test_user.id),
                user_id=test_user.id,
                role=project_role,
                status="approved",
            )
        )
    test_db.flush()
    if clearing:
        thread.metadata_json = {"milestone_id": milestone.id}
    target = None if clearing else milestone.id
    if expected:
        with pytest.raises(HTTPException) as denied:
            require_thread_milestone(test_db, thread, test_user.id, target)
        assert denied.value.status_code == expected
    else:
        require_thread_milestone(test_db, thread, test_user.id, target)
    link.status = "removed"
    test_db.flush()
    with pytest.raises(HTTPException) as missing:
        require_thread_milestone(test_db, thread, test_user.id, target)
    assert missing.value.status_code == 422
