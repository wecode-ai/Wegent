# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.im_session import IMSessionMode
from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.channels.handler import MessageContext
from app.services.channels.model_selection import ModelSelection
from app.services.channels.selection_service import (
    SelectionOption,
    channel_selection_service,
)


def test_parse_message_preserves_dingtalk_message_id() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="continue runtime"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        is_in_at_list=False,
        _wegent_callback_data={"msgId": "dingtalk-message-1"},
    )

    context = handler.parse_message(message)

    assert context.content == "continue runtime"
    assert context.extra_data["message_id"] == "dingtalk-message-1"
    assert context.extra_data["callback_data"]["msgId"] == "dingtalk-message-1"
    assert context.proactive_recipient_id == "staff-a"


@pytest.mark.parametrize(
    ("callback_data", "expected_reply_id"),
    [
        (
            {
                "text": {
                    "content": "quoted reply",
                    "isReplyMsg": True,
                    "repliedMsg": {"msgId": "quoted-message-id"},
                },
                "originalProcessQueryKey": "notification-query-key",
            },
            "notification-query-key",
        ),
        (
            {
                "text": {
                    "content": "quoted reply",
                    "isReplyMsg": True,
                    "repliedMsg": {"msgId": "quoted-message-id"},
                },
            },
            "quoted-message-id",
        ),
    ],
)
def test_parse_message_preserves_dingtalk_quote_reference(
    callback_data: dict,
    expected_reply_id: str,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="quoted reply"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        is_in_at_list=False,
        _wegent_callback_data=callback_data,
    )

    context = handler.parse_message(message)

    assert context.extra_data["reply_to_message_id"] == expected_reply_id


def test_parse_message_does_not_mark_plain_text_as_quote() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="plain text"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        is_in_at_list=False,
        _wegent_callback_data={
            "msgId": "plain-message-id",
            "text": {"content": "plain text"},
        },
    )

    context = handler.parse_message(message)

    assert "reply_to_message_id" not in context.extra_data


def _message_context() -> MessageContext:
    return MessageContext(
        content="你好",
        sender_id="staff-a",
        sender_name="Alice",
        conversation_id="conv-private",
        conversation_type="private",
        is_mention=False,
        raw_message={},
        extra_data={},
    )


@pytest.mark.asyncio
async def test_devices_command_selects_app_execution_target(
    monkeypatch: pytest.MonkeyPatch,
    test_db,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    handler._get_device_mode_model_override = AsyncMock(return_value=(None, None))
    handler._delete_conversation_task_id = AsyncMock()
    get_all_devices = AsyncMock(
        return_value=[
            {
                "device_id": "local-device",
                "execution_target_id": "app-record-1819",
                "name": "APB22015038",
                "status": "online",
            }
        ]
    )
    get_selection = AsyncMock(return_value=DeviceSelection.default())
    set_local_device = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_all_devices",
        get_all_devices,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.model_selection_manager.get_selection",
        AsyncMock(
            return_value=ModelSelection(
                model_name="claude-sonnet",
                model_type="public",
            )
        ),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        get_selection,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.set_local_device",
        set_local_device,
    )
    monkeypatch.setattr(
        channel_selection_service,
        "_available_models",
        lambda _db, _user: [
            {
                "name": "claude-sonnet",
                "displayName": "Claude Sonnet",
                "type": "public",
                "provider": "anthropic",
            }
        ],
    )

    message_context = _message_context()
    await handler._handle_devices_command(
        test_db,
        test_user,
        "1",
        message_context,
    )

    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
        scope=handler._selection_scope(test_user.id, message_context),
    )


@pytest.mark.asyncio
async def test_devices_command_marks_app_execution_target_current(
    monkeypatch: pytest.MonkeyPatch,
    test_db,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    devices = [
        {
            "device_id": "local-device",
            "execution_target_id": "app-record-1819",
            "name": "APB22015038",
            "status": "online",
        }
    ]
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_all_devices",
        AsyncMock(return_value=devices),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        AsyncMock(
            return_value=DeviceSelection(
                device_type=DeviceType.LOCAL,
                device_id="app-record-1819",
                device_name="APB22015038",
            )
        ),
    )

    await handler._handle_devices_command(
        test_db,
        test_user,
        None,
        _message_context(),
    )

    reply = handler.send_text_reply.await_args.args[1]
    assert "APB22015038" in reply
    assert "⭐ 当前" in reply


@pytest.mark.asyncio
async def test_use_chat_detaches_bound_private_task(
    monkeypatch: pytest.MonkeyPatch,
    test_db,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    session = SimpleNamespace(mode=IMSessionMode.TASK, active_task_id=41)
    get_session = AsyncMock(return_value=session)
    set_mode = AsyncMock()
    set_chat_mode = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        AsyncMock(return_value=DeviceSelection(device_type=DeviceType.CLOUD)),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.set_chat_mode",
        set_chat_mode,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.model_selection_manager.get_selection",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.im_session_service.get_session",
        get_session,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.im_session_service.set_mode",
        set_mode,
    )

    message_context = _message_context()
    await handler._handle_use_command(
        test_db,
        test_user,
        "chat",
        message_context,
    )

    set_chat_mode.assert_awaited_once_with(
        test_user.id,
        scope=handler._selection_scope(test_user.id, message_context),
    )
    set_mode.assert_awaited_once_with(
        test_db,
        session=session,
        mode=IMSessionMode.CHAT,
    )


@pytest.mark.asyncio
async def test_device_mode_migrates_legacy_app_selection_before_routing(
    monkeypatch: pytest.MonkeyPatch,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    handler._resolve_new_task_team = AsyncMock(return_value=SimpleNamespace(id=10))
    handler._create_and_process_device_task = AsyncMock(return_value=None)
    route = SimpleNamespace(
        logical_device_id="local-device",
        runtime_device_id="app-record-1819",
        online_info={"status": "online", "socket_id": "socket-1"},
    )
    resolve = AsyncMock(return_value=route)
    set_local_device = AsyncMock(return_value=True)
    db = SimpleNamespace(close=MagicMock())
    monkeypatch.setattr("app.services.channels.handler.SessionLocal", lambda: db)
    monkeypatch.setattr(
        "app.services.device.runtime_route.runtime_route_resolver.resolve",
        resolve,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.set_local_device",
        set_local_device,
    )

    message_context = _message_context()
    await handler._process_device_mode(
        test_user,
        DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="local-device",
            device_name="APB22015038",
        ),
        message_context,
    )

    resolve.assert_awaited_once_with(
        user_id=test_user.id,
        submitted_device_id="local-device",
    )
    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
        scope=handler._selection_scope(test_user.id, message_context),
    )
    assert handler._create_and_process_device_task.await_args.kwargs["device_id"] == (
        "app-record-1819"
    )


@pytest.mark.asyncio
async def test_new_dingtalk_task_prefers_selected_agent(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    selected = SimpleNamespace(id=22)
    db = object()
    message_context = _message_context()
    resolve_selected = AsyncMock(return_value=selected)
    fallback = MagicMock(return_value=SimpleNamespace(id=10))
    monkeypatch.setattr(
        "app.services.channels.team_selection.resolve_selected_team",
        resolve_selected,
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_uses_only_shell_type",
        MagicMock(return_value=True),
    )
    handler._get_task_mode_team = fallback

    team = await handler._resolve_new_task_team(db, 7, message_context)

    assert team is selected
    from app.services.channels.selection_scope import (
        TASK_PROFILE,
        profile_selection_scope,
    )

    expected_scope = profile_selection_scope(
        handler._selection_scope(7, message_context), TASK_PROFILE
    )
    resolve_selected.assert_awaited_once_with(db, 7, scope=expected_scope)
    fallback.assert_not_called()


def test_dingtalk_selection_scope_isolated_by_conversation_and_actor() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    first = _message_context()
    second = _message_context()
    second.conversation_id = "conv-other"
    third = _message_context()
    third.sender_id = "staff-b"

    first_scope = handler._selection_scope(7, first)

    assert first_scope == handler._selection_scope(7, first)
    assert first_scope != handler._selection_scope(7, second)
    assert first_scope != handler._selection_scope(7, third)


@pytest.mark.asyncio
async def test_conversation_task_cache_isolated_by_actor_scope(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    cache_get = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "app.services.channels.handler.cache_manager.get",
        cache_get,
    )
    first = _message_context()
    second = _message_context()
    second.sender_id = "staff-b"

    await handler._get_conversation_task_id(
        first.conversation_id,
        7,
        scope=handler._selection_scope(7, first),
    )
    await handler._get_conversation_task_id(
        second.conversation_id,
        7,
        scope=handler._selection_scope(7, second),
    )

    first_key = cache_get.await_args_list[0].args[0]
    second_key = cache_get.await_args_list[1].args[0]
    assert first_key != second_key


@pytest.mark.asyncio
async def test_cloud_mode_uses_chat_selection_profile(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        AsyncMock(return_value=DeviceSelection(device_type=DeviceType.CLOUD)),
    )

    profile = await handler._selection_profile(
        SimpleNamespace(id=7),
        _message_context(),
        SimpleNamespace(mode=IMSessionMode.CHAT),
    )

    assert profile == "chat"


@pytest.mark.asyncio
async def test_device_mode_uses_task_selection_profile(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        AsyncMock(return_value=DeviceSelection(device_type=DeviceType.LOCAL)),
    )

    profile = await handler._selection_profile(
        SimpleNamespace(id=7),
        _message_context(),
        SimpleNamespace(mode=IMSessionMode.CHAT),
    )

    assert profile == "task"


@pytest.mark.asyncio
async def test_cloud_mode_resolves_chat_agent() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    chat_team = SimpleNamespace(id=11)
    db = object()
    handler._get_selected_or_default_team = AsyncMock(return_value=chat_team)
    handler._resolve_new_task_team = AsyncMock()
    message_context = _message_context()

    team = await handler._resolve_cloud_mode_team(db, 7, message_context)

    assert team is chat_team
    handler._get_selected_or_default_team.assert_awaited_once_with(
        db, 7, message_context
    )
    handler._resolve_new_task_team.assert_not_awaited()


@pytest.mark.asyncio
async def test_cloud_mode_accepts_chat_profile_openai_model() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    user = SimpleNamespace(id=7)
    team = SimpleNamespace(id=11)
    db = MagicMock()
    message_context = _message_context()
    result = SimpleNamespace(
        task=SimpleNamespace(id=41),
        user_subtask=SimpleNamespace(id=42),
        assistant_subtask=SimpleNamespace(id=43),
    )
    handler._get_user_model_override = AsyncMock(return_value=("openai-gpt", "public"))
    handler._is_claude_compatible_override = AsyncMock(return_value=False)
    handler._get_conversation_task_id = AsyncMock(return_value=(None, False))
    handler._set_conversation_task_id = AsyncMock()
    handler._broadcast_user_message_to_web = AsyncMock()
    handler.create_streaming_emitter = AsyncMock(return_value=None)

    with (
        patch(
            "app.services.chat.storage.task_manager.create_task_and_subtasks",
            new=AsyncMock(return_value=result),
        ) as create_task,
        patch("app.services.execution.schedule_dispatch") as schedule_dispatch,
    ):
        response = await handler._create_and_process_cloud_task(
            db=db,
            user=user,
            team=team,
            message_context=message_context,
        )

    assert response is not None
    assert "任务已提交到云端执行队列" in response
    handler._is_claude_compatible_override.assert_not_awaited()
    params = create_task.await_args.kwargs["params"]
    assert params.task_type == "chat"
    assert params.model_id == "openai-gpt"
    assert params.force_override_bot_model is True
    schedule_dispatch.assert_called_once_with(41)


@pytest.mark.asyncio
async def test_private_task_applies_task_profile_model_override(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    team = SimpleNamespace(id=22)
    params = SimpleNamespace(
        device_id=None,
        model_id=None,
        force_override_bot_model=False,
        force_override_bot_model_type=None,
    )
    result = SimpleNamespace(
        task=SimpleNamespace(id=41),
        user_subtask=SimpleNamespace(id=42),
        assistant_subtask=SimpleNamespace(id=43),
    )
    handler._resolve_new_task_team = AsyncMock(return_value=team)
    handler._get_user_model_override = AsyncMock(
        return_value=("claude-sonnet", "public")
    )
    handler._is_claude_compatible_override = AsyncMock(return_value=True)
    handler._build_private_im_message_source = MagicMock(return_value={})
    handler._persist_private_im_task_media = AsyncMock()
    handler._trigger_private_im_task_response = AsyncMock()
    handler.should_merge_task_created_running_notice_with_stream = MagicMock(
        return_value=True
    )
    monkeypatch.setattr(
        "app.services.im.task_continuation_service.build_new_task_params",
        AsyncMock(return_value=params),
    )
    monkeypatch.setattr(
        "app.services.chat.storage.task_manager.create_chat_task",
        AsyncMock(return_value=result),
    )
    bind_active_task = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.session_service.im_session_service.bind_active_task",
        bind_active_task,
    )
    message_context = _message_context()
    user = SimpleNamespace(id=7)
    session = SimpleNamespace()
    db = object()

    await handler._execute_private_im_create_task(
        db=db,
        user=user,
        im_session=session,
        project_id=None,
        message="implement it",
        message_context=message_context,
    )

    assert params.model_id == "claude-sonnet"
    assert params.force_override_bot_model is True
    assert params.force_override_bot_model_type == "public"
    model_scope = handler._get_user_model_override.await_args.kwargs["scope"]
    assert model_scope.endswith(":task")
    bind_active_task.assert_awaited_once_with(db, session=session, task_id=41)


@pytest.mark.asyncio
async def test_agent_change_detaches_only_bound_dingtalk_task(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    db = object()
    session = SimpleNamespace(
        mode=IMSessionMode.TASK,
        active_task_id=41,
    )
    clear_active_task = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.session_service.im_session_service.clear_active_task",
        clear_active_task,
    )

    detached = await handler._after_agent_selection_changed(db, session)

    assert detached is True
    clear_active_task.assert_awaited_once_with(db, session=session)


@pytest.mark.asyncio
async def test_task_status_distinguishes_current_and_next_agent(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    db = object()
    user = SimpleNamespace(id=7)
    session = SimpleNamespace(
        mode=IMSessionMode.TASK,
        active_task_id=41,
        active_runtime_task=None,
    )
    current_team = SimpleNamespace(
        name="old-agent",
        json={"metadata": {"displayName": "Old Agent"}},
    )
    selected_team = SimpleNamespace(
        name="new-agent",
        json={"metadata": {"displayName": "New Agent"}},
    )
    monkeypatch.setattr(
        "app.services.im.task_continuation_service.validate_personal_wework_task",
        MagicMock(return_value=SimpleNamespace(id=41)),
    )
    monkeypatch.setattr(
        "app.services.im.task_continuation_service.get_task_team",
        MagicMock(return_value=current_team),
    )
    monkeypatch.setattr(
        "app.services.channels.team_selection.resolve_selected_team",
        AsyncMock(return_value=selected_team),
    )

    team_info = await handler._get_status_team_info(db, user, session)

    assert "Task 智能体**: New Agent (用户选择)" in team_info
    assert "当前绑定 Task 智能体**: Old Agent" in team_info


@pytest.mark.asyncio
@pytest.mark.parametrize("argument", [None, "missing-agent"])
async def test_agent_list_or_invalid_choice_keeps_bound_task(
    monkeypatch: pytest.MonkeyPatch,
    argument: str | None,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    handler._get_task_mode_team = MagicMock(return_value=None)
    handler._after_agent_selection_changed = AsyncMock()
    monkeypatch.setattr(
        channel_selection_service,
        "list_agents",
        AsyncMock(
            return_value=[
                SelectionOption(
                    value="team:22",
                    label="Available Agent",
                    description="命名空间：default",
                )
            ]
        ),
    )
    session = SimpleNamespace(mode=IMSessionMode.TASK, active_task_id=41)

    await handler._handle_agent_command(
        object(),
        SimpleNamespace(id=7),
        argument,
        _message_context(),
        im_session=session,
    )

    handler._after_agent_selection_changed.assert_not_awaited()
