# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for local Codex thread discovery and binding."""

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class LocalCodexThreadSummary(BaseModel):
    """Summary of a local Codex thread discovered on a device."""

    model_config = ConfigDict(populate_by_name=True)

    thread_id: str = Field(..., alias="threadId")
    title: str
    cwd: Optional[str] = None
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    archived: bool = False
    running: bool = False


class LocalCodexBindRequest(BaseModel):
    """Request to bind a local Codex thread to a Wework task."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    thread_id: str = Field(..., alias="threadId", min_length=1)
    team_id: int = Field(..., alias="teamId")
    title: Optional[str] = None
    cwd: Optional[str] = None


class LocalCodexBindResponse(BaseModel):
    """Response after binding or reusing a local Codex thread task."""

    model_config = ConfigDict(populate_by_name=True)

    task_id: int = Field(..., alias="taskId")
    task: dict
    created: bool
    thread_id: str = Field(..., alias="threadId")
    device_id: str = Field(..., alias="deviceId")


class LocalCodexThreadListResponse(BaseModel):
    """Response for local Codex thread discovery."""

    threads: list[LocalCodexThreadSummary]
