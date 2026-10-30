# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.schemas.subscription import NotificationLevel
from app.services.subscription import notification_dispatcher


class _FakeQuery:
    def __init__(self, results):
        self._results = results

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._results.pop(0)


class _FakeDB:
    def __init__(self, results):
        self._results = results

    def query(self, _model):
        return _FakeQuery(self._results)


def _dingtalk_channel() -> SimpleNamespace:
    return SimpleNamespace(
        id=9,
        json={
            "spec": {
                "channelType": "dingtalk",
                "config": {
                    "client_id": "client",
                    "client_secret": "encrypted",
                    "card_template_id": "template",
                },
            }
        },
    )


@pytest.mark.asyncio
async def test_dispatch_passes_silent_control_without_leaking_marker(monkeypatch):
    binding = SimpleNamespace(sender_staff_id="staff-1", sender_id="sender-1")
    send_dingtalk = AsyncMock()

    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_followers_with_settings",
        lambda *_args, **_kwargs: [
            (
                42,
                SimpleNamespace(
                    notification_level=NotificationLevel.NOTIFY,
                    notification_channel_ids=[9],
                ),
            )
        ],
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_user_im_bindings",
        lambda *_args, **_kwargs: {"9": binding},
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_subscription_channel_binding_config",
        lambda *_args, **_kwargs: {
            "bind_private": True,
            "bind_group": True,
            "group_conversation_id": "conversation-1",
        },
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_dispatcher,
        "_send_dingtalk_notification",
        send_dingtalk,
    )

    db = _FakeDB([SimpleNamespace(user_id=42), _dingtalk_channel()])
    await notification_dispatcher.subscription_notification_dispatcher.dispatch_execution_notifications(
        db,
        subscription_id=1,
        execution_id=2,
        subscription_display_name="Daily alert",
        result_summary="Nothing changed today.\n[静默]\n\n【@列表：】",
        status="COMPLETED",
    )

    send_dingtalk.assert_awaited_once()
    kwargs = send_dingtalk.await_args.kwargs
    assert kwargs["message"] == "Nothing changed today."
    assert kwargs["group_silent"] is True
    assert kwargs["directive_mention_user_ids"] == []


@pytest.mark.asyncio
async def test_dispatch_passes_per_message_mentions(monkeypatch):
    binding = SimpleNamespace(sender_staff_id="staff-1", sender_id="sender-1")
    send_dingtalk = AsyncMock()

    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_followers_with_settings",
        lambda *_args, **_kwargs: [
            (
                42,
                SimpleNamespace(
                    notification_level=NotificationLevel.NOTIFY,
                    notification_channel_ids=[9],
                ),
            )
        ],
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_user_im_bindings",
        lambda *_args, **_kwargs: {"9": binding},
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_subscription_channel_binding_config",
        lambda *_args, **_kwargs: {
            "bind_private": True,
            "bind_group": True,
            "group_conversation_id": "conversation-1",
        },
    )
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_dispatcher,
        "_send_dingtalk_notification",
        send_dingtalk,
    )

    db = _FakeDB([SimpleNamespace(user_id=42), _dingtalk_channel()])
    await notification_dispatcher.subscription_notification_dispatcher.dispatch_execution_notifications(
        db,
        subscription_id=1,
        execution_id=2,
        subscription_display_name="Daily alert",
        result_summary="Alert needs attention.\n\n[@列表:900101,900102]",
        status="COMPLETED",
    )

    send_dingtalk.assert_awaited_once()
    kwargs = send_dingtalk.await_args.kwargs
    assert kwargs["message"] == "Alert needs attention."
    assert kwargs["group_silent"] is False
    assert kwargs["directive_mention_user_ids"] == ["900101", "900102"]


@pytest.mark.asyncio
async def test_silent_control_skips_only_group_card(monkeypatch):
    calls = []

    class _FakeSender:
        def __init__(self, **_kwargs):
            pass

        async def send_ai_card_notification(self, **kwargs):
            calls.append(kwargs)
            return {"success": True, "outTrackId": "track-1"}

    monkeypatch.setattr(
        "shared.utils.crypto.decrypt_sensitive_data", lambda _value: "secret"
    )
    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender", _FakeSender
    )

    await notification_dispatcher.subscription_notification_dispatcher._send_dingtalk_notification(
        db=None,
        channel=_dingtalk_channel(),
        binding=SimpleNamespace(sender_staff_id="staff-1", sender_id="sender-1"),
        user_id=42,
        message="Nothing changed today.",
        subscription_id=1,
        execution_id=2,
        subscription_display_name="Daily alert",
        send_private=True,
        send_group=True,
        group_conversation_id="conversation-1",
        group_silent=True,
    )

    assert len(calls) == 1
    assert "open_space_id" not in calls[0]


@pytest.mark.asyncio
async def test_per_message_mentions_reach_group_card(monkeypatch):
    calls = []

    class _FakeSender:
        def __init__(self, **_kwargs):
            pass

        async def send_ai_card_notification(self, **kwargs):
            calls.append(kwargs)
            return {"success": True, "outTrackId": "track-1"}

    async def resolve_mentions(_db, _values):
        return ["900101:张三", "900102:李四"]

    monkeypatch.setattr(
        "shared.utils.crypto.decrypt_sensitive_data", lambda _value: "secret"
    )
    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender", _FakeSender
    )
    monkeypatch.setattr(
        notification_dispatcher, "_resolve_dingtalk_mention_user_ids", resolve_mentions
    )

    await notification_dispatcher.subscription_notification_dispatcher._send_dingtalk_notification(
        db=None,
        channel=_dingtalk_channel(),
        binding=SimpleNamespace(sender_staff_id="staff-1", sender_id="sender-1"),
        user_id=42,
        message="Alert needs attention.",
        subscription_id=1,
        execution_id=2,
        subscription_display_name="Daily alert",
        send_private=False,
        send_group=True,
        group_conversation_id="conversation-1",
        directive_mention_user_ids=["900101", "900102"],
    )

    assert len(calls) == 1
    assert calls[0]["open_space_id"] == "dtv1.card//IM_GROUP.conversation-1"
    assert calls[0]["mention_user_ids"] == ["900101:张三", "900102:李四"]


@pytest.mark.asyncio
async def test_webhook_payload_drops_controls_without_treating_silence_as_group(
    monkeypatch,
):
    send_webhook = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_dispatcher,
        "_send_webhook_notification",
        send_webhook,
    )

    result = await notification_dispatcher.subscription_notification_dispatcher.dispatch_webhook_notifications(
        webhooks=[
            SimpleNamespace(
                enabled=True,
                type=SimpleNamespace(value="custom"),
                url="https://example.test",
                secret=None,
            )
        ],
        subscription_display_name="Daily alert",
        result_summary="Nothing changed today.\n\n[静默] [@列表:900101]",
        status="COMPLETED",
        execution_id=2,
    )

    send_webhook.assert_awaited_once()
    assert send_webhook.await_args.kwargs["result_summary"] == "Nothing changed today."
    assert result["success_count"] == 1
