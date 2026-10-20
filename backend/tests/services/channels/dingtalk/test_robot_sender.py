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
