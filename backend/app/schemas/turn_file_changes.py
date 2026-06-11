# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for per-turn coding file changes."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TurnFileChangeItem(BaseModel):
    """One file changed during an agent turn."""

    model_config = ConfigDict(extra="forbid")

    old_path: str | None = None
    path: str = Field(min_length=1)
    change_type: Literal["created", "modified", "deleted", "renamed"]
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)
    binary: bool = False


class TurnFileChangesSummary(BaseModel):
    """Persisted lightweight summary for a turn patch artifact."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    status: Literal["active", "reverted", "conflicted", "artifact_missing"]
    artifact_id: str = Field(min_length=1)
    device_id: str = Field(min_length=1)
    workspace_path: str = Field(min_length=1)
    file_count: int = Field(ge=0)
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)
    files: list[TurnFileChangeItem]
    reverted_at: datetime | None = None


class TurnFileChangesDiffResponse(BaseModel):
    """Validated unified diff returned from the owning device."""

    subtask_id: int
    diff: str


class TurnFileChangesRevertResponse(BaseModel):
    """Updated summary returned after an idempotent revert."""

    subtask_id: int
    file_changes: TurnFileChangesSummary
