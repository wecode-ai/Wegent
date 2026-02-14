# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Collaboration mode strategy pattern for task status updates.

This module provides a strategy pattern implementation for handling
different collaboration modes (pipeline, route, coordinate, collaborate)
when updating task status after subtask completion.
"""

import logging
from abc import ABC, abstractmethod
from typing import Optional, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class CollaborationStrategy(ABC):
    """Abstract base class for collaboration mode strategies.

    Each collaboration mode can have different rules for determining
    the final task status when a subtask completes.
    """

    @abstractmethod
    def get_task_status_on_subtask_complete(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        subtask_status: str,
    ) -> Tuple[str, Optional[int]]:
        """Determine the task status when a subtask completes.

        Args:
            db: Database session
            task_id: Task ID
            subtask_id: The subtask that just completed
            subtask_status: The status of the completed subtask

        Returns:
            Tuple of (task_status, progress):
                - task_status: The status to set for the task
                - progress: Optional progress value (0-100), None to keep current
        """
        pass


class DefaultCollaborationStrategy(CollaborationStrategy):
    """Default strategy for non-pipeline collaboration modes.

    This strategy simply maps subtask status to task status directly:
    - COMPLETED -> COMPLETED
    - FAILED -> FAILED
    - CANCELLED -> CANCELLED
    - RUNNING -> RUNNING
    """

    def get_task_status_on_subtask_complete(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        subtask_status: str,
    ) -> Tuple[str, Optional[int]]:
        """Map subtask status directly to task status."""
        status_map = {
            "COMPLETED": ("COMPLETED", 100),
            "CANCELLED": ("CANCELLED", 100),
            "FAILED": ("FAILED", None),
            "RUNNING": ("RUNNING", None),
        }

        if subtask_status in status_map:
            return status_map[subtask_status]

        # Default: keep the subtask status
        return (subtask_status, None)


class PipelineCollaborationStrategy(CollaborationStrategy):
    """Strategy for pipeline collaboration mode.

    In pipeline mode, when a subtask completes and its stage has
    requireConfirmation=true, the task should be set to PENDING_CONFIRMATION
    instead of COMPLETED to wait for user confirmation before proceeding
    to the next stage.
    """

    def get_task_status_on_subtask_complete(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        subtask_status: str,
    ) -> Tuple[str, Optional[int]]:
        """Determine task status with pipeline confirmation logic."""
        # For non-COMPLETED statuses, use default behavior
        if subtask_status != "COMPLETED":
            status_map = {
                "CANCELLED": ("CANCELLED", 100),
                "FAILED": ("FAILED", None),
                "RUNNING": ("RUNNING", None),
            }
            if subtask_status in status_map:
                return status_map[subtask_status]
            return (subtask_status, None)

        # For COMPLETED status, check if confirmation is required
        if self._should_require_confirmation(db, task_id, subtask_id):
            logger.info(
                f"[PipelineStrategy] Task {task_id} requires confirmation, "
                f"setting status to PENDING_CONFIRMATION"
            )
            return ("PENDING_CONFIRMATION", 100)

        return ("COMPLETED", 100)

    def _should_require_confirmation(
        self, db: Session, task_id: int, subtask_id: int
    ) -> bool:
        """Check if the completed subtask's stage requires confirmation.

        Args:
            db: Database session
            task_id: Task ID
            subtask_id: The subtask that just completed

        Returns:
            True if confirmation is required, False otherwise
        """
        from app.services.adapters.pipeline_stage import pipeline_stage_service

        return pipeline_stage_service.should_set_pending_confirmation_on_complete(
            db, task_id, subtask_id
        )


class CollaborationStrategyFactory:
    """Factory for creating collaboration strategy instances."""

    _strategies = {
        "pipeline": PipelineCollaborationStrategy,
        "route": DefaultCollaborationStrategy,
        "coordinate": DefaultCollaborationStrategy,
        "collaborate": DefaultCollaborationStrategy,
    }

    @classmethod
    def get_strategy(cls, collaboration_model: str) -> CollaborationStrategy:
        """Get the appropriate strategy for a collaboration model.

        Args:
            collaboration_model: The collaboration model name

        Returns:
            CollaborationStrategy instance for the given model
        """
        strategy_class = cls._strategies.get(
            collaboration_model, DefaultCollaborationStrategy
        )
        return strategy_class()

    @classmethod
    def get_strategy_for_task(cls, db: Session, task_id: int) -> CollaborationStrategy:
        """Get the appropriate strategy for a task based on its team's collaboration model.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            CollaborationStrategy instance for the task's team
        """
        from app.models.kind import Kind
        from app.models.task import TaskResource
        from app.schemas.kind import Task, Team

        try:
            # Get the task
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active.is_(True),
                )
                .first()
            )
            if not task:
                return DefaultCollaborationStrategy()

            task_crd = Task.model_validate(task.json)

            # Get the team
            team_ref = task_crd.spec.teamRef
            team = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Team",
                    Kind.name == team_ref.name,
                    Kind.namespace == team_ref.namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )
            if not team:
                return DefaultCollaborationStrategy()

            team_crd = Team.model_validate(team.json)
            collaboration_model = team_crd.spec.collaborationModel

            logger.debug(
                f"[CollaborationStrategyFactory] Task {task_id} uses "
                f"collaboration model: {collaboration_model}"
            )

            return cls.get_strategy(collaboration_model)

        except Exception as e:
            logger.error(
                f"[CollaborationStrategyFactory] Error getting strategy for task {task_id}: {e}",
                exc_info=True,
            )
            return DefaultCollaborationStrategy()
