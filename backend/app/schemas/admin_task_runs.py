# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for administrator task run statistics."""

from datetime import datetime
from typing import Dict, Optional

from pydantic import BaseModel


class TaskRunFailureReason(BaseModel):
    """Aggregated failure reason for task runs."""

    reason: Optional[str] = None
    count: int
    percentage: float
    latest_at: datetime


class RecentTaskRunFailure(BaseModel):
    """A recent failed assistant run with task context."""

    subtask_id: int
    task_id: int
    task_title: str
    user_id: int
    user_name: Optional[str] = None
    client_origin: str
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class TaskRunStatsResponse(BaseModel):
    """Task run statistics for a bounded creation-time window."""

    hours: int
    window_start: datetime
    window_end: datetime
    total_runs: int
    by_status: Dict[str, int]
    success_rate: float
    failure_rate: float
    failure_reasons: list[TaskRunFailureReason]
    recent_failures: list[RecentTaskRunFailure]
