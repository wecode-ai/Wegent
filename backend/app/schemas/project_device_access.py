"""Owner-controlled use of one device inside a project."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator


class ProjectDeviceAccess(BaseModel):
    scope: Literal["owner", "project", "members"] = "owner"
    member_ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(
        default_factory=list, max_length=1000
    )

    @model_validator(mode="after")
    def normalize_members(self) -> "ProjectDeviceAccess":
        self.member_ids = sorted(set(self.member_ids))
        if self.scope == "members" and not self.member_ids:
            raise ValueError("Select at least one project member")
        if self.scope != "members" and self.member_ids:
            raise ValueError("Only a member-scoped policy can select members")
        return self


class ProjectDeviceAccessChange(ProjectDeviceAccess):
    device_id: int = Field(gt=0)
    preview_only: bool = False
    confirmation_token: str | None = Field(default=None, max_length=64)


class ProjectDeviceAccessPreview(BaseModel):
    affected_execution_count: int
    affected_agent_count: int
    confirmation_token: str
