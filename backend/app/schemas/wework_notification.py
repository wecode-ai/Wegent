"""Wework inbox API contracts."""

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_serializer


class NotificationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_id: int = Field(gt=0)
    item_id: str | None = Field(default=None, min_length=1, max_length=128)
    recipient_user_id: int | None = Field(default=None, gt=0)
    title: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1, max_length=10000)


class NotificationView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    title: str
    body: str
    url: str
    payload: dict
    created_at: datetime
    read_at: datetime | None

    @field_serializer("created_at", "read_at")
    def serialize_timestamp(self, value: datetime | None) -> str | None:
        return value.replace(tzinfo=timezone.utc).isoformat() if value else None


class InboxView(BaseModel):
    items: list[NotificationView]
    unread_count: int
    next_offset: int | None
