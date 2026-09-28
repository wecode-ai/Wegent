"""Compact execution facts reported by an authenticated device owner."""

from typing import Literal

from pydantic import Field

from app.schemas.project_chat import ProjectChatSchema


class RuntimeExecutionTurnSnapshot(ProjectChatSchema):
    id: str = Field(min_length=1, max_length=255)
    user_message_ids: list[str] = Field(default_factory=list, max_length=100)
    status: Literal["done", "failed", "cancelled", "running", "unknown"]
    completed_at: str | int | float | None = None


class RuntimeExecutionSnapshot(ProjectChatSchema):
    device_id: str = Field(min_length=1, max_length=255)
    task_id: str = Field(min_length=1, max_length=255)
    running: bool | None = None
    complete_history: bool = False
    turns: list[RuntimeExecutionTurnSnapshot] = Field(max_length=1000)
