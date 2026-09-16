# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Optional chat-card contract, independent of notification templates."""

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

CardField = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)
]


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


def validate_chat_card_config(config: dict[str, Any]) -> dict[str, Any]:
    """An omitted or null chat_card preserves the built-in response behavior."""
    if config.get("chat_card") is not None:
        config = dict(config)
        config["chat_card"] = DingTalkChatCardConfig.model_validate(
            config["chat_card"]
        ).model_dump()
    return config
