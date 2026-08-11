# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the internal cloud-device Nevis IP index API."""

from typing import Optional

from pydantic import BaseModel, Field


class CloudDeviceIpSyncResponse(BaseModel):
    """Aggregate result from one missing Nevis IP synchronization pass."""

    total: int = Field(
        ...,
        description="Cloud devices requiring synchronization",
    )
    persisted: int = Field(
        ...,
        description="Cloud devices updated successfully",
    )
    missing_ip: int = Field(
        ...,
        description="Nevis sandboxes without a valid IP",
    )
    failed: int = Field(..., description="Nevis sandbox requests that failed")
    skipped: bool = Field(
        False,
        description="Whether the synchronization was skipped",
    )
    skip_reason: Optional[str] = Field(
        None,
        description="Why synchronization was skipped",
    )
