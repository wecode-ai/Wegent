# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pipeline stage management utilities for pipeline collaboration mode.

This module handles the logic for determining current pipeline stage,
checking if a stage requires confirmation, and managing stage transitions.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.shared_team import SharedTeam
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task, Team

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

    def get_current_stage_index(
        self, existing_subtasks: List[Subtask], team_crd: Team, db: Session = None
    ) -> Optional[int]:
        """
        Get the current pipeline stage index based on existing subtasks.

        In pipeline mode, the current stage is determined by the most recent
        assistant subtask's bot. This method finds the last assistant subtask
        and maps its bot_id to the corresponding stage index in team members.

        Args:
            existing_subtasks: List of existing subtasks, ordered by message_id desc
            team_crd: Team CRD object containing member configuration
            db: Optional database session for bot lookup (required for accurate stage detection)

        Returns:
            The index of the current stage (0-based), or None if no existing subtasks
        """
        if not existing_subtasks:
            return None

        total_stages = len(team_crd.spec.members)
        if total_stages == 0:
            return None

        # Find the most recent assistant subtask (existing_subtasks is ordered by message_id desc)
        last_assistant = None
        for s in existing_subtasks:
            if s.role == SubtaskRole.ASSISTANT:
                last_assistant = s
                break

        if not last_assistant:
            return None

        logger.info(
            f"Pipeline get_current_stage_index: last_assistant={last_assistant.id}, "
            f"status={last_assistant.status.value}, bot_ids={last_assistant.bot_ids}"
        )

        # Determine stage index from bot_id
        if last_assistant.bot_ids and db:
            bot_id = last_assistant.bot_ids[0]
            # Find the bot and match it to team members
            bot = (
                db.query(Kind)
                .filter(
                    Kind.id == bot_id,
                    Kind.kind == "Bot",
                    Kind.is_active.is_(True),
                )
                .first()
            )
            if bot:
                for i, member in enumerate(team_crd.spec.members):
                    if (
                        member.botRef.name == bot.name
                        and member.botRef.namespace == bot.namespace
                    ):
                        logger.info(
                            f"Pipeline get_current_stage_index: determined stage_index={i} "
                            f"from bot {bot.name}"
                        )
                        return i

        # Fallback: return 0 if we can't determine the stage
        logger.warning(
            f"Pipeline get_current_stage_index: could not determine stage from bot_id, "
            f"falling back to 0"
        )
        return 0

    def should_stay_at_current_stage(
        self,
        existing_subtasks: List[Subtask],
        team_crd: Team,
        db: Session = None,
    ) -> tuple[bool, Optional[int]]:
        """
        Determine if we should stay at the current stage when creating new subtasks.

        In pipeline mode, if the current bot has requireConfirmation, we should
        only create a subtask for the current bot instead of all bots.

        Args:
            existing_subtasks: List of existing subtasks, ordered by message_id desc
            team_crd: Team CRD object containing member configuration
            db: Optional database session for bot lookup

        Returns:
            Tuple of (should_stay: bool, current_stage_index: Optional[int])
        """
        current_stage_index = self.get_current_stage_index(
            existing_subtasks, team_crd, db
        )

        if current_stage_index is None or current_stage_index >= len(
            team_crd.spec.members
        ):
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

        # Get all subtasks for this task, ordered by message_id descending
        # We need both USER and ASSISTANT subtasks to properly identify conversation rounds
        all_subtasks = (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id)
            .order_by(Subtask.message_id.desc())
            .all()
        )

        # Determine current stage based on subtask statuses
        current_stage = 0
        is_pending_confirmation = False

        # Get the most recent conversation round's assistant subtasks
        # A conversation round starts with a USER subtask, followed by ASSISTANT subtasks
        # We need to find the assistant subtasks from the most recent round only
        recent_round_assistants = []
        for subtask in all_subtasks:
            if subtask.role == SubtaskRole.USER:
                # Found the start of the most recent round, stop collecting
                break
            if subtask.role == SubtaskRole.ASSISTANT:
                recent_round_assistants.append(subtask)

        # Reverse to get chronological order (oldest first within this round)
        recent_round_assistants.reverse()

        # Debug log
        logger.info(
            f"Pipeline get_stage_info: task_id={task_id}, total_stages={total_stages}, "
            f"recent_round_assistants_count={len(recent_round_assistants)}, "
            f"statuses=[{', '.join([f'{s.id}:{s.status.value}' for s in recent_round_assistants])}]"
        )

        # In pipeline mode with requireConfirmation, the most recent round may only have
        # subtasks for the current stage (not all stages). We need to determine which
        # stage these subtasks belong to.
        #
        # Strategy: Match subtasks to stages by bot_id
        # Each stage has a specific bot, so we can identify which stage a subtask belongs to
        # by checking its bot_ids against the team members' bot references.

        # Build a mapping from bot name to stage index
        bot_name_to_stage: Dict[str, int] = {}
        for i, member in enumerate(members):
            bot_name_to_stage[member.botRef.name] = i

        # Get bot names for each subtask in the recent round
        # We need to query the Bot kind to get the bot name from bot_id
        # For follow-up scenarios, we need to look at ALL subtasks (not just recent round)
        # to get the correct stage status. A stage that was COMPLETED should stay COMPLETED
        # even if a new PENDING subtask is created for follow-up.
        stage_subtask_map: Dict[int, Subtask] = {}  # stage_index -> subtask

        # First, build map from all assistant subtasks (to get historical completed states)
        all_assistant_subtasks = [
            s for s in all_subtasks if s.role == SubtaskRole.ASSISTANT
        ]
        for subtask in all_assistant_subtasks:
            if subtask.bot_ids:
                bot = (
                    db.query(Kind)
                    .filter(
                        Kind.id == subtask.bot_ids[0],
                        Kind.kind == "Bot",
                        Kind.is_active.is_(True),
                    )
                    .first()
                )
                if bot and bot.name in bot_name_to_stage:
                    stage_idx = bot_name_to_stage[bot.name]
                    # Only update if:
                    # 1. No existing entry for this stage, OR
                    # 2. Existing entry is PENDING/RUNNING and new one is COMPLETED
                    #    (prefer completed state over pending for display)
                    existing = stage_subtask_map.get(stage_idx)
                    if existing is None:
                        stage_subtask_map[stage_idx] = subtask
                    elif existing.status in [
                        SubtaskStatus.PENDING,
                        SubtaskStatus.RUNNING,
                    ]:
                        # If existing is pending/running but we found a completed one, use completed
                        if subtask.status == SubtaskStatus.COMPLETED:
                            stage_subtask_map[stage_idx] = subtask
                    # If existing is COMPLETED, keep it (don't overwrite with PENDING from follow-up)

        # Now determine current stage and status based on the stage_subtask_map
        for i in range(total_stages):
            if i in stage_subtask_map:
                subtask = stage_subtask_map[i]
                if subtask.status == SubtaskStatus.PENDING_CONFIRMATION:
                    current_stage = i
                    is_pending_confirmation = True
                    break
                elif subtask.status in [SubtaskStatus.RUNNING, SubtaskStatus.PENDING]:
                    current_stage = i
                    break
                elif subtask.status == SubtaskStatus.COMPLETED:
                    # Check if this completed stage has requireConfirmation
                    # and the next stage hasn't started yet
                    if i < len(members) and members[i].requireConfirmation:
                        next_stage_idx = i + 1
                        if (
                            next_stage_idx not in stage_subtask_map
                            and next_stage_idx < total_stages
                        ):
                            # Next stage subtask doesn't exist yet, stay at current stage
                            current_stage = i
                            is_pending_confirmation = True
                            break
                    # Normal case: move to next stage
                    current_stage = i + 1
                elif subtask.status == SubtaskStatus.FAILED:
                    current_stage = i
                    break
            else:
                # No subtask for this stage yet, this is the current stage
                current_stage = i
                break

        # Ensure current_stage doesn't exceed total_stages
        current_stage = min(current_stage, total_stages - 1)

        # Build stages list
        stages = []
        for i, member in enumerate(members):
            stage_status = "pending"
            if i in stage_subtask_map:
                subtask_status = stage_subtask_map[i].status
                if subtask_status == SubtaskStatus.COMPLETED:
                    stage_status = "completed"
                elif subtask_status == SubtaskStatus.RUNNING:
                    stage_status = "running"
                elif subtask_status == SubtaskStatus.PENDING_CONFIRMATION:
                    stage_status = "pending_confirmation"
                elif subtask_status == SubtaskStatus.FAILED:
                    stage_status = "failed"
                elif subtask_status == SubtaskStatus.PENDING:
                    stage_status = "pending"

            # If this is the current stage and is_pending_confirmation is true,
            # override the status to "pending_confirmation" for UI display
            if i == current_stage and is_pending_confirmation:
                stage_status = "pending_confirmation"

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

    def confirm_stage(
        self,
        db: Session,
        task: TaskResource,
        task_crd: Task,
        team_crd: Team,
        confirmed_prompt: str,
        action: str = "continue",
    ) -> Dict[str, Any]:
        """
        Confirm a pipeline stage and proceed to the next stage or retry.

        Args:
            db: Database session
            task: Task resource object
            task_crd: Task CRD object
            team_crd: Team CRD object
            confirmed_prompt: The confirmed/edited prompt to pass to next stage
            action: "continue" to proceed to next stage, "retry" to stay at current stage

        Returns:
            Dict with confirmation result info
        """
        # Get current pipeline stage info
        stage_info = self.get_stage_info(db, task.id, team_crd)

        if action == "retry":
            # Stay at current stage - update status to COMPLETED so user can send new messages
            # The user will continue chatting with the current bot until a new final_prompt is generated
            task_crd.status.status = "COMPLETED"
            task_crd.status.updatedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            task.updated_at = datetime.now()
            flag_modified(task, "json")
            db.commit()

            return {
                "message": "Stage retry initiated",
                "task_id": task.id,
                "current_stage": stage_info["current_stage"],
                "total_stages": stage_info["total_stages"],
                "next_stage_name": None,
            }

        # action == "continue": Proceed to next stage
        # Find the next pending subtask (next stage)
        current_stage = stage_info["current_stage"]
        next_stage = current_stage + 1

        if next_stage >= stage_info["total_stages"]:
            # No more stages, mark task as completed
            task_crd.status.status = "COMPLETED"
            task_crd.status.progress = 100
            task_crd.status.updatedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            task.updated_at = datetime.now()
            task.completed_at = datetime.now()
            flag_modified(task, "json")
            db.commit()

            return {
                "message": "Pipeline completed",
                "task_id": task.id,
                "current_stage": current_stage,
                "total_stages": stage_info["total_stages"],
                "next_stage_name": None,
            }

        # Find the next stage's subtask and update with confirmed prompt
        next_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task.id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.PENDING,
            )
            .order_by(Subtask.message_id.asc())
            .first()
        )

        if next_subtask:
            # Store the confirmed prompt in the next subtask's result field
            # This will be used by executor_kinds to pass to the next bot
            next_subtask.result = {
                "confirmed_prompt": confirmed_prompt,
                "from_stage_confirmation": True,
            }
            next_subtask.updated_at = datetime.now()
        else:
            # No pending subtask found - need to create one for the next stage
            # This happens when pipeline mode creates subtasks one at a time
            next_subtask = self._create_next_stage_subtask(
                db, task, task_crd, team_crd, next_stage, confirmed_prompt
            )
            if not next_subtask:
                raise HTTPException(
                    status_code=500,
                    detail="Failed to create subtask for next pipeline stage",
                )

        # Update task status back to PENDING to allow executor_manager to pick up the task
        # Note: We use PENDING instead of RUNNING because the subtask is PENDING
        # and executor_manager will update task to RUNNING when it dispatches the subtask
        task_crd.status.status = "PENDING"
        task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        flag_modified(task, "json")
        db.commit()

        # Get next stage name
        next_stage_name = None
        if next_stage < len(team_crd.spec.members):
            next_bot_ref = team_crd.spec.members[next_stage].botRef
            next_stage_name = next_bot_ref.name

        return {
            "message": "Stage confirmed, proceeding to next stage",
            "task_id": task.id,
            "current_stage": next_stage,
            "total_stages": stage_info["total_stages"],
            "next_stage_name": next_stage_name,
        }

    def _create_next_stage_subtask(
        self,
        db: Session,
        task: TaskResource,
        task_crd: Task,
        team_crd: Team,
        next_stage_index: int,
        confirmed_prompt: str,
        from_skip_confirmation: bool = False,
    ) -> Optional[Subtask]:
        """
        Create a subtask for the next pipeline stage.

        Args:
            db: Database session
            task: Task resource object
            task_crd: Task CRD object
            team_crd: Team CRD object
            next_stage_index: Index of the next stage (0-based)
            confirmed_prompt: The confirmed prompt/context to pass to the next stage
            from_skip_confirmation: If True, marks this as skip confirmation (context mode)

        Returns:
            The created Subtask object, or None if creation failed
        """
        if next_stage_index >= len(team_crd.spec.members):
            return None
        next_member = team_crd.spec.members[next_stage_index]

        # Get the team to find the bot (supports owned, shared, and group teams)
        team = self.get_team_for_task(db, task, task_crd)

        if not team:
            logger.error(f"Team not found for task {task.id}")
            return None

        # Find the bot for the next stage
        # For group teams (namespace != 'default'), bot may be created by any group member
        # so we query without user_id filter
        if next_member.botRef.namespace and next_member.botRef.namespace != "default":
            bot = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Bot",
                    Kind.name == next_member.botRef.name,
                    Kind.namespace == next_member.botRef.namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )
        else:
            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == team.user_id,
                    Kind.kind == "Bot",
                    Kind.name == next_member.botRef.name,
                    Kind.namespace == next_member.botRef.namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )

        if not bot:
            logger.error(
                f"Bot {next_member.botRef.name} not found for pipeline stage {next_stage_index}"
            )
            return None

        # Get the last subtask to determine message_id and parent_id
        last_subtask = (
            db.query(Subtask)
            .filter(Subtask.task_id == task.id)
            .order_by(Subtask.message_id.desc())
            .first()
        )

        if not last_subtask:
            logger.error(f"No existing subtasks found for task {task.id}")
            return None

        next_message_id = last_subtask.message_id + 1
        parent_id = last_subtask.message_id

        # Get executor info from existing assistant subtasks (reuse executor)
        executor_name = ""
        executor_namespace = ""
        existing_assistant = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task.id,
                Subtask.role == SubtaskRole.ASSISTANT,
            )
            .first()
        )
        if existing_assistant:
            executor_name = existing_assistant.executor_name or ""
            executor_namespace = existing_assistant.executor_namespace or ""

        # Build result based on confirmation type
        if from_skip_confirmation:
            result_data = {
                "context": confirmed_prompt,
                "from_skip_confirmation": True,
            }
        else:
            result_data = {
                "confirmed_prompt": confirmed_prompt,
                "from_stage_confirmation": True,
            }

        # Create the new subtask for the next stage
        new_subtask = Subtask(
            user_id=last_subtask.user_id,
            task_id=task.id,
            team_id=team.id,
            title=f"{task_crd.spec.title} - {bot.name}",
            bot_ids=[bot.id],
            role=SubtaskRole.ASSISTANT,
            prompt="",
            status=SubtaskStatus.PENDING,
            progress=0,
            message_id=next_message_id,
            parent_id=parent_id,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
            error_message="",
            completed_at=None,
            result=result_data,
        )

        db.add(new_subtask)
        db.flush()  # Get the new subtask ID

        logger.info(
            f"Pipeline {'skip' if from_skip_confirmation else 'confirm'}_stage: "
            f"created subtask {new_subtask.id} for stage {next_stage_index} "
            f"(bot={bot.name}, message_id={next_message_id})"
        )

        return new_subtask

    def get_team_for_task(
        self, db: Session, task: TaskResource, task_crd: Task
    ) -> Optional[Kind]:
        """
        Get the team associated with a task.

        Supports:
        1. Teams owned by task owner
        2. Teams shared via SharedTeam table
        3. Group teams (namespace != 'default') - can be created by any group member

        Args:
            db: Database session
            task: Task resource object
            task_crd: Task CRD object

        Returns:
            Team Kind object or None if not found
        """
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace

        # First try to find team owned by task owner
        team = (
            db.query(Kind)
            .filter(
                Kind.user_id == task.user_id,
                Kind.kind == "Team",
                Kind.name == team_name,
                Kind.namespace == team_namespace,
                Kind.is_active.is_(True),
            )
            .first()
        )

        # If not found, check shared teams
        if not team:
            shared_teams = (
                db.query(SharedTeam)
                .filter(
                    SharedTeam.user_id == task.user_id, SharedTeam.is_active.is_(True)
                )
                .all()
            )
            original_user_ids = [st.original_user_id for st in shared_teams]
            if original_user_ids:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id.in_(original_user_ids),
                        Kind.kind == "Team",
                        Kind.name == team_name,
                        Kind.namespace == team_namespace,
                        Kind.is_active.is_(True),
                    )
                    .first()
                )

        # If still not found and namespace is not 'default', this might be a group team
        # Group teams can be created by any group member, so we query without user_id filter
        if not team and team_namespace and team_namespace != "default":
            team = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Team",
                    Kind.name == team_name,
                    Kind.namespace == team_namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )

        return team

    def skip_stage_confirmation(
        self,
        db: Session,
        task: TaskResource,
        task_crd: Task,
        team_crd: Team,
    ) -> Dict[str, Any]:
        """
        Skip stage confirmation and proceed to next stage using last stage's result.

        Gets the last completed stage's result as context and creates a new subtask
        for the next stage. If the result is too long, it will be summarized using AI.

        Args:
            db: Database session
            task: Task resource object
            task_crd: Task CRD object
            team_crd: Team CRD object

        Returns:
            Dict with skip result info
        """
        # Get current pipeline stage info
        stage_info = self.get_stage_info(db, task.id, team_crd)

        # Get the context from the last completed stage
        context = self.get_last_stage_result_as_context(db, task.id)

        if not context:
            # If no context available, use empty context
            context = ""
            logger.warning(
                f"Pipeline skip_stage_confirmation: no context available for task {task.id}"
            )

        current_stage = stage_info["current_stage"]
        next_stage = current_stage + 1

        if next_stage >= stage_info["total_stages"]:
            # No more stages, mark task as completed
            task_crd.status.status = "COMPLETED"
            task_crd.status.progress = 100
            task_crd.status.updatedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json", exclude_none=True)
            task.updated_at = datetime.now()
            task.completed_at = datetime.now()
            flag_modified(task, "json")
            db.commit()

            return {
                "message": "Pipeline completed",
                "task_id": task.id,
                "current_stage": current_stage,
                "total_stages": stage_info["total_stages"],
                "next_stage_name": None,
            }

        # Reuse _create_next_stage_subtask with from_skip_confirmation=True
        next_subtask = self._create_next_stage_subtask(
            db,
            task,
            task_crd,
            team_crd,
            next_stage,
            context,
            from_skip_confirmation=True,
        )

        if not next_subtask:
            raise HTTPException(
                status_code=500,
                detail="Failed to create subtask for next pipeline stage",
            )

        # Update task status back to PENDING
        task_crd.status.status = "PENDING"
        task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        flag_modified(task, "json")
        db.commit()

        # Get next stage name
        next_stage_name = None
        if next_stage < len(team_crd.spec.members):
            next_bot_ref = team_crd.spec.members[next_stage].botRef
            next_stage_name = next_bot_ref.name

        return {
            "message": "Stage skipped, proceeding to next stage",
            "task_id": task.id,
            "current_stage": next_stage,
            "total_stages": stage_info["total_stages"],
            "next_stage_name": next_stage_name,
        }

    def get_last_stage_result_as_context(
        self,
        db: Session,
        task_id: int,
        max_length: Optional[int] = None,
    ) -> str:
        """
        Get the last completed stage's result as context for next stage.

        Args:
            db: Database session
            task_id: Task ID
            max_length: Maximum character length before summarization (default from settings)

        Returns:
            Context string (original result or AI summary if too long)
        """
        if max_length is None:
            max_length = settings.PIPELINE_CONTEXT_MAX_LENGTH

        # Get the last completed assistant subtask
        last_completed = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
            .order_by(Subtask.message_id.desc())
            .first()
        )

        if not last_completed:
            logger.warning(
                f"Pipeline get_last_stage_result_as_context: no completed subtask for task {task_id}"
            )
            return ""

        # Extract result content
        result = last_completed.result
        if not result:
            return ""

        # Handle different result formats
        if isinstance(result, dict):
            # If result is a dict, try to extract text content
            if "text" in result:
                content = result["text"]
            elif "content" in result:
                content = result["content"]
            elif "message" in result:
                content = result["message"]
            else:
                # Convert dict to JSON string
                content = json.dumps(result, ensure_ascii=False, indent=2)
        elif isinstance(result, str):
            content = result
        else:
            content = str(result)

        # Check if content exceeds max length
        if len(content) > max_length:
            logger.info(
                f"Pipeline context exceeds max length ({len(content)} > {max_length}), "
                f"summarizing for task {task_id}"
            )
            # Summarize using AI (synchronous call)
            content = self._summarize_context_sync(content, max_length)

        return content

    def _summarize_context_sync(
        self, content: str, target_length: Optional[int] = None
    ) -> str:
        """
        Use AI to summarize long context content (synchronous version).

        Calls the configured LLM with a summarization prompt to compress
        the content while preserving key information.

        Args:
            content: The content to summarize
            target_length: Target length for summary (default from settings)

        Returns:
            Summarized content
        """
        if target_length is None:
            target_length = settings.PIPELINE_SUMMARY_MAX_LENGTH

        try:
            # Import here to avoid circular imports
            from app.services.chat.llm_client import get_default_llm_client

            llm_client = get_default_llm_client()
            if not llm_client:
                logger.warning(
                    "Pipeline context summarization: no LLM client available, truncating instead"
                )
                # Fallback to simple truncation
                return (
                    content[:target_length] + "..."
                    if len(content) > target_length
                    else content
                )

            # Create summarization prompt
            system_prompt = (
                "You are a helpful assistant that summarizes text. "
                "Preserve key information and main points. "
                "Be concise and clear."
            )
            user_prompt = (
                f"Please summarize the following text to approximately {target_length} characters, "
                f"preserving the key information and main points:\n\n{content}"
            )

            # Call LLM for summarization (synchronous)
            import asyncio

            loop = asyncio.new_event_loop()
            try:
                summary = loop.run_until_complete(
                    llm_client.complete(
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        max_tokens=target_length * 2,  # Allow some buffer
                    )
                )
                return summary if summary else content[:target_length]
            finally:
                loop.close()

        except Exception as e:
            logger.error(f"Pipeline context summarization failed: {str(e)}")
            # Fallback to simple truncation
            return (
                content[:target_length] + "..."
                if len(content) > target_length
                else content
            )


# Singleton instance
pipeline_stage_service = PipelineStageService()
