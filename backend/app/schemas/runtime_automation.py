"""Schemas for Wework local/cloud runtime automations."""

from datetime import datetime
from typing import Any, Dict, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.runtime_work import RuntimeTaskCreateRequest


class CronAutomationSchedule(BaseModel):
    type: Literal["cron"]
    expression: str = Field(..., min_length=5)


class IntervalAutomationSchedule(BaseModel):
    type: Literal["interval"]
    value: int = Field(..., ge=1)
    unit: Literal["minutes", "hours", "days"]


class OneTimeAutomationSchedule(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["one_time"]
    execute_at: datetime = Field(..., alias="executeAt")


AutomationSchedule = Union[
    CronAutomationSchedule,
    IntervalAutomationSchedule,
    OneTimeAutomationSchedule,
]


class RuntimeAutomationMutation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: Optional[str] = None
    version: Optional[int] = None
    source: Literal["cloud"] = "cloud"
    name: str = Field(..., min_length=1, max_length=100)
    description: str = ""
    prompt: str = Field(..., min_length=1)
    schedule: AutomationSchedule = Field(..., discriminator="type")
    timezone: str = "UTC"
    enabled: bool = True
    conversation_mode: Literal["independent", "continue_thread"] = Field(
        "independent",
        alias="conversationMode",
    )
    notification_policy: Literal["all_runs", "attention_only", "never"] = Field(
        "all_runs",
        alias="notificationPolicy",
    )
    task_request: RuntimeTaskCreateRequest = Field(..., alias="taskRequest")
    continuation_payload: Optional[Dict[str, Any]] = Field(
        None,
        alias="continuationPayload",
    )
    continuation_payload: Optional[Dict[str, Any]] = Field(
        None,
        alias="continuationPayload",
    )

    @model_validator(mode="after")
    def require_cloud_device(self) -> "RuntimeAutomationMutation":
        if not self.task_request.device_id:
            raise ValueError("taskRequest.deviceId is required for cloud automations")
        return self


class RuntimeAutomationResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    version: int
    source: Literal["cloud"] = "cloud"
    name: str
    description: str
    prompt: str
    schedule: Dict[str, Any]
    timezone: str
    enabled: bool
    conversation_mode: str = Field(..., alias="conversationMode")
    notification_policy: str = Field(..., alias="notificationPolicy")
    task_request: RuntimeTaskCreateRequest = Field(..., alias="taskRequest")
    next_run_at: Optional[datetime] = Field(None, alias="nextRunAt")
    last_run_at: Optional[datetime] = Field(None, alias="lastRunAt")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")


class RuntimeAutomationListResponse(BaseModel):
    items: list[RuntimeAutomationResponse]


class RuntimeAutomationRunResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    automation_id: str = Field(..., alias="automationId")
    source: Literal["cloud"] = "cloud"
    scheduled_for: datetime = Field(..., alias="scheduledFor")
    trigger: str
    status: str
    task_id: Optional[str] = Field(None, alias="taskId")
    device_id: Optional[str] = Field(None, alias="deviceId")
    error: Optional[str] = None
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")


class RuntimeAutomationRunListResponse(BaseModel):
    items: list[RuntimeAutomationRunResponse]
