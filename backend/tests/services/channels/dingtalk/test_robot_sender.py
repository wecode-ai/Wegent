import asyncio

from app.services.channels.dingtalk.sender import DingTalkRobotSender


def test_group_card_payload_includes_requested_mentions() -> None:
    """Group cards send mention IDs using DingTalk's map contract."""
    sender = DingTalkRobotSender("client-id", "client-secret")

    payload = sender._card_payload(
        out_track_id="track-1",
        card_template_id="template-1",
        card_param_map={"title": "Daily report"},
        open_space_id="dtv1.card//IM_GROUP.group-1",
        preview="Daily report",
        mention_user_ids=["user-1", " user-2 ", "user-1"],
    )

    assert payload["imGroupOpenDeliverModel"]["atUserIds"] == {
        "user-1": "user-1",
        "user-2": "user-2",
    }


def test_group_card_payload_omits_empty_mentions() -> None:
    """Group cards omit the mention field when no user IDs are configured."""
    sender = DingTalkRobotSender("client-id", "client-secret")

    payload = sender._card_payload(
        out_track_id="track-1",
        card_template_id="template-1",
        card_param_map={"title": "Daily report"},
        open_space_id="dtv1.card//IM_GROUP.group-1",
        preview="Daily report",
    )

    assert "atUserIds" not in payload["imGroupOpenDeliverModel"]


def test_group_card_payload_uses_staff_display_names() -> None:
    """Staff IDs map to display names in DingTalk's mention contract."""
    sender = DingTalkRobotSender("client-id", "client-secret")

    payload = sender._card_payload(
        out_track_id="track-1",
        card_template_id="template-1",
        card_param_map={"title": "Daily report"},
        open_space_id="dtv1.card//IM_GROUP.group-1",
        preview="Daily report",
        mention_user_ids=["41068:陈波", " 220750:李四 ", "41068:重复"],
    )

    assert payload["imGroupOpenDeliverModel"]["atUserIds"] == {
        "41068": "陈波",
        "220750": "李四",
    }


def test_group_card_content_prepends_visible_mentions(monkeypatch) -> None:
    """Group card content makes configured mentions visible to readers."""
    sender = DingTalkRobotSender("client-id", "client-secret")
    captured = {}

    async def fake_send_card(**kwargs):
        captured.update(kwargs)
        return {"success": True, "outTrackId": "track-1"}

    async def fake_mark_finished(**kwargs):
        return None

    monkeypatch.setattr(sender, "send_card", fake_send_card)
    monkeypatch.setattr(sender, "_mark_card_finished", fake_mark_finished)

    result = asyncio.run(
        sender.send_ai_card_notification(
            user_id="group",
            title="Daily report",
            content="Build failed",
            card_template_id="template-1",
            open_space_id="dtv1.card//IM_GROUP.group-1",
            mention_user_ids=["41068:陈波"],
        )
    )

    assert result["success"] is True
    assert captured["card_param_map"]["content"] == "@陈波\n\nBuild failed"
    assert captured["mention_user_ids"] == ["41068:陈波"]


def test_group_card_drops_unresolved_staff_ids(monkeypatch) -> None:
    """Staff IDs without a display name never render as raw @ mentions."""
    sender = DingTalkRobotSender("client-id", "client-secret")
    captured = {}

    async def fake_send_card(**kwargs):
        captured.update(kwargs)
        return {"success": True, "outTrackId": "track-1"}

    async def fake_mark_finished(**kwargs):
        return None

    monkeypatch.setattr(sender, "send_card", fake_send_card)
    monkeypatch.setattr(sender, "_mark_card_finished", fake_mark_finished)

    asyncio.run(
        sender.send_ai_card_notification(
            user_id="group",
            title="Daily report",
            content="Build failed",
            card_template_id="template-1",
            open_space_id="dtv1.card//IM_GROUP.group-1",
            mention_user_ids=["41068:陈波", "220750"],
        )
    )

    assert captured["card_param_map"]["content"] == "@陈波\n\nBuild failed"
    assert captured["mention_user_ids"] == ["41068:陈波"]
