# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Submission recovery must never keep a lease around model execution."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.channels.dingtalk import card_execution, card_follow_up, card_inbox
from app.services.channels.dingtalk.card_execution import CardTaskExecution
from app.services.channels.dingtalk.card_follow_up import DingTalkCardCallbackHandler
from app.services.channels.dingtalk.card_inbox import CardActionRecord
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from tests.services.channels.dingtalk.test_chat_card import MemoryInbox
from tests.services.channels.dingtalk.test_chat_card import binding as binding
from tests.services.channels.dingtalk.test_chat_card import config as config


@pytest.fixture
def submitted(monkeypatch, binding):
    engine = create_engine("sqlite://")
    for model in (TaskResource, Subtask):
        model.__table__.create(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(card_execution, "SessionLocal", factory)
    monkeypatch.setattr(card_follow_up, "SessionLocal", factory)
    with factory() as db:
        db.add(
            TaskResource(
                id=101,
                user_id=9,
                kind="Task",
                name="original",
                client_origin="frontend",
                is_group_chat=True,
                json={"spec": {"title": "original"}},
            )
        )
        for role, subtask_id, message_id, parent_id in (
            (SubtaskRole.USER, 204, 3, None),
            (SubtaskRole.ASSISTANT, 203, 4, 3),
        ):
            db.add(
                Subtask(
                    id=subtask_id,
                    user_id=9,
                    sender_user_id=10 if role == SubtaskRole.USER else 0,
                    task_id=101,
                    team_id=11,
                    title="next",
                    bot_ids=[12],
                    role=role,
                    message_id=message_id,
                    parent_id=parent_id,
                    prompt="next",
                    result={
                        "source": {
                            "channel_type": "dingtalk",
                            "channel_id": 77,
                            "message_id": "event-1",
                        }
                    },
                )
            )
        db.commit()
    yield factory
    engine.dispose()


@pytest.fixture
def receipt(binding):
    return CardActionRecord(
        binding=binding,
        track_id="card-a",
        event_id="event-1",
        text="next",
        image_urls=[],
        actor_staff_id="staff-b",
        state="running",
    )


@pytest.fixture
def receiver(binding):
    handler = DingTalkChannelHandler(
        channel_id=77, get_chat_card_config=lambda: binding.config.model_dump()
    )
    handler._use_ai_card = True
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox = MemoryInbox()
    receiver._update_status = AsyncMock()
    receiver._report_error = AsyncMock()
    return receiver


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["pending", "running", "completed"])
async def test_recovered_submission_starts_once_without_holding_receipt(
    monkeypatch, submitted, receiver, receipt, state
):
    receipt.state = state
    await receiver.inbox.enqueue(receipt)
    receiver._run = AsyncMock(return_value=receiver._recover_submission(receipt))
    started = asyncio.Event()
    finished = asyncio.Event()
    executions = []

    async def run(execution, handler):
        executions.append(execution.subtask_id)
        assert not receiver.inbox.claimed
        assert execution.subtask_id == 203
        assert execution.user_subtask_id == 204
        assert execution.user_id == 10
        assert execution.params.client_origin == "frontend"
        assert execution.params.is_group_chat
        started.set()
        await finished.wait()
        return True

    monkeypatch.setattr(CardTaskExecution, "run", run)
    # Scale the submission deadline down; it must not apply to the model.
    monkeypatch.setattr(card_follow_up, "SUBMISSION_TIMEOUT_SECONDS", 0.01)
    receiver._schedule("event-1")
    jobs = list(receiver._jobs)
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        assert receiver.inbox.records["event-1"].state == "completed"
        done, _ = await asyncio.wait(jobs, timeout=0.03)
        assert not done
        # A different worker may recover the receipt during model execution.
        await receiver._run_record("event-1")
        assert executions == [203]
        assert receiver._run.await_count == int(state == "pending")
        receiver._report_error.assert_not_awaited()
    finally:
        finished.set()
        await asyncio.gather(*jobs)
    assert receiver.inbox.receipts["event-1"] == "completed"
    assert "event-1" not in receiver.inbox.records


@pytest.mark.asyncio
async def test_submission_timeout_keeps_committed_turn_for_recovery(
    monkeypatch, submitted, receiver, receipt
):
    receipt.state = "pending"
    await receiver.inbox.enqueue(receipt)

    async def interrupted_after_commit(*args):
        await asyncio.Future()

    receiver._run = AsyncMock(side_effect=interrupted_after_commit)
    monkeypatch.setattr(card_follow_up, "SUBMISSION_TIMEOUT_SECONDS", 0.01)
    await receiver._run_record("event-1")
    assert not receiver.inbox.claimed
    assert receiver.inbox.records["event-1"].state == "running"

    run = AsyncMock(return_value=True)
    monkeypatch.setattr(CardTaskExecution, "run", run)
    await receiver._run_record("event-1")
    receiver._run.assert_awaited_once()
    run.assert_awaited_once()
    assert receiver.inbox.receipts["event-1"] == "completed"


@pytest.mark.parametrize("status", list(SubtaskStatus))
def test_only_pending_subtask_can_be_claimed(submitted, receiver, receipt, status):
    execution = receiver._recover_submission(receipt)
    with submitted() as db:
        db.get(Subtask, 203).status = status
        db.commit()
    assert execution.claim() is (status == SubtaskStatus.PENDING)
    assert execution.claim() is False


@pytest.mark.parametrize("field,value", [("channel_id", 78), ("message_id", "other")])
def test_recovery_does_not_adopt_another_source_event(
    submitted, receiver, receipt, field, value
):
    with submitted() as db:
        message = db.get(Subtask, 204)
        message.result = {"source": {**message.result["source"], field: value}}
        db.commit()
    assert receiver._recover_submission(receipt) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("dispatch_cancelled", [False, True])
async def test_cancel_before_dispatch_settles_claimed_turn(
    monkeypatch, binding, dispatch_cancelled
):
    handler = DingTalkChannelHandler(channel_id=77)
    handler._mark_private_im_task_response_failed = Mock()
    subtask = SimpleNamespace(id=203, status=SubtaskStatus.RUNNING)

    async def trigger(**kwargs):
        if dispatch_cancelled:
            subtask.status = SubtaskStatus.CANCELLED
        raise asyncio.CancelledError()

    handler._trigger_private_im_task_response = AsyncMock(side_effect=trigger)
    task = SimpleNamespace(id=101)
    db = MagicMock()
    db.__enter__.return_value = db
    monkeypatch.setattr(card_execution, "SessionLocal", Mock(return_value=db))
    monkeypatch.setattr(card_execution.task_store, "get_by_id", Mock(return_value=task))
    monkeypatch.setattr(
        card_execution.subtask_store, "get_by_id", Mock(return_value=subtask)
    )
    monkeypatch.setattr(card_execution, "get_task_team", Mock())
    execution = CardTaskExecution(
        101, 203, 204, 9, SimpleNamespace(content="next"), Mock()
    )

    with pytest.raises(asyncio.CancelledError):
        await execution.run(handler)
    assert handler._mark_private_im_task_response_failed.call_count == int(
        not dispatch_cancelled
    )
    # Cancellation already persisted by dispatch must not be overwritten.
    subtask.status = SubtaskStatus.CANCELLED
    handler._mark_private_im_task_response_failed.reset_mock()
    assert await execution.run(handler) is False
    handler._mark_private_im_task_response_failed.assert_not_called()
    handler._trigger_private_im_task_response.assert_awaited_once()


@pytest.mark.asyncio
async def test_receipt_claim_has_no_renewal_and_releases_on_cancellation(monkeypatch):
    lock = AsyncMock()
    client = AsyncMock()
    client.lock = Mock(return_value=lock)
    monkeypatch.setattr(
        card_inbox.cache_manager, "_get_client", AsyncMock(return_value=client)
    )
    inbox = card_inbox.CardActionInbox(77)
    with pytest.raises(asyncio.CancelledError):
        async with inbox.claim("event-1") as acquired:
            assert acquired
            raise asyncio.CancelledError()
    lock.release.assert_awaited_once()
    lock.extend.assert_not_called()
    lock.reacquire.assert_not_called()
    client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_drain_waits_for_execution_in_original_job(
    monkeypatch, submitted, receiver, receipt
):
    execution_started = asyncio.Event()
    execution_finished = asyncio.Event()

    async def execute(execution, handler):
        execution_started.set()
        await execution_finished.wait()

    monkeypatch.setattr(CardTaskExecution, "run", execute)
    await receiver.inbox.enqueue(receipt)
    receiver._schedule("event-1")
    drain = asyncio.create_task(receiver.drain())
    try:
        await asyncio.wait_for(execution_started.wait(), timeout=1)
        assert not drain.done()
        execution_finished.set()
        await asyncio.wait_for(drain, timeout=1)
        assert not receiver._jobs
    finally:
        execution_finished.set()
        await drain
