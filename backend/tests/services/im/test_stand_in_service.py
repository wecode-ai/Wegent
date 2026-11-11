# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession
from app.services.channels.callback import runtime_local_task_callback_key
from app.services.device.runtime_rpc_service import RuntimeRpcError
from app.services.im import stand_in_service as service

pytestmark = pytest.mark.asyncio


@pytest.fixture
def setup(monkeypatch, fake_im_session_cache):
    monkeypatch.setattr(
        service,
        "cache_manager",
        SimpleNamespace(get_or_raise=fake_im_session_cache.get),
    )
    monkeypatch.setattr(cache_manager, "set", fake_im_session_cache.set)
    monkeypatch.setattr(cache_manager, "get", fake_im_session_cache.get)
    user = SimpleNamespace(id=7, preferences={"default_execution_target": "mac"})
    session = IMPrivateSession("session", 7, "telegram", 3, "chat", "sender")
    context = SimpleNamespace(
        content="hello", images=[], files=[], extra_data={"message_id": "message"}
    )
    port = SimpleNamespace(
        send_text_reply=AsyncMock(),
        get_callback_service=Mock(return_value=None),
        _create_private_im_runtime_streaming_emitter=AsyncMock(return_value=None),
        _register_private_im_runtime_callback=AsyncMock(),
        _delete_private_im_runtime_callback=AsyncMock(),
        _emit_private_im_runtime_stream_error=AsyncMock(),
        _private_im_runtime_client_user_message_id=Mock(
            return_value="im:telegram:3:message"
        ),
        _persist_im_images_as_attachments=Mock(return_value=[]),
        _persist_im_files_as_attachments=Mock(return_value=[]),
    )
    identity = Mock(
        return_value=SimpleNamespace(
            logical_device_id="owned-mac", runtime_device_id="socket-mac"
        )
    )
    monkeypatch.setattr(service, "resolve_runtime_route_identity", identity)
    rpc = AsyncMock(
        return_value={"deviceId": "owned-mac", "taskId": "stand-in-chat-7-primary"}
    )
    monkeypatch.setattr(service.runtime_rpc_service, "call", rpc)
    return SimpleNamespace(
        user=user,
        session=session,
        context=context,
        port=port,
        rpc=rpc,
        identity=identity,
        db=Mock(),
    )


async def test_default_primary_uses_account_default_and_existing_conversation(setup):
    s = setup
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    call = s.rpc.await_args.kwargs
    assert call["method"] == "runtime.stand_in.conversation"
    assert call["allow_app_device_stand_in"] is True
    assert call["device_id"] == "owned-mac"
    assert call["payload"]["roleId"] is None
    source = call["payload"]["options"]["source"]
    assert source["source"] == "im" and source["channel_type"] == "telegram"
    assert source["message_id"] == "message"
    assert source["callback_id"].startswith("session:")
    assert "executionRequest" not in call["payload"]
    callback_key = s.port._register_private_im_runtime_callback.await_args.kwargs[
        "callback_key"
    ]
    assert callback_key == runtime_local_task_callback_key(
        "socket-mac", "stand-in-chat-7-primary", source["callback_id"]
    )
    s.port.send_text_reply.assert_not_awaited()


async def test_explicit_role_binding_overrides_default_device(setup):
    s = setup
    await cache_manager.set(
        service.binding_key(7, "session"),
        {"deviceId": "work-mac", "roleId": "reviewer"},
        expire=None,
    )
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    assert s.identity.call_args.kwargs["submitted_device_id"] == "work-mac"
    assert s.rpc.await_args.kwargs["payload"]["roleId"] == "reviewer"
    assert (
        "stand-in-chat-7-role-reviewer"
        in s.port._register_private_im_runtime_callback.await_args.kwargs[
            "callback_key"
        ]
    )


@pytest.mark.parametrize("target", [None, "", "cloud"])
async def test_missing_default_does_not_pick_an_arbitrary_device(setup, target):
    s = setup
    s.user.preferences = {"default_execution_target": target}
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    s.rpc.assert_not_awaited()
    assert "分身详情" in s.port.send_text_reply.await_args.args[1]


async def test_unowned_device_does_not_dispatch(setup):
    s = setup
    s.identity.return_value = None
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    s.rpc.assert_not_awaited()


async def test_offline_or_deleted_role_keeps_binding_and_reports_recovery(setup):
    s = setup
    binding = {"deviceId": "work-mac", "roleId": "deleted"}
    await cache_manager.set(service.binding_key(7, "session"), binding, expire=None)
    s.rpc.side_effect = RuntimeRpcError("Device offline", code="device_offline")
    assert (
        await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
        is False
    )
    assert await cache_manager.get(service.binding_key(7, "session")) == binding
    s.port._delete_private_im_runtime_callback.assert_awaited_once()
    assert (
        "分身详情"
        in s.port._emit_private_im_runtime_stream_error.await_args.kwargs["error"]
    )


async def test_concurrent_im_messages_get_separate_callback_destinations(setup):
    s = setup
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    first = s.port._register_private_im_runtime_callback.await_args.kwargs[
        "callback_key"
    ]
    s.port._private_im_runtime_client_user_message_id.return_value = (
        "im:telegram:3:second"
    )
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    second = s.port._register_private_im_runtime_callback.await_args.kwargs[
        "callback_key"
    ]
    assert first != second


async def test_failed_turn_only_deletes_its_own_callback(setup):
    s = setup
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    first = s.port._register_private_im_runtime_callback.await_args.kwargs[
        "callback_key"
    ]
    s.port._private_im_runtime_client_user_message_id.return_value = (
        "im:telegram:3:second"
    )
    s.rpc.side_effect = RuntimeRpcError("Device offline", code="device_offline")

    assert (
        await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
        is False
    )

    failed = s.port._delete_private_im_runtime_callback.await_args.args[0]
    assert failed != first
    s.port._delete_private_im_runtime_callback.assert_awaited_once_with(failed)


async def test_dingtalk_failure_cleans_only_failed_turn_with_real_handler(setup):
    from app.services.channels.dingtalk.handler import DingTalkChannelHandler

    s = setup
    callback_service = SimpleNamespace(
        delete_callback_info=AsyncMock(), _remove_emitter=AsyncMock()
    )
    port = DingTalkChannelHandler(channel_id=3)
    port.get_callback_service = Mock(return_value=callback_service)
    port._create_private_im_runtime_streaming_emitter = AsyncMock()
    port._register_private_im_runtime_callback = AsyncMock()
    port._emit_private_im_runtime_stream_error = AsyncMock()
    s.rpc.side_effect = RuntimeRpcError("Device offline", code="device_offline")

    assert (
        await service.send_stand_in_message(s.db, s.user, s.session, s.context, port)
        is False
    )

    callback_key = port._register_private_im_runtime_callback.await_args.kwargs[
        "callback_key"
    ]
    callback_service.delete_callback_info.assert_awaited_once_with(callback_key)
    callback_service._remove_emitter.assert_awaited_once_with(callback_key)
    port._emit_private_im_runtime_stream_error.assert_awaited_once()


async def test_card_error_failure_falls_back_to_text(setup):
    s = setup
    s.port._register_private_im_runtime_callback.side_effect = RuntimeError(
        "callback persistence failed"
    )
    s.port._emit_private_im_runtime_stream_error.side_effect = RuntimeError(
        "Redis unavailable"
    )

    assert (
        await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
        is False
    )

    assert "分身暂时无法接收消息" in s.port.send_text_reply.await_args.args[1]
    s.rpc.assert_not_awaited()


async def test_quoted_notification_is_context_without_changing_the_identity(setup):
    import json

    from app.services.im.session_service import im_session_service

    s = setup
    await im_session_service.save_runtime_task_reply_target(
        session=s.session,
        message_id="notification",
        runtime_task={
            "deviceId": "old-device",
            "localTaskId": "old-task",
            "modelSelection": {"modelName": "old-model"},
        },
    )
    s.context.extra_data["reply_to_message_id"] = "notification"
    await service.send_stand_in_message(s.db, s.user, s.session, s.context, s.port)
    payload = s.rpc.await_args.kwargs["payload"]
    assert payload["roleId"] is None
    reference = payload["options"]["additionalContext"]["wework.im.quoted-task"]
    assert reference["kind"] == "untrusted"
    assert json.loads(reference["value"]) == {
        "deviceId": "old-device",
        "taskId": "old-task",
    }
    assert "modelSelection" not in payload["options"]
