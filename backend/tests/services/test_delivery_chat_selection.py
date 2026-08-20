# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import DeliveryChatSelection
from app.services.delivery.service import DeliveryService


def _message(
    project_id: str, item_id: str, message_id: str, content: str
) -> ProjectChatMessage:
    return ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=project_id,
        task_id=item_id,
        sender_type="user",
        sender_id="7",
        sender_name="User",
        message_type="text",
        content=content,
        metadata_json={},
        status="completed",
    )


def test_delivery_chat_selection_supports_all_latest_and_message_ids(
    test_db: Session,
) -> None:
    item = LoopItem(id="ISSUE-1", cloud_project_id="42")
    test_db.add_all(
        [
            _message("42", item.id, "m1", "first"),
            _message("42", item.id, "m2", "second"),
            _message("42", item.id, "m3", "third"),
            _message("other", item.id, "outside", "outside"),
        ]
    )
    test_db.commit()

    all_messages = DeliveryService._select_chat_messages(
        test_db, item, DeliveryChatSelection(mode="all")
    )
    latest = DeliveryService._select_chat_messages(
        test_db, item, DeliveryChatSelection(mode="latest", count=2)
    )
    selected = DeliveryService._select_chat_messages(
        test_db,
        item,
        DeliveryChatSelection(mode="message_ids", message_ids=["m1", "m3"]),
    )

    assert [message["message_id"] for message in all_messages["messages"]] == [
        "m1",
        "m2",
        "m3",
    ]
    assert [message["message_id"] for message in latest["messages"]] == ["m2", "m3"]
    assert [message["message_id"] for message in selected["messages"]] == ["m1", "m3"]


def test_delivery_chat_selection_rejects_unknown_message_ids(test_db: Session) -> None:
    item = LoopItem(id="ISSUE-1", cloud_project_id="42")

    try:
        DeliveryService._select_chat_messages(
            test_db,
            item,
            DeliveryChatSelection(mode="message_ids", message_ids=["missing"]),
        )
    except HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("missing chat message must be rejected")
