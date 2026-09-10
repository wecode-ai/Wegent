# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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

    await handler._handle_devices_command(
        test_db,
        test_user,
        "1",
        _message_context(),
    )

    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
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

    await handler._process_device_mode(
        test_user,
        DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="local-device",
            device_name="APB22015038",
        ),
        _message_context(),
    )

    resolve.assert_awaited_once_with(
        user_id=test_user.id,
        submitted_device_id="local-device",
    )
    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
    )
    assert handler._create_and_process_device_task.await_args.kwargs["device_id"] == (
        "app-record-1819"
    )


@pytest.mark.asyncio
async def test_new_dingtalk_task_prefers_selected_agent(monkeypatch) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    selected = SimpleNamespace(id=22)
    db = object()
    resolve_selected = AsyncMock(return_value=selected)
    fallback = MagicMock(return_value=SimpleNamespace(id=10))
    monkeypatch.setattr(
        "app.services.channels.team_selection.resolve_selected_team",
        resolve_selected,
    )
    handler._get_task_mode_team = fallback

    team = await handler._resolve_new_task_team(db, 7)

    assert team is selected
    resolve_selected.assert_awaited_once_with(db, 7)
    fallback.assert_not_called()


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

    assert "当前 Task 智能体**: Old Agent" in team_info
    assert "下一新任务智能体**: New Agent (用户选择)" in team_info


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
