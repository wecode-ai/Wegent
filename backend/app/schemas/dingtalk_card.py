# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Card contracts for the DingTalk channel, each optional and independent."""

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

CardField = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)
]

# DingTalk ships this markdown card template — a markdown body plus buttons —
# with its streaming SDK, so a bot can push a card without first drawing one on
# the card platform. It is not the AI card template: that one adds the
# assistant's own feedback row, which a task notification does not want.
BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID = "1366a1eb-bc54-4859-ac88-517c56a9acb1.schema"


class DingTalkChatCardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_id: CardField
    content_key: CardField = "content"
    follow_up_enabled: bool = True
    follow_up_action: CardField = "follow_up"
    follow_up_text_key: CardField = "followUpText"
    follow_up_images_key: CardField = "followUpImages"
    follow_up_status_key: CardField | None = None
    initial_data: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_reserved_fields(self) -> "DingTalkChatCardConfig":
        if self.content_key == "flowStatus":
            raise ValueError("content_key cannot be the AI card state field flowStatus")
        if self.follow_up_text_key == self.follow_up_images_key:
            raise ValueError("Follow-up text and images must use different fields")
        if self.follow_up_status_key in {
            "flowStatus",
            self.content_key,
            self.follow_up_text_key,
            self.follow_up_images_key,
        }:
            raise ValueError("Follow-up status must use a separate field")
        return self


class DingTalkNotificationCardConfig(BaseModel):
    """The AI card a DingTalk channel pushes task notifications as.

    The block is only present when the channel opted into cards; the template
    defaults to DingTalk's built-in one so enabling cards needs no card of the
    operator's own.
    """

    model_config = ConfigDict(extra="forbid")

    template_id: CardField = BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID


def validate_card_config(config: dict[str, Any]) -> dict[str, Any]:
    """An omitted or null card block preserves the channel's default behavior."""

    if config.get("chat_card") is None and config.get("notification_card") is None:
        return config
    config = dict(config)
    if config.get("chat_card") is not None:
        config["chat_card"] = DingTalkChatCardConfig.model_validate(
            config["chat_card"]
        ).model_dump()
    if config.get("notification_card") is not None:
        config["notification_card"] = DingTalkNotificationCardConfig.model_validate(
            config["notification_card"]
        ).model_dump()
    return config
