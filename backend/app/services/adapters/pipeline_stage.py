# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pipeline stage management utilities for pipeline collaboration mode.

This module handles the logic for determining current pipeline stage,
checking if a stage requires confirmation, and managing stage transitions.
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task, Team
from app.services.readers.kinds import KindType, kindReader
from app.services.task_member_service import task_member_service

logger = logging.getLogger(__name__)


class PipelineStageService:
    """
    Service for managing pipeline stage operations.

    Pipeline mode allows multiple bots to execute sequentially, with optional
    confirmation points between stages. This service handles:
    - Determining the current stage index
    - Checking if a stage requires confirmation
    - Managing stage transitions (continue/retry)
    - Getting stage information for display
    """

    def _get_task(self, db: Session, task_id: int) -> Optional[TaskResource]:
        """Get task using unified task_member_service."""
        return task_member_service.get_task(db, task_id)

    def _get_task_crd(self, task: TaskResource) -> Task:
        """Parse task JSON to Task CRD."""
        return Task.model_validate(task.json)

    def _get_bot_by_ref(
        self, db: Session, user_id: int, namespace: str, name: str
    ) -> Optional[Kind]:
        """Get bot using unified kindReader."""
        return kindReader.get_by_name_and_namespace(
            db, user_id, KindType.BOT, namespace, name
        )

    def _get_bot_by_id(self, db: Session, bot_id: int) -> Optional[Kind]:
        """Get bot by ID using unified kindReader."""
        return kindReader.get_by_id(db, KindType.BOT, bot_id)

    def get_current_stage_index(self, db: Session, task_id: int, team_crd: Team) -> int:
        """
        Get the current pipeline stage index from task.spec.currentStage.

        In pipeline mode, the current stage is stored in task.spec.currentStage.
        This is the single source of truth for pipeline stage tracking.

        Args:
            db: Database session
            task_id: Task ID
            team_crd: Team CRD object containing member configuration

        Returns:
            The index of the current stage (0-based), defaults to 0 if not set
        """
        total_stages = len(team_crd.spec.members)
        if total_stages == 0:
            return 0

        task = self._get_task(db, task_id)
        if not task:
            logger.warning(
                f"Pipeline get_current_stage_index: Task not found id={task_id}, "
                f"returning 0"
            )
            return 0

        task_crd = self._get_task_crd(task)
        current_stage = task_crd.spec.currentStage or 0

        # Ensure current_stage doesn't exceed total_stages
        current_stage = min(current_stage, total_stages - 1)

        logger.info(
            f"Pipeline get_current_stage_index: task_id={task_id}, "
            f"currentStage={current_stage} (from task.spec)"
        )

        return current_stage

    def should_stay_at_current_stage(
        self,
        db: Session,
        task_id: int,
        team_crd: Team,
    ) -> tuple[bool, int]:
        """
        Determine if we should stay at the current stage when creating new subtasks.

        In pipeline mode, if the current bot has requireConfirmation, we should
        only create a subtask for the current bot instead of all bots.

        Args:
            db: Database session
            task_id: Task ID
            team_crd: Team CRD object containing member configuration

        Returns:
            Tuple of (should_stay: bool, current_stage_index: int)
        """
        current_stage_index = self.get_current_stage_index(db, task_id, team_crd)

        if current_stage_index >= len(team_crd.spec.members):
            return False, current_stage_index

        current_member = team_crd.spec.members[current_stage_index]
        should_stay = bool(current_member.requireConfirmation)

        if should_stay:
            logger.info(
                f"Pipeline: stage {current_stage_index} ({current_member.botRef.name}) "
                f"has requireConfirmation, staying at current bot"
            )

        return should_stay, current_stage_index

    def get_stage_info(
        self, db: Session, task_id: int, team_crd: Team
    ) -> Dict[str, Any]:
        """
        Get pipeline stage information for a task.

        Uses task.spec.currentStage as the single source of truth for current stage.
        Stage status is determined by task status (PENDING_CONFIRMATION means waiting
        for user confirmation).

        Args:
            db: Database session
            task_id: Task ID
            team_crd: Team CRD object

        Returns:
            Dict with pipeline stage info including:
            - current_stage: Current stage index (0-based)
            - total_stages: Total number of stages
            - current_stage_name: Name of the current stage's bot
            - is_pending_confirmation: Whether waiting for user confirmation
            - stages: List of stage details
        """
        members = team_crd.spec.members
        total_stages = len(members)

        if total_stages == 0:
            return {
                "current_stage": 0,
                "total_stages": 0,
                "current_stage_name": "",
                "is_pending_confirmation": False,
                "stages": [],
            }

        # Get current stage from task.spec.currentStage (single source of truth)
        current_stage = self.get_current_stage_index(db, task_id, team_crd)

        # Get task to check status
        task = self._get_task(db, task_id)

        is_pending_confirmation = False
        is_task_completed = False
        if task:
            task_crd = self._get_task_crd(task)
            task_status = task_crd.status.status if task_crd.status else "PENDING"
            is_pending_confirmation = task_status == "PENDING_CONFIRMATION"
            is_task_completed = task_status == "COMPLETED"

        logger.info(
            f"Pipeline get_stage_info: task_id={task_id}, current_stage={current_stage}, "
            f"total_stages={total_stages}, is_pending_confirmation={is_pending_confirmation}, "
            f"is_task_completed={is_task_completed}"
        )

        # Build stages list based on current_stage and task status
        stages = []
        for i, member in enumerate(members):
            if i < current_stage:
                # Stages before current are completed
                stage_status = "completed"
            elif i == current_stage:
                # Current stage status depends on task status
                if is_task_completed:
                    # Task is completed, all stages including current are completed
                    stage_status = "completed"
                elif is_pending_confirmation:
                    stage_status = "pending_confirmation"
                else:
                    stage_status = "running"
            else:
                # Stages after current are pending
                stage_status = "pending"

            stages.append(
                {
                    "index": i,
                    "name": member.botRef.name,
                    "require_confirmation": member.requireConfirmation or False,
                    "status": stage_status,
                }
            )

        current_stage_name = (
            members[current_stage].botRef.name if current_stage < total_stages else ""
        )

        return {
            "current_stage": current_stage,
            "total_stages": total_stages,
            "current_stage_name": current_stage_name,
            "is_pending_confirmation": is_pending_confirmation,
            "stages": stages,
        }

    def get_team_for_task(
        self, db: Session, task: TaskResource, task_crd: Task
    ) -> Optional[Kind]:
        """
        Get the team associated with a task.

        Uses kindReader which handles all team types:
        - Personal teams (owned by user)
        - Shared teams (via ResourceMember table)
        - Public teams (user_id=0)
        - Group teams (namespace != 'default')

        Args:
            db: Database session
            task: Task resource object
            task_crd: Task CRD object

        Returns:
            Team Kind object or None if not found
        """
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace

        return kindReader.get_by_name_and_namespace(
            db, task.user_id, KindType.TEAM, team_namespace, team_name
        )

    def pipeline_confirm(
        self,
        db: Session,
        task_id: int,
        user_id: int,
    ) -> Dict[str, Any]:
        """
        Prepare for pipeline stage confirmation.

        This method validates the task state and returns information needed
        to proceed with the next stage. It does NOT dispatch the task - that
        is handled by the normal on_chat_send flow.

        This is called from chat:send with action='pipeline:confirm' before
        the normal message processing flow.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID

        Returns:
            Dict with:
            - success: True if ready to proceed
            - next_stage_bot_id: Bot ID for the next stage
            - next_stage_index: Index of the next stage
            - total_stages: Total number of stages
            - next_stage_name: Name of the next stage bot
            - is_pipeline_complete: True if this is the last stage
            - error: Error message if validation failed
        """
        # Get the task
        task = self._get_task(db, task_id)
        if not task:
            logger.error(
                f"[Pipeline] prepare_pipeline_confirm: Task not found id={task_id}"
            )
            return {"success": False, "error": "Task not found"}

        # Check if user is a member of this task
        if not task_member_service.is_member(db, task_id, user_id):
            logger.error(
                f"[Pipeline] prepare_pipeline_confirm: Access denied user={user_id} task={task_id}"
            )
            return {"success": False, "error": "Task not found"}

        task_crd = self._get_task_crd(task)

        # Check task status
        current_status = task_crd.status.status if task_crd.status else "PENDING"
        if current_status != "PENDING_CONFIRMATION":
            logger.error(
                f"[Pipeline] prepare_pipeline_confirm: Task not awaiting confirmation, "
                f"status={current_status}"
            )
            return {
                "success": False,
                "error": f"Task is not awaiting confirmation. Current status: {current_status}",
            }

        # Get the team
        team = self.get_team_for_task(db, task, task_crd)
        if not team:
            logger.error(f"[Pipeline] prepare_pipeline_confirm: Team not found")
            return {"success": False, "error": "Team not found"}

        team_crd = Team.model_validate(team.json)

        # Check if team is pipeline mode
        if team_crd.spec.collaborationModel != "pipeline":
            logger.error(
                f"[Pipeline] prepare_pipeline_confirm: Not a pipeline team, "
                f"collaborationModel={team_crd.spec.collaborationModel}"
            )
            return {
                "success": False,
                "error": "Stage confirmation is only available for pipeline teams",
            }

        # Get current stage info
        stage_info = self.get_stage_info(db, task.id, team_crd)
        current_stage = stage_info["current_stage"]
        next_stage = current_stage + 1
        total_stages = stage_info["total_stages"]

        # Check if pipeline is complete
        if next_stage >= total_stages:
            # Mark task as completed
            task_crd.status.status = "COMPLETED"
            task_crd.status.progress = 100
            task_crd.status.updatedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            task.updated_at = datetime.now()
            task.completed_at = datetime.now()
            flag_modified(task, "json")
            db.commit()

            logger.info(
                f"[Pipeline] prepare_pipeline_confirm: Pipeline completed for task {task_id}"
            )
            return {
                "success": True,
                "is_pipeline_complete": True,
                "next_stage_bot_id": None,
                "next_stage_index": None,
                "total_stages": total_stages,
                "next_stage_name": None,
            }

        # Get current and next stage's bot info
        current_member = team_crd.spec.members[current_stage]
        next_member = team_crd.spec.members[next_stage]

        # Get bots using unified kindReader
        current_bot = self._get_bot_by_ref(
            db,
            team.user_id,
            current_member.botRef.namespace,
            current_member.botRef.name,
        )
        next_bot = self._get_bot_by_ref(
            db,
            team.user_id,
            next_member.botRef.namespace,
            next_member.botRef.name,
        )

        if not next_bot:
            logger.error(
                f"[Pipeline] prepare_pipeline_confirm: Bot not found for next stage: "
                f"{next_member.botRef.namespace}/{next_member.botRef.name}"
            )
            return {"success": False, "error": "Bot not found for next stage"}

        # current_stage_bot_id is used for session management
        # When current_stage_bot_id != next_stage_bot_id, a new session should be created
        current_stage_bot_id = current_bot.id if current_bot else None

        # Update task status to PENDING (ready for next stage)
        # Also update currentStage to track which stage we're at for follow-up questions
        task_crd.status.status = "PENDING"
        task_crd.status.updatedAt = datetime.now()
        task_crd.spec.currentStage = next_stage  # Track current pipeline stage
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        flag_modified(task, "json")
        db.commit()

        logger.info(
            f"[Pipeline] prepare_pipeline_confirm: Updated task currentStage to {next_stage}"
        )

        logger.info(
            f"[Pipeline] prepare_pipeline_confirm: Ready for next stage {next_stage} "
            f"(bot={next_bot.name}, bot_id={next_bot.id}) for task {task_id}"
        )

        return {
            "success": True,
            "is_pipeline_complete": False,
            "current_stage_bot_id": current_stage_bot_id,
            "next_stage_bot_id": next_bot.id,
            "next_stage_index": next_stage,
            "total_stages": total_stages,
            "next_stage_name": next_bot.name,
            "team": team,
            "team_crd": team_crd,
        }

    def should_set_pending_confirmation_on_complete(
        self, db: Session, task_id: int, subtask_id: int
    ) -> bool:
        """
        Determine if task should be set to PENDING_CONFIRMATION instead of COMPLETED.

        In pipeline mode, when a subtask completes and its stage has requireConfirmation=true,
        the task should be set to PENDING_CONFIRMATION to wait for user confirmation
        before proceeding to the next stage.

        Args:
            db: Database session
            task_id: Task ID
            subtask_id: The subtask that just completed

        Returns:
            True if task should be set to PENDING_CONFIRMATION, False otherwise
        """
        try:
            # Get the task
            task = self._get_task(db, task_id)
            if not task:
                return False

            task_crd = self._get_task_crd(task)

            # Get the team
            team = self.get_team_for_task(db, task, task_crd)
            if not team:
                return False

            team_crd = Team.model_validate(team.json)

            # Only applies to pipeline mode
            if team_crd.spec.collaborationModel != "pipeline":
                return False

            # Get the subtask that just completed
            subtask = db.get(Subtask, subtask_id)
            if not subtask or subtask.status != SubtaskStatus.COMPLETED:
                return False

            # Find which stage this subtask belongs to by matching bot_id
            if not subtask.bot_ids:
                return False

            bot_id = subtask.bot_ids[0]
            bot = self._get_bot_by_id(db, bot_id)
            if not bot:
                return False

            # Find the stage index for this bot
            current_stage_index = None
            for i, member in enumerate(team_crd.spec.members):
                if (
                    member.botRef.name == bot.name
                    and member.botRef.namespace == bot.namespace
                ):
                    current_stage_index = i
                    break

            if current_stage_index is None:
                return False

            # Check if this stage has requireConfirmation
            current_member = team_crd.spec.members[current_stage_index]
            if not current_member.requireConfirmation:
                return False

            # Check if there are more stages after this one
            # If this is the last stage, no need for confirmation
            if current_stage_index >= len(team_crd.spec.members) - 1:
                return False

            logger.info(
                f"Pipeline: stage {current_stage_index} ({current_member.botRef.name}) "
                f"completed with requireConfirmation=True, setting task to PENDING_CONFIRMATION"
            )
            return True

        except Exception as e:
            logger.error(
                f"Error checking pipeline confirmation for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    def get_pipeline_info(
        self,
        db: Session,
        team: "Kind",
        task_id: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Get pipeline information for any pipeline mode operation.

        This is the unified method to get pipeline bot_ids based on task.spec.currentStage:
        - New task (task_id=None): use first stage bot_id (stage 0)
        - Existing task: read currentStage from task.spec and get corresponding bot_id

        The currentStage is updated by pipeline_confirm() when user confirms to proceed.

        Args:
            db: Database session
            team: Team Kind object
            task_id: Optional task ID (None for new tasks)

        Returns:
            Dict with pipeline info including bot_ids, or None if not a pipeline team
        """
        team_crd = Team.model_validate(team.json)

        # Only handle pipeline mode teams
        if team_crd.spec.collaborationModel != "pipeline":
            return None

        if not team_crd.spec.members:
            return None

        current_stage = 0

        if task_id:
            # Existing task: read currentStage from task.spec
            task = self._get_task(db, task_id)
            if task:
                task_crd = self._get_task_crd(task)
                # Use currentStage from task spec if set, otherwise default to 0
                current_stage = task_crd.spec.currentStage or 0
                logger.info(
                    f"[Pipeline] get_pipeline_info: task_id={task_id}, currentStage from task.spec={current_stage}"
                )

        # Check if pipeline is complete
        total_stages = len(team_crd.spec.members)
        if current_stage >= total_stages:
            logger.info(
                f"[Pipeline] get_pipeline_info: Pipeline completed (currentStage={current_stage} >= total_stages={total_stages})"
            )
            return {
                "success": True,
                "is_pipeline": True,
                "is_pipeline_complete": True,
                "bot_ids": None,
                "current_stage": current_stage,
                "current_stage_bot_id": None,
                "total_stages": total_stages,
            }

        # Get bot for current stage using unified kindReader
        current_member = team_crd.spec.members[current_stage]
        current_bot = self._get_bot_by_ref(
            db,
            team.user_id,
            current_member.botRef.namespace,
            current_member.botRef.name,
        )

        if not current_bot:
            logger.error(
                f"[Pipeline] get_pipeline_info: Bot not found for stage {current_stage}: "
                f"{current_member.botRef.namespace}/{current_member.botRef.name}"
            )
            return None

        current_stage_bot_id = current_bot.id
        bot_ids = [current_bot.id]

        logger.info(
            f"[Pipeline] get_pipeline_info: stage={current_stage}, bot_id={current_stage_bot_id} ({current_bot.name})"
        )

        return {
            "success": True,
            "is_pipeline": True,
            "bot_ids": bot_ids,
            "current_stage": current_stage,
            "current_stage_bot_id": current_stage_bot_id,
            "total_stages": total_stages,
        }


# Singleton instance
pipeline_stage_service = PipelineStageService()
