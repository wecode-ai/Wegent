# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base class for polling agents.

Polling agents handle long-running tasks that require:
1. Creating a job/task
2. Polling for progress
3. Streaming results on completion
"""

from abc import ABC, abstractmethod

from shared.models import ExecutionRequest

from ..emitters import ResultEmitter


class PollingAgent(ABC):
    """Base class for polling mode agents.

    All polling agents must implement the execute method which handles
    the full lifecycle of a long-running task.
    """

    @abstractmethod
    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """
        Execute the agent task.

        Args:
            request: Execution request containing task configuration
            emitter: Result emitter for streaming events to frontend
        """
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Agent name for logging and identification."""
        pass
