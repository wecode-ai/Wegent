# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.channels.model_selection import ModelSelection
from app.services.channels.selection_service import (
    ChannelSelectionService,
    SelectionApplyResult,
    SelectionError,
    SelectionKind,
    SelectionOption,
    resolve_text_choice,
)
from app.services.share.team_share_service import team_share_service


def test_text_choice_only_prefix_matches_explicit_id_aliases():
    options = [
        SelectionOption(
            value="app-record-42",
            label="MacBook",
            aliases=("logical-device",),
            prefix_aliases=("logical-device", "app-record-42"),
        )
    ]

    assert resolve_text_choice(options, "Mac") is None
    assert resolve_text_choice(options, "logical") == options[0]


@pytest.mark.asyncio
async def test_model_options_disable_non_claude_in_device_mode(monkeypatch):
    service = ChannelSelectionService()
    service._available_models = lambda _db, _user: [
        {
            "name": "claude-sonnet",
            "displayName": "Claude Sonnet",
            "type": "public",
            "provider": "anthropic",
        },
        {
            "name": "gpt-5",
            "displayName": "GPT-5",
            "type": "public",
            "provider": "openai",
        },
    ]
    monkeypatch.setattr(
        "app.services.channels.selection_service.model_selection_manager.get_selection",
        AsyncMock(
            return_value=ModelSelection(
                model_name="claude-sonnet",
                model_type="public",
            )
        ),
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service."
        "device_selection_manager.get_selection",
        AsyncMock(
            return_value=DeviceSelection(
                device_type=DeviceType.LOCAL,
                device_id="device-1",
            )
        ),
    )

    options = await service.list_models(object(), SimpleNamespace(id=7))

    assert options[0].is_current is True
    assert options[0].is_disabled is False
    assert options[1].is_disabled is True


@pytest.mark.asyncio
async def test_apply_model_revalidates_and_saves_selection(monkeypatch):
    service = ChannelSelectionService()
    models = [
        {
            "name": "claude-sonnet",
            "displayName": "Claude Sonnet",
            "type": "personal",
            "provider": "anthropic",
        }
    ]
    service._available_models = lambda _db, _user: models
    get_model = AsyncMock(return_value=None)
    save_model = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.channels.selection_service.model_selection_manager.get_selection",
        get_model,
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service.model_selection_manager.set_selection",
        save_model,
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service."
        "device_selection_manager.get_selection",
        AsyncMock(return_value=DeviceSelection.default()),
    )

    result = await service.apply_model(
        object(),
        SimpleNamespace(id=7),
        "personal\0claude-sonnet",
    )

    assert result.selected_label == "Claude Sonnet"
    assert result.changed is True
    saved = save_model.await_args.args[1]
    assert saved.model_name == "claude-sonnet"
    assert saved.model_type == "personal"


@pytest.mark.asyncio
async def test_device_options_use_record_scoped_execution_target(monkeypatch):
    service = ChannelSelectionService()
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "logical-device",
                    "execution_target_id": "app-record-42",
                    "name": "MacBook",
                    "status": "online",
                },
                {
                    "device_id": "offline-device",
                    "name": "Offline PC",
                    "status": "offline",
                },
            ]
        ),
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service."
        "device_selection_manager.get_selection",
        AsyncMock(
            return_value=DeviceSelection(
                device_type=DeviceType.LOCAL,
                device_id="app-record-42",
            )
        ),
    )

    options = await service.list_devices(object(), SimpleNamespace(id=7))

    assert options[0].value == "app-record-42"
    assert options[0].is_current is True
    assert options[1].is_disabled is True


@pytest.mark.asyncio
async def test_apply_device_rejects_offline_snapshot(monkeypatch):
    service = ChannelSelectionService()
    service.list_devices = AsyncMock(
        return_value=[
            SimpleNamespace(
                value="device-1",
                label="Offline PC",
                is_disabled=True,
            )
        ]
    )

    with pytest.raises(SelectionError, match="设备已离线"):
        await service.apply_device(object(), SimpleNamespace(id=7), "device-1")


@pytest.mark.asyncio
async def test_apply_task_validates_owner_and_clears_pending_state(monkeypatch):
    service = ChannelSelectionService()
    task = SimpleNamespace(id=23, name="task-23", json={"spec": {"title": "Fix login"}})

    def validate(_db, _user_id, _task_id):
        return task

    bind = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.selection_service."
        "task_service.validate_personal_wework_task",
        validate,
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service.im_session_service.bind_active_task",
        bind,
    )
    session = SimpleNamespace(active_task_id=11)
    db = object()

    result = await service.apply_task(
        db,
        SimpleNamespace(id=7),
        session,
        "23",
    )

    assert result.selected_label == "Fix login"
    bind.assert_awaited_once_with(db, session=session, task_id=23)


@pytest.mark.asyncio
async def test_agent_options_keep_legacy_numbering_and_offer_card_default(
    monkeypatch,
):
    service = ChannelSelectionService()
    selected = SimpleNamespace(id=22)
    monkeypatch.setattr(
        "app.services.channels.selection_service.resolve_selected_team",
        AsyncMock(return_value=selected),
    )
    monkeypatch.setattr(
        "app.services.adapters.team_kinds.team_kinds_service.get_user_teams",
        MagicMock(
            return_value=[
                {
                    "id": 22,
                    "name": "selected-agent",
                    "displayName": "Selected Agent",
                    "namespace": "default",
                }
            ]
        ),
    )

    text_options = await service.list_agents(object(), SimpleNamespace(id=7))
    card_options = await service.list_agents(
        object(),
        SimpleNamespace(id=7),
        include_default=True,
        default_team=SimpleNamespace(
            name="task-default",
            json={"metadata": {"displayName": "Task Default"}},
        ),
    )

    assert [option.value for option in text_options] == ["team:22"]
    assert [option.value for option in card_options] == ["default", "team:22"]
    assert card_options[0].description == "恢复默认（Task Default）"
    assert card_options[1].is_current is True


@pytest.mark.asyncio
async def test_apply_agent_does_not_report_success_when_redis_save_fails(
    monkeypatch,
):
    service = ChannelSelectionService()
    team = SimpleNamespace(
        id=22,
        name="selected-agent",
        namespace="default",
        json={"metadata": {"displayName": "Selected Agent"}},
    )
    monkeypatch.setattr(
        "app.services.channels.selection_service.resolve_selected_team",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        team_share_service, "get_resource", MagicMock(return_value=team)
    )
    save_selection = AsyncMock(return_value=False)
    monkeypatch.setattr(
        "app.services.channels.selection_service.team_selection_manager.set_selection",
        save_selection,
    )

    with pytest.raises(SelectionError, match="保存失败"):
        await service.apply_agent(
            object(),
            SimpleNamespace(id=7),
            "team:22",
        )

    saved = save_selection.await_args.args[1]
    assert saved.team_id == 22
    assert saved.display_name == "Selected Agent"


@pytest.mark.asyncio
async def test_apply_agent_default_clears_selection(monkeypatch):
    service = ChannelSelectionService()
    monkeypatch.setattr(
        "app.services.channels.selection_service.resolve_selected_team",
        AsyncMock(return_value=SimpleNamespace(id=22)),
    )
    clear_selection = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.selection_service.team_selection_manager.clear_selection",
        clear_selection,
    )

    result = await service.apply_agent(
        object(),
        SimpleNamespace(id=7),
        "default",
        default_team=SimpleNamespace(
            name="task-default",
            json={"metadata": {"displayName": "Task Default"}},
        ),
    )

    assert result == SelectionApplyResult(
        SelectionKind.AGENT,
        "Task Default",
        True,
        restored_default=True,
    )
    clear_selection.assert_awaited_once_with(7)
