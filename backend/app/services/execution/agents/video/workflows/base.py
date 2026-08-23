# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts for workflow-managed video generation."""

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class VideoWorkflowSnapshot:
    """Public state returned by an external video workflow."""

    status: str
    progress: int = 0
    progress_text: str = ""
    card: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def is_completed(self) -> bool:
        return self.status == "completed"

    @property
    def is_failed(self) -> bool:
        return self.status == "failed"

    @property
    def is_partial_ready(self) -> bool:
        return self.status == "partial_ready"


@dataclass(frozen=True)
class VideoWorkflowCreation:
    """Result of creating an external workflow."""

    query_url: str
    snapshot: VideoWorkflowSnapshot
    external_task_id: str | None = None


class VideoWorkflowClient(Protocol):
    """External workflow client used by the shared video poller."""

    async def create(
        self,
        *,
        prompt: str,
        model: str,
        model_display_name: str | None,
        reference_images: list[str | int],
        reference_videos: list[str | int],
        task_id: int,
        subtask_id: int,
        user_id: int,
    ) -> VideoWorkflowCreation:
        """Create a workflow."""

    async def get_status(self, query_url: str) -> VideoWorkflowSnapshot:
        """Fetch the current workflow status."""
