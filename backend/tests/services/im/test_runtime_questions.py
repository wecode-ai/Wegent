# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Question delivery and answer routing without external IM accounts."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.im_session import IMPrivateSession
from app.services.im import runtime_questions as service
from app.services.im.interaction_service import im_interaction_service

pytestmark = pytest.mark.asyncio


@pytest.fixture
def setup(monkeypatch, fake_im_session_cache):
    from app.services.im import question_context

    def actor_route(_db, *, user_id, submitted_device_id):
        if user_id == 7 and submitted_device_id in {
            "actor",
            "actor-socket",
            "native-actor",
        }:
            return SimpleNamespace(
                logical_device_id="actor", runtime_device_id="actor-socket"
            )
        if user_id == 7 and submitted_device_id == "other-owned-native":
            return SimpleNamespace(
                logical_device_id="other-actor", runtime_device_id="other-socket"
            )
        return None

    monkeypatch.setattr(question_context, "resolve_runtime_route_identity", actor_route)
    session = IMPrivateSession("session", 7, "telegram", 3, "chat", "sender")
    db = Mock()

    monkeypatch.setattr(service, "cache_manager", fake_im_session_cache)
    sender = AsyncMock(return_value={"success": True, "result": {"message_id": 101}})
    monkeypatch.setattr(service.im_notification_dispatcher, "send_text", sender)
    transcript = SimpleNamespace(turns=[], running=False)
    read = AsyncMock(return_value=transcript)
    monkeypatch.setattr(service.runtime_work_service, "get_runtime_transcript", read)
    send = AsyncMock(return_value=SimpleNamespace(accepted=True))
    monkeypatch.setattr(service.runtime_work_service, "send_runtime_message", send)
    context = SimpleNamespace(
        sender_id="sender",
        content="2",
        extra_data={"reply_to_message_id": "101"},
        images=[],
        files=[],
    )
    return SimpleNamespace(
        db=db,
        session=session,
        sender=sender,
        transcript=transcript,
        read=read,
        send=send,
        context=context,
        port=SimpleNamespace(send_text_reply=AsyncMock()),
        cache=fake_im_session_cache,
    )


def event(*, async_input=False, task="task", request=42, questions=1):
    payload = {
        "kind": "request_user_input",
        "interactionScope": "turn",
        "questions": [
            {
                "id": f"q{i}",
                "question": f"Question {i}?",
                "options": [
                    {"label": "A", "description": "First"},
                    {"label": "B"},
                ],
            }
            for i in range(questions)
        ],
    }
    payload.update(
        {"delivery": "async", "itemId": str(request)}
        if async_input
        else {"requestId": request}
    )
    return {
        "taskId": task,
        "taskTitle": "Task title",
        "event_type": "response.block.created",
        "data": {"block": {"id": "block", "render_payload": payload}},
    }


async def deliver(s, notification):
    # Seed the Rust delivery contract, then exercise the actual Python ingress.
    payload = notification["data"]["block"]["render_payload"]
    s.transcript.turns = [
        {
            "id": "turn",
            "items": [
                {
                    "type": "block",
                    "block": {"render_payload": payload},
                }
            ],
        }
    ]
    key = notification["taskId"] + str(service.question_identity(payload))
    async with service._locked(7) as state:
        state.setdefault(
            key,
            {
                "address": {"deviceId": "mac", "taskId": notification["taskId"]},
                "payload": payload,
                "answers": {},
                "status": "pending",
                "created_at": service.time.time(),
                "title": "Task title",
                "deliveries": {
                    "session": {
                        "q0": str(s.sender.return_value["result"]["message_id"])
                    }
                },
                "texts": {q["id"]: q["question"] for q in payload["questions"]},
            },
        )


async def answer(s):
    return await service.answer_runtime_question(
        db=s.db, user_id=7, session=s.session, context=s.context, port=s.port
    )


@pytest.mark.parametrize("async_input", [False, True])
async def test_quoted_reply_reaches_original_task_and_delivery_kind(setup, async_input):
    s = setup
    await deliver(s, event(async_input=async_input))
    assert await answer(s)
    request = s.send.await_args.kwargs["request"]
    assert request.address.device_id == "mac"
    assert request.address.local_task_id == "task"
    assert request.message == "Question 0?\nB"
    assert request.queue_if_busy == async_input
    assert request.client_user_message_id.startswith("im-question:")
    if async_input:
        assert request.request_user_input_response["delivery"] == "async"
        assert request.request_user_input_response["itemId"] == "42"
    else:
        assert request.request_user_input_response == {
            "requestId": 42,
            "interactionScope": "turn",
            "answers": {"q0": {"answers": ["B"]}},
        }


async def test_delivery_replay_and_duplicate_quoted_reply_are_idempotent(setup):
    s = setup
    notification = event()
    await deliver(s, notification)
    await deliver(s, notification)
    s.sender.assert_not_awaited()
    s.context.extra_data["reply_to_message_id"] = 101
    assert await answer(s)
    assert await answer(s)
    s.send.assert_awaited_once()
    assert s.port.send_text_reply.await_args.args[1] == service.STALE_REPLY


async def test_multiple_tasks_require_quote_and_keep_exact_address(setup):
    s = setup
    await deliver(s, event(task="first"))
    s.sender.return_value = {"success": True, "result": {"message_id": 102}}
    await deliver(s, event(task="second"))
    s.context.extra_data = {}
    assert not await answer(s)
    s.send.assert_not_awaited()
    s.context.extra_data["reply_to_message_id"] = 102
    assert await answer(s)
    assert s.send.await_args.kwargs["request"].address.local_task_id == "second"


@pytest.mark.parametrize("async_input", [False, True])
async def test_multiple_questions_are_collected_without_repeating_answers(
    setup, async_input
):
    s = setup
    await deliver(s, event(questions=2, async_input=async_input))
    s.sender.return_value = {"success": True, "result": {"message_id": 102}}
    assert await answer(s)
    s.send.assert_not_awaited()
    assert "Question 1?" in s.sender.await_args.args[2]
    s.context.extra_data["reply_to_message_id"] = 102
    s.context.content = "custom answer"
    assert await answer(s)
    assert s.send.await_args.kwargs["request"].message == (
        "Question 0?\nB\nQuestion 1?\ncustom answer"
    )


@pytest.mark.parametrize(
    "settlement",
    [
        "response",
        "cancelled",
        "expired",
        "missing",
        "user_reply",
        "turn_cancelled",
        "turn_error",
    ],
)
async def test_desktop_answers_cancellation_and_missing_questions_are_rejected(
    setup, settlement
):
    s = setup
    await deliver(s, event(async_input=True))
    payload = s.transcript.turns[0]["items"][0]["block"]["render_payload"]
    if settlement == "response":
        payload["response"] = {"answers": {"q0": {"answers": ["A"]}}}
    elif settlement == "missing":
        s.transcript.turns.clear()
    elif settlement == "user_reply":
        s.transcript.turns[0]["items"].append({"type": "user_message"})
    elif settlement.startswith("turn_"):
        s.transcript.turns[0]["status"] = settlement.removeprefix("turn_")
    else:
        payload["interactionStatus"] = settlement
    assert await answer(s)
    s.send.assert_not_awaited()
    assert s.port.send_text_reply.await_args.args[1] == service.STALE_REPLY


async def test_failed_dispatch_keeps_question_editable(setup):
    s = setup
    await deliver(s, event())
    s.send.side_effect = RuntimeError("device disconnected")
    assert await answer(s)
    s.send.side_effect = None
    assert await answer(s)
    assert s.send.await_count == 2
    assert s.send.await_args_list[0].kwargs["request"].client_user_message_id == (
        s.send.await_args_list[1].kwargs["request"].client_user_message_id
    )


async def test_concurrent_im_replies_submit_once(setup):
    s = setup
    await deliver(s, event())
    s.context.extra_data["reply_to_message_id"] = 101
    await asyncio.gather(answer(s), answer(s))
    s.send.assert_awaited_once()


async def test_another_sender_or_session_cannot_answer(setup):
    s = setup
    await deliver(s, event())
    s.context.sender_id = "someone-else"
    assert not await answer(s)
    s.context.sender_id = "sender"
    s.session.session_key = "another-session"
    assert not await answer(s)
    s.send.assert_not_awaited()


async def test_answer_is_consumed_before_chat_or_stand_in_routing(setup, monkeypatch):
    s = setup
    await deliver(s, event())
    stand_in = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.interaction_service.send_stand_in_message", stand_in
    )
    assert await im_interaction_service.route_private_message(
        db=s.db,
        user=SimpleNamespace(id=7),
        im_session=s.session,
        message_context=s.context,
        port=s.port,
    )
    s.send.assert_awaited_once()
    stand_in.assert_not_awaited()


async def test_duplicate_quoted_provider_event_does_not_enter_ordinary_chat(setup):
    s = setup
    s.context.extra_data["message_id"] = "provider-event"
    await deliver(s, event())
    assert await answer(s)
    assert await answer(s)
    s.send.assert_awaited_once()


async def test_failed_acknowledgment_does_not_lose_accepted_answer(setup):
    s = setup
    await deliver(s, event())
    s.context.extra_data["reply_to_message_id"] = 101
    s.port.send_text_reply.side_effect = RuntimeError("provider disconnected")
    with pytest.raises(RuntimeError, match="provider disconnected"):
        await answer(s)
    s.port.send_text_reply.side_effect = None
    assert await answer(s)
    s.send.assert_awaited_once()


async def test_rejected_answer_keeps_same_provider_event_retryable(setup):
    s = setup
    await deliver(s, event())
    s.context.extra_data["message_id"] = "provider-event"
    s.send.return_value = SimpleNamespace(accepted=False)
    assert await answer(s)
    s.send.return_value = SimpleNamespace(accepted=True)
    assert await answer(s)
    assert s.send.await_count == 2


async def test_multiple_questions_retry_failed_next_delivery_without_losing_first_answer(
    setup,
):
    s = setup
    await deliver(s, event(questions=2))
    s.sender.return_value = {"success": False}
    s.context.extra_data["reply_to_message_id"] = 101
    assert await answer(s)
    s.send.assert_not_awaited()
    s.sender.return_value = {"success": True, "result": {"message_id": 102}}
    assert await answer(s)
    s.context.extra_data["reply_to_message_id"] = 102
    assert await answer(s)
    request = s.send.await_args.kwargs["request"]
    assert request.request_user_input_response["answers"] == {
        "q0": {"answers": ["B"]},
        "q1": {"answers": ["B"]},
    }


async def test_no_pending_question_preserves_chat_routing(setup):
    assert not await answer(setup)
    setup.read.assert_not_awaited()
    setup.send.assert_not_awaited()


async def test_pending_question_does_not_expire_due_to_im_cache_retention(setup):
    s = setup
    await deliver(s, event())
    key = service._state_key(7)
    state = await s.cache.get(key)
    next(iter(state.values()))["created_at"] -= 30 * 24 * 60 * 60
    await s.cache.set(key, state)
    assert await answer(s)
    s.send.assert_awaited_once()


async def test_async_continuation_preserves_its_original_private_im_source(setup):
    s = setup
    await deliver(s, event(async_input=True))
    async with service._locked(7) as state:
        next(iter(state.values()))["source"] = {
            "source": "im",
            "external_id": "session",
            "channel_type": "telegram",
            "channel_id": 3,
            "conversation_id": "chat",
            "sender_id": "sender",
            "message_id": "original-message",
        }
    assert await answer(s)
    request = s.send.await_args.kwargs["request"]
    assert request.source.external_id == "session"
    assert request.source.sender_id == "sender"


async def test_quoted_question_accepts_text_that_is_also_an_im_command(setup):
    s = setup
    await deliver(s, event())
    s.context.content = "/cancel"
    s.context.extra_data["reply_to_message_id"] = 101
    assert await im_interaction_service.route_private_message(
        db=s.db,
        user=SimpleNamespace(id=7),
        im_session=s.session,
        message_context=s.context,
        port=s.port,
    )
    assert s.send.await_args.kwargs["request"].request_user_input_response[
        "answers"
    ] == {
        "q0": {"answers": ["/cancel"]},
    }


@pytest.mark.parametrize("async_input", [False, True])
async def test_shared_connections_collect_next_question_and_submit_only_once(
    setup,
    monkeypatch,
    async_input,
):
    s = setup
    secondary = IMPrivateSession("second", 7, "dingtalk", 4, "chat2", "sender2")
    primary = s.session
    monkeypatch.setattr(
        service.im_session_service,
        "get_session",
        AsyncMock(
            side_effect=lambda key: {"session": primary, "second": secondary}.get(key)
        ),
    )
    await deliver(s, event(async_input=async_input, questions=2))
    async with service._locked(7) as state:
        next(iter(state.values()))["deliveries"]["second"] = {"q0": "202"}
    await answer(s)
    assert {call.args[1].session_key for call in s.sender.await_args_list} == {
        "session",
        "second",
    }
    s.send.assert_not_awaited()
    s.session = secondary
    s.context.sender_id = "sender2"
    s.context.extra_data = {"reply_to_message_id": "101", "message_id": "answer2"}
    await answer(s)
    s.send.assert_awaited_once()
    assert s.send.await_args.kwargs["request"].request_user_input_response[
        "answers"
    ] == {
        "q0": {"answers": ["B"]},
        "q1": {"answers": ["B"]},
    }
    s.session = primary
    s.context.sender_id = "sender"
    s.context.extra_data = {"reply_to_message_id": "101", "message_id": "late"}
    await answer(s)
    s.send.assert_awaited_once()


@pytest.mark.parametrize("async_input", [False, True])
@pytest.mark.parametrize("text", ["2", "发布吧", "先查一下天气"])
@pytest.mark.parametrize("mode", ["chat", "stand_in"])
async def test_unquoted_messages_always_reach_stand_in_without_auto_answer(
    setup,
    monkeypatch,
    async_input,
    text,
    mode,
):
    s = setup
    await deliver(s, event(async_input=async_input))
    s.context.extra_data = {}
    s.context.content = text
    await service.im_session_service.set_mode(s.session, mode)
    stand_in = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.interaction_service.send_stand_in_message", stand_in
    )
    assert await im_interaction_service.route_private_message(
        db=s.db,
        user=SimpleNamespace(id=7),
        im_session=s.session,
        message_context=s.context,
        port=s.port,
    )
    stand_in.assert_awaited_once()
    s.send.assert_not_awaited()
    s.read.assert_not_awaited()
    s.port.send_text_reply.assert_not_awaited()


async def reply_context(s, monkeypatch):
    import json

    from app.services.im.question_context import pending_question_context

    monkeypatch.setattr(
        service.im_session_service, "get_session", AsyncMock(return_value=s.session)
    )
    s.context.extra_data = {"message_id": "owner-message"}
    context = await pending_question_context(
        s.db,
        s.session,
        s.context,
        {
            "taskId": "stand-in-chat-7-primary",
            "deviceId": "actor",
            "runtimeDeviceId": "actor-socket",
        },
    )
    return json.loads(context["wework.im.pending-questions"]["value"])


def interpreted_request(context, answer="2"):
    from app.schemas.runtime_work import RuntimeSendRequest

    return RuntimeSendRequest.model_validate(
        {
            "address": {"deviceId": "actor", "taskId": "stand-in-chat-7-primary"},
            "message": answer,
            "imQuestionAnswer": {
                "replyToken": context["replyToken"],
                "questionId": context["questions"][0]["questionId"],
            },
        }
    )


@pytest.mark.parametrize("async_input", [False, True])
@pytest.mark.parametrize("actor_device", ["actor", "native-actor"])
async def test_stand_in_can_interpret_a_reply_and_submit_once_to_original_task(
    setup,
    monkeypatch,
    async_input,
    actor_device,
):
    from app.services.im.question_context import submit_interpreted_answer

    s = setup
    await deliver(s, event(async_input=async_input))
    context = await reply_context(s, monkeypatch)
    assert context["questions"][0]["backgroundContinues"] == async_input
    assert context["questions"][0]["taskTitle"] == "Task title"
    assert context["questions"][0]["question"] == "Question 0?"
    s.send.assert_not_awaited()
    request = interpreted_request(context)
    request.address.device_id = actor_device
    for _ in range(2):
        result = await submit_interpreted_answer(s.db, 7, request)
        assert result.accepted and result.local_task_id == "task"
    s.send.assert_awaited_once()
    sent = s.send.await_args.kwargs["request"]
    assert sent.address.device_id == "mac"
    assert sent.request_user_input_response["answers"] == {"q0": {"answers": ["B"]}}
    assert sent.queue_if_busy == async_input
    assert sent.im_question_answer is None


@pytest.mark.parametrize(
    "invalid",
    [
        "user",
        "device",
        "other_device_alias",
        "actor",
        "token",
        "question",
        "sender",
        "session_owner",
        "expired",
        "approval",
    ],
)
async def test_interpreted_answers_cannot_expand_the_private_message_scope(
    setup,
    monkeypatch,
    invalid,
):
    from fastapi import HTTPException

    from app.services.im.question_context import submit_interpreted_answer

    s = setup
    await deliver(s, event())
    context = await reply_context(s, monkeypatch)
    request = interpreted_request(context)
    user = 7
    if invalid == "user":
        user = 8
    elif invalid == "device":
        request.address.device_id = "foreign"
    elif invalid == "other_device_alias":
        request.address.device_id = "other-owned-native"
    elif invalid == "actor":
        request.address.local_task_id = "different-role"
    elif invalid == "token":
        request.im_question_answer.reply_token = "not-issued"
    elif invalid == "question":
        request.im_question_answer.question_id = "another-question"
    elif invalid == "sender":
        s.session.sender_id = "replacement-sender"
    elif invalid == "session_owner":
        s.session.user_id = 8
    elif invalid == "expired":
        s.transcript.turns.clear()
    elif invalid == "approval":
        async with service._locked(7) as state:
            next(iter(state.values()))["payload"]["approvalKind"] = "exec"
    with pytest.raises(HTTPException):
        await submit_interpreted_answer(s.db, user, request)
    s.send.assert_not_awaited()


async def test_interpreted_and_quoted_answers_share_multi_question_progress(
    setup, monkeypatch
):
    from app.services.im.question_context import submit_interpreted_answer

    s = setup
    await deliver(s, event(questions=2, async_input=True))
    context = await reply_context(s, monkeypatch)
    s.sender.return_value = {"success": True, "result": {"message_id": 102}}
    await submit_interpreted_answer(s.db, 7, interpreted_request(context))
    s.send.assert_not_awaited()
    assert "Question 1?" in s.sender.await_args.args[2]
    s.context.extra_data = {"reply_to_message_id": 102}
    s.context.content = "第二题答案"
    assert await answer(s)
    assert s.send.await_args.kwargs["request"].request_user_input_response[
        "answers"
    ] == {
        "q0": {"answers": ["B"]},
        "q1": {"answers": ["第二题答案"]},
    }


async def test_pending_context_hides_other_private_conversations_and_settled_questions(
    setup,
):
    from app.services.im.question_context import pending_question_context

    s = setup
    await deliver(s, event())
    target = {"taskId": "actor", "deviceId": "actor", "runtimeDeviceId": "socket"}
    other = IMPrivateSession("other", 7, "telegram", 3, "other", "sender")
    assert await pending_question_context(s.db, other, s.context, target) == {}
    s.transcript.turns.clear()
    assert await pending_question_context(s.db, s.session, s.context, target) == {}
    s.send.assert_not_awaited()


@pytest.mark.parametrize("question_device_status", [None, 502, 504])
async def test_pending_questions_reach_the_real_stand_in_dispatch_context(
    setup, monkeypatch, question_device_status
):
    import json

    from app.services.im import stand_in_service

    s = setup
    await deliver(s, event(async_input=True))
    if question_device_status is not None:
        from fastapi import HTTPException

        s.read.side_effect = HTTPException(
            question_device_status, "Question device unavailable"
        )
    s.context.extra_data = {"message_id": "ordinary-message"}
    target = {
        "taskId": "stand-in-chat-7-primary",
        "deviceId": "actor",
        "runtimeDeviceId": "socket",
        "roleId": None,
    }
    rpc = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(stand_in_service.runtime_rpc_service, "call", rpc)
    await stand_in_service._dispatch(
        s.db,
        SimpleNamespace(id=7),
        s.session,
        s.context,
        s.port,
        target,
        {},
        "ordinary-message",
    )
    payload = rpc.await_args.kwargs["payload"]
    assert payload["message"] == "2"
    additional_context = payload["options"]["additionalContext"]
    if question_device_status is None:
        pending = additional_context["wework.im.pending-questions"]
        assert pending["kind"] == "untrusted"
        assert json.loads(pending["value"])["questions"][0]["question"] == "Question 0?"
    else:
        assert "wework.im.pending-questions" not in additional_context
    s.send.assert_not_awaited()


async def test_interpreted_answer_retries_cannot_change_a_recorded_answer(
    setup, monkeypatch
):
    from fastapi import HTTPException

    from app.services.im.question_context import submit_interpreted_answer

    s = setup
    await deliver(s, event())
    context = await reply_context(s, monkeypatch)
    await submit_interpreted_answer(s.db, 7, interpreted_request(context, "A"))
    with pytest.raises(HTTPException, match="different answer"):
        await submit_interpreted_answer(s.db, 7, interpreted_request(context, "B"))
    s.send.assert_awaited_once()


async def test_interpreted_dispatch_failure_does_not_record_an_unaccepted_answer(
    setup, monkeypatch
):
    from app.services.im.question_context import submit_interpreted_answer

    s = setup
    await deliver(s, event(async_input=True))
    context = await reply_context(s, monkeypatch)
    request = interpreted_request(context)
    s.send.side_effect = RuntimeError("disconnected")
    with pytest.raises(RuntimeError, match="disconnected"):
        await submit_interpreted_answer(s.db, 7, request)
    state = await s.cache.get(service._state_key(7))
    assert next(iter(state.values()))["answers"] == {}
    s.send.side_effect = None
    assert (await submit_interpreted_answer(s.db, 7, request)).accepted
    assert s.send.await_count == 2
    assert (
        s.send.await_args_list[0].kwargs["request"].client_user_message_id
        == s.send.await_args_list[1].kwargs["request"].client_user_message_id
    )


@pytest.mark.parametrize("initial_failure", ["result", "exception"])
async def test_failed_next_question_delivery_preserves_an_already_recorded_answer(
    setup,
    initial_failure,
):
    s = setup
    await deliver(s, event(questions=2))
    s.sender.return_value = {"success": False}
    if initial_failure == "exception":
        s.sender.side_effect = RuntimeError("provider disconnected")
    assert await answer(s)
    s.sender.side_effect = RuntimeError("provider disconnected")
    assert await answer(s)
    state = await s.cache.get(service._state_key(7))
    assert next(iter(state.values()))["answers"] == {"q0": {"answers": ["B"]}}
    s.send.assert_not_awaited()
    s.sender.side_effect = None
    s.sender.return_value = {"success": True, "result": {"message_id": 102}}
    assert await answer(s)
    s.context.extra_data = {"reply_to_message_id": 102}
    assert await answer(s)
    s.send.assert_awaited_once()


@pytest.mark.parametrize("status", [403, 404, 500, 502, 503, 504])
async def test_unreadable_questions_are_not_exposed_and_do_not_block_ordinary_chat(
    setup, status
):
    from fastapi import HTTPException

    from app.services.im.question_context import pending_question_context

    s = setup
    await deliver(s, event())
    s.read.side_effect = HTTPException(status, "Original task is not readable")
    result = await pending_question_context(
        s.db,
        s.session,
        s.context,
        {
            "taskId": "actor",
            "deviceId": "actor",
            "runtimeDeviceId": "socket",
        },
    )
    assert result == {}
    s.send.assert_not_awaited()


async def test_lock_expiry_cannot_overwrite_a_new_owners_question_state(setup):
    s = setup
    await deliver(s, event())
    key = service._state_key(7)
    replacement = {
        "new-owner": {"status": "answered", "created_at": service.time.time()}
    }
    with pytest.raises(RuntimeError, match="lock ownership was lost"):
        async with service._locked(7) as state:
            state.clear()
            s.cache.locks[f"{key}:lock"].owner_token = b"new-owner"
            await s.cache.set(key, replacement)
    assert await s.cache.get(key) == replacement


async def test_locked_operations_time_out_without_the_python311_timeout_api(
    setup, monkeypatch
):
    s = setup
    await deliver(s, event())
    before = await s.cache.get(service._state_key(7))
    monkeypatch.delattr(asyncio, "timeout", raising=False)
    monkeypatch.setattr(service, "LOCK_OPERATION_SECONDS", 0.01)
    with pytest.raises(TimeoutError):
        async with service._locked(7):
            await asyncio.Event().wait()
    assert await s.cache.get(service._state_key(7)) == before
    async with service._locked(7):
        pass


async def test_transcript_timeout_does_not_grant_an_answer_or_block_context_lookup(
    setup,
):
    from app.services.im.question_context import pending_question_context

    s = setup
    await deliver(s, event())
    s.read.side_effect = TimeoutError()
    assert (
        await pending_question_context(
            s.db,
            s.session,
            s.context,
            {
                "taskId": "actor",
                "deviceId": "actor",
                "runtimeDeviceId": "socket",
            },
        )
        == {}
    )
    s.send.assert_not_awaited()
