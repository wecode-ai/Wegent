# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The text Responses contract and explicit native-runtime extensions."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.openapi_response import ResponseObject


class InputText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["input_text"]
    text: str = Field(min_length=1)


class InputMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message"] = "message"
    role: Literal["user"]
    content: str | list[InputText]


class WeworkOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str | None = Field(default=None, min_length=1)
    title: str | None = Field(default=None, min_length=1, max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict = Field(default_factory=dict)


class WeworkResponseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(min_length=1)
    input: str | list[InputMessage]
    conversation: str | None = None
    previous_response_id: str | None = None
    stream: bool = False
    background: bool = False
    wework_options: WeworkOptions = Field(default_factory=WeworkOptions)

    def input_text(self) -> str:
        if isinstance(self.input, str):
            return self.input
        return "\n".join(
            (
                message.content
                if isinstance(message.content, str)
                else "\n".join(part.text for part in message.content)
            )
            for message in self.input
        )

    @model_validator(mode="after")
    def validate_intent(self) -> "WeworkResponseCreate":
        if not self.input_text().strip():
            raise ValueError("input must contain user text")
        if self.conversation and self.previous_response_id:
            raise ValueError(
                "conversation and previous_response_id are mutually exclusive"
            )
        if not self.conversation and not self.previous_response_id:
            if not self.wework_options.device_id:
                raise ValueError(
                    "wework_options.device_id is required for a new conversation"
                )
        elif self.wework_options.device_id or self.wework_options.title:
            raise ValueError(
                "device_id and title can only be set on a new conversation"
            )
        return self


class WeworkResponseObject(ResponseObject):
    conversation: dict[str, str]
    cancellation_requested: bool = False
    is_latest: bool = True
