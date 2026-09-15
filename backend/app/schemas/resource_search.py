"""Search responses for managed resources."""

from typing import Any, Literal

from pydantic import BaseModel, Field


class ResourceSearchResponse(BaseModel):
    resource_type: Literal["agent"] = "agent"
    items: list[dict[str, Any]] = Field(default_factory=list)
    has_more: bool = False
    next_cursor: str | None = None
    limit: int
