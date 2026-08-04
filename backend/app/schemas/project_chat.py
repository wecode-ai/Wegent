# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wire schemas for shared Wework project chat."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ProjectChatSchema(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class ProjectChatAgentCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=100)
    runtime: Literal["codex"] = "codex"
    model: str | None = Field(default=None, max_length=255)
    system_prompt: str = Field(default="", max_length=20_000)


class ProjectChatAgentUpdate(ProjectChatSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=255)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    status: Literal["active", "archived"] | None = None


class ProjectChatAgentView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    runtime: Literal["codex"]
    model: str | None
    system_prompt: str
    status: Literal["active", "archived"]
    version: int
    created_at: str
    updated_at: str


class ProjectChatMention(ProjectChatSchema):
    type: Literal["user", "agent"]
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=255)


class ProjectChatSend(ProjectChatSchema):
    client_message_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    content: str = Field(min_length=1, max_length=100_000)
    mentions: list[ProjectChatMention] = Field(default_factory=list, max_length=64)


class ProjectChatSubscribe(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    after_sequence: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=500)


class ProjectChatAgentStart(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    trigger_message_id: str = Field(min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=128)
    runtime_device_id: str = Field(min_length=1, max_length=255)
    runtime_task_id: str = Field(min_length=1, max_length=255)


class ProjectChatAgentFailure(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    message_id: str = Field(min_length=1, max_length=64)
    error: str | None = Field(default=None, max_length=2_000)


class ProjectChatMessageView(ProjectChatSchema):
    sequence_number: int
    message_id: str
    client_message_id: str | None
    project_id: str
    task_id: str | None
    sender: dict[str, str]
    type: str
    content: str
    metadata: dict[str, Any]
    trigger_message_id: str | None
    agent_id: str | None
    runtime_address: dict[str, str] | None
    status: str
    created_at: str
    updated_at: str
