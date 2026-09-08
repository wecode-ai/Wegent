# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The text Responses contract and explicit native-runtime extensions."""

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, model_validator

from app.schemas.device import DeviceStatusEnum, DeviceType
from app.schemas.openapi_response import ResponseCreateInput, ResponseObject


class WeworkDevice(BaseModel):
    device_id: str
    name: str
    status: DeviceStatusEnum
    device_type: DeviceType = DeviceType.LOCAL
    is_default: bool = False


class WeworkDeviceList(BaseModel):
    object: Literal["list"] = "list"
    data: list[WeworkDevice]


class InputText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["input_text"]
    text: str = Field(min_length=1)


class InputMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message"] = "message"
    role: Literal["user"]
    content: str | list[InputText]


class WeworkExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["wework"]
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
    execution: WeworkExecution | None = None

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
            if not self.execution or not self.execution.device_id:
                raise ValueError(
                    "execution.device_id is required for a new conversation"
                )
        elif self.execution and (self.execution.device_id or self.execution.title):
            raise ValueError(
                "device_id and title can only be set on a new conversation"
            )
        return self


class WeworkResponseObject(ResponseObject):
    conversation: dict[str, str]
    cancellation_requested: bool = False
    is_latest: bool = True


def is_wework_response_id(identifier: str | None) -> bool:
    # Native IDs encode a JSON array, whose base64url prefix is always "Wy".
    # Preserve legacy validation for every other resp_ value, including bad IDs.
    return isinstance(identifier, str) and identifier.startswith("resp_Wy")


def response_execution_type(value: Any) -> str:
    if isinstance(value, WeworkResponseCreate):
        return "wework"
    if isinstance(value, ResponseCreateInput):
        return "wegent"
    if not isinstance(value, dict):
        return "invalid"
    execution = value.get("execution") or {}
    if not isinstance(execution, dict):
        return "invalid"
    if value.get("conversation") or is_wework_response_id(
        value.get("previous_response_id")
    ):
        return "wework"
    return execution.get("type", "wegent")


UnifiedResponseCreate = Annotated[
    Union[
        Annotated[WeworkResponseCreate, Tag("wework")],
        Annotated[ResponseCreateInput, Tag("wegent")],
    ],
    Discriminator(response_execution_type),
]
