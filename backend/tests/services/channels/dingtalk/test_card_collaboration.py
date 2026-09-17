"""DingTalk collaboration preserves task ownership and actual participant identity."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.services.channels.dingtalk import card_follow_up
from app.services.channels.dingtalk.card_binding import CardBinding
from app.services.channels.dingtalk.card_collaboration import join_card_task
from app.services.channels.dingtalk.card_follow_up import (
    DingTalkCardCallbackHandler,
    parse_follow_up,
)
from app.services.channels.dingtalk.card_inbox import CardActionRecord
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.chat.storage.task_manager import get_task_with_access_check


@pytest.fixture
def binding():
    return CardBinding(
        channel_id=77,
        user_id=9,
        task_id=101,
        subtask_id=202,
        config=DingTalkChatCardConfig(template_id="test.schema"),
        ready=True,
        incoming_data={
            "senderStaffId": "staff-a",
            "senderCorpId": "corp-a",
            "senderId": "encrypted-a",
            "senderNick": "Alice",
            "conversationType": "2",
            "conversationId": "group-a",
        },
    )


def action(binding, **changes):
    return {
        "type": "actionCallback",
        "corpId": "corp-a",
        "userId": "staff-b",
        "userIdType": 1,
        "spaceType": "im",
        "spaceId": "group-a",
        "content": {
            "cardPrivateData": {
                "actionIds": [binding.config.follow_up_action],
                "params": {binding.config.follow_up_text_key: "B clarifies"},
            }
        },
        **changes,
    }


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    TaskResource.__table__.create(engine)
    ResourceMember.__table__.create(engine)
    with Session(engine) as session:
        session.add(
            TaskResource(
                id=101,
                user_id=9,
                kind="Task",
                name="requirement-1",
                json={"spec": {"is_group_chat": False}},
                is_group_chat=False,
            )
        )
        session.commit()
        yield session
    engine.dispose()


def test_a_then_b_and_c_join_same_task(db, binding):
    task, joined = join_card_task(db, binding, 9)
    assert not joined and not task.is_group_chat
    for participant in (10, 11):
        task, joined = join_card_task(db, binding, participant)
        assert joined and task.id == 101 and task.user_id == 9
        db.commit()
        accessible, subtask_owner = get_task_with_access_check(db, 101, participant)
        assert accessible.id == 101 and subtask_owner == 9
    assert task.is_group_chat and task.json["spec"]["is_group_chat"]
    assert db.query(ResourceMember).count() == 2
    assert not join_card_task(db, binding, 10)[1]
    assert db.query(ResourceMember).count() == 2
    assert get_task_with_access_check(db, 101, 12)[0] is None


def test_failed_turn_can_roll_back_conversion_and_membership(db, binding):
    join_card_task(db, binding, 10)
    db.rollback()
    assert not db.get(TaskResource, 101).is_group_chat
    assert not db.get(TaskResource, 101).json["spec"]["is_group_chat"]
    assert db.query(ResourceMember).count() == 0


@pytest.mark.parametrize(
    "status,copied_id", [(MemberStatus.REJECTED, 0), (MemberStatus.APPROVED, 999)]
)
def test_removed_and_copied_members_are_not_auto_admitted(
    db, binding, status, copied_id
):
    db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=101,
            entity_type="user",
            entity_id="10",
            status=status,
            role="Maintainer",
            copied_resource_id=copied_id,
        )
    )
    db.commit()
    with pytest.raises(ValueError):
        join_card_task(db, binding, 10)
    assert not db.get(TaskResource, 101).is_group_chat


def test_removed_card_speaker_cannot_grant_access(db, binding):
    binding.user_id = 10
    with pytest.raises(ValueError, match="无访问权限"):
        join_card_task(db, binding, 11)
    assert db.query(ResourceMember).count() == 0


@pytest.mark.parametrize(
    "changes", [{"spaceId": "other"}, {"corpId": "other"}, {"userIdType": 2}]
)
def test_cross_group_or_unverified_actor_rejected(binding, changes):
    with pytest.raises(ValueError):
        parse_follow_up(action(binding, **changes), binding)


def test_private_card_cannot_auto_join(binding):
    binding.incoming_data["conversationType"] = "1"
    with pytest.raises(ValueError, match="原提问者"):
        parse_follow_up(action(binding), binding)


def test_actor_survives_inbox_serialization(binding):
    follow_up = parse_follow_up(action(binding), binding)
    record = CardActionRecord(
        event_id="event-b",
        track_id="card-a",
        binding=binding,
        text=follow_up.text,
        image_urls=[],
        actor_staff_id=follow_up.actor_staff_id,
    )
    recovered = CardActionRecord.model_validate_json(record.model_dump_json())
    assert recovered.actor_staff_id == "staff-b"
    assert recovered.binding.user_id == 9


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["staff_id", "select_user"])
async def test_callback_resolves_and_dispatches_actual_actor(
    monkeypatch, binding, mode
):
    handler = DingTalkChannelHandler(
        channel_id=77, get_user_mapping_config=lambda: {"mode": mode, "config": {}}
    )
    actor = SimpleNamespace(id=10, user_name="Bob")
    handler.resolve_user = AsyncMock(return_value=actor)
    receiver = DingTalkCardCallbackHandler(handler)
    receiver._continue_task = AsyncMock(return_value=True)
    receiver._report_error = AsyncMock()
    redis = MagicMock()
    redis.lock.return_value.acquire = AsyncMock(return_value=True)
    redis.lock.return_value.release = AsyncMock()
    redis.aclose = AsyncMock()
    monkeypatch.setattr(
        card_follow_up.cache_manager, "_get_client", AsyncMock(return_value=redis)
    )
    monkeypatch.setattr(card_follow_up, "SessionLocal", MagicMock())

    result = await receiver._run(
        binding, parse_follow_up(action(binding), binding), "event-b"
    )

    if mode == "select_user":
        assert not result
        handler.resolve_user.assert_not_awaited()
        receiver._continue_task.assert_not_awaited()
        assert "独立账号" in receiver._report_error.call_args.args[1]
    else:
        assert result
        context = handler.resolve_user.call_args.args[1]
        assert context.sender_name == "Bob"
        assert receiver._continue_task.call_args.args[1] is actor
        raw = receiver._reply_binding(binding, "staff-b").incoming_data
        assert raw["senderStaffId"] == "staff-b"
        assert raw["senderId"] != binding.incoming_data["senderId"]
        assert binding.incoming_data["senderStaffId"] == "staff-a"
