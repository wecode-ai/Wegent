# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException
from shared.utils.crypto import decrypt_api_key
from sqlalchemy import and_, func, text
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team, Workspace
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.base import BaseService
from app.services.webhook_notification import Notification, webhook_notification_service

logger = logging.getLogger(__name__)


class ExecutorKindsService(
    BaseService[Kind, SubtaskExecutorUpdate, SubtaskExecutorUpdate]
):
    """
    Executor service class using kinds table for Task operations
    """

    async def dispatch_tasks(
        self,
        db: Session,
        *,
        status: str = "PENDING",
        limit: int = 1,
        task_ids: Optional[List[int]] = None,
        type: str = "online",
    ) -> Dict[str, List[Dict]]:
        """
        Task dispatch logic with subtask support using kinds table

        Args:
            status: Subtask status to filter by
            limit: Maximum number of subtasks to return (only used when task_ids is None)
            task_ids: Optional list of task IDs to filter by
            type: Task type to filter by (default: "online")
        """
        if task_ids:
            # Scenario 1: Specify task ID list, query subtasks for these tasks
            # When multiple task_ids are provided, ignore limit parameter, each task will only take 1 subtask
            subtasks = []

            for task_id in task_ids:
                # First query kinds table to check task status
                task = (
                    db.query(Kind)
                    .filter(
                        Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True
                    )
                    .params(type=type)
                    .first()
                )
                if not task:
                    # Task doesn't exist, skip
                    continue
                # Check task status from JSON, skip if not PENDING or RUNNING
                task_crd = Task.model_validate(task.json)
                task_status = task_crd.status.status if task_crd.status else "PENDING"
                if task_status not in ["PENDING", "RUNNING"]:
                    continue

                # Check if the specified task has RUNNING status subtasks
                running_subtasks = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == task_id,
                        Subtask.status == SubtaskStatus.RUNNING,
                    )
                    .count()
                )

                if running_subtasks > 0:
                    # If there are running subtasks, skip this task
                    continue

                # Get subtasks for this task, only take 1 per task
                task_subtasks = self._get_subtasks_for_task(db, task_id, status, 1)
                if task_subtasks:
                    subtasks.extend(task_subtasks)
        else:
            # Scenario 2: No task_ids, first query tasks, then query first subtask for each task
            subtasks = self._get_first_subtasks_for_tasks(db, status, limit, type)

        if not subtasks:
            return {"tasks": []}

        # Update subtask status to RUNNING (concurrent safe)
        updated_subtasks = self._update_subtasks_to_running(db, subtasks)
        db.commit()

        # Format return data
        result = self._format_subtasks_response(db, updated_subtasks)
        return result

    def _get_subtasks_for_task(
        self, db: Session, task_id: int, status: str, limit: int
    ) -> List[Subtask]:
        """Get subtasks for specified task, return first one sorted by message_id"""
        return (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == status,
            )
            .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
            .limit(limit)
            .all()
        )

    def _get_first_subtasks_for_tasks(
        self, db: Session, status: str, limit: int, type: str
    ) -> List[Subtask]:
        """Get first subtask for multiple tasks using kinds table"""
        # Step 1: First query kinds table to get limit tasks
        tasks = None
        if type == "offline":
            tasks = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Task",
                    Kind.is_active == True,
                    text(
                        "JSON_EXTRACT(json, '$.metadata.labels.type') = 'offline' and JSON_EXTRACT(json, '$.status.status') = :status"
                    ),
                )
                .params(status=status)
                .order_by(Kind.created_at.desc())
                .limit(limit)
                .all()
            )
        else:
            tasks = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Task",
                    Kind.is_active == True,
                    text(
                        "(JSON_EXTRACT(json, '$.metadata.labels.type') IS NULL OR JSON_EXTRACT(json, '$.metadata.labels.type') = 'online') and JSON_EXTRACT(json, '$.status.status') = :status"
                    ),
                )
                .params(status=status)
                .order_by(Kind.created_at.desc())
                .limit(limit)
                .all()
            )

        if not tasks:
            return []

        task_ids = [task.id for task in tasks]
        # Step 2: Query first subtask with matching status for each task
        subtasks = []
        for tid in task_ids:
            first_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == tid,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status == status,
                )
                .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .first()
            )

            if first_subtask:
                subtasks.append(first_subtask)

        return subtasks

    def _update_subtasks_to_running(
        self, db: Session, subtasks: List[Subtask]
    ) -> List[Subtask]:
        """Concurrently and safely update subtask status to RUNNING"""
        updated_subtasks = []

        for subtask in subtasks:
            # Use optimistic locking mechanism to ensure concurrent safety
            result = (
                db.query(Subtask)
                .filter(
                    Subtask.id == subtask.id,
                    Subtask.status
                    == SubtaskStatus.PENDING,  # Ensure only PENDING status can be updated
                )
                .update(
                    {
                        Subtask.status: SubtaskStatus.RUNNING,
                        Subtask.updated_at: datetime.now(),
                    }
                )
            )

            if result > 0:  # If update is successful
                # Reload the updated subtask
                updated_subtask = db.query(Subtask).get(subtask.id)
                updated_subtasks.append(updated_subtask)
                # update task status to RUNNING
                self._update_task_to_running(db, updated_subtask.task_id)

        return updated_subtasks

    def _update_task_to_running(self, db: Session, task_id: int) -> None:
        """Update task status to RUNNING (only when task is PENDING) using kinds table"""
        task = (
            db.query(Kind)
            .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
            .first()
        )

        if task:
            if task:
                task_crd = Task.model_validate(task.json)
                current_status = (
                    task_crd.status.status if task_crd.status else "PENDING"
                )

                # Ensure only PENDING status can be updated
                if current_status == "PENDING":
                    if task_crd.status:
                        task_crd.status.status = "RUNNING"
                        task_crd.status.updatedAt = datetime.now()
                    task.json = task_crd.model_dump(mode="json")
                    task.updated_at = datetime.now()
                    flag_modified(task, "json")

    def _get_model_config_from_public_model(
        self, db: Session, agent_config: Any
    ) -> Any:
        """
        Get model configuration from kinds table (public models) by private_model name in agent_config
        """
        # Check if agent_config is a dictionary
        if not isinstance(agent_config, dict):
            return agent_config

        # Extract private_model field
        private_model_name = agent_config.get("private_model")

        # Check if private_model_name is a valid non-empty string
        if not isinstance(private_model_name, str) or not private_model_name.strip():
            return agent_config

        try:
            model_name = private_model_name.strip()
            public_model = db.query(Kind).filter(Kind.name == model_name).first()

            if public_model and public_model.json:
                model_config = public_model.json.get("spec", {}).get("modelConfig", {})
                return model_config

        except Exception as e:
            logger.warning(
                f"Failed to load model '{private_model_name}' from public_models: {e}"
            )

        return agent_config

    def _format_subtasks_response(
        self, db: Session, subtasks: List[Subtask]
    ) -> Dict[str, List[Dict]]:
        """Format subtask response data using kinds table for task information"""
        formatted_subtasks = []

        # Pre-fetch adjacent subtask information for each subtask
        for subtask in subtasks:
            # Query all related subtasks under the same task in one go
            related_subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == subtask.task_id,
                )
                .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .all()
            )

            next_subtask = None
            previous_subtask_results = ""

            user_prompt = ""
            for i, related in enumerate(related_subtasks):
                if related.role == SubtaskRole.USER:
                    user_prompt = related.prompt
                    previous_subtask_results = ""
                    continue
                if related.message_id < subtask.message_id:
                    previous_subtask_results = related.result
                if related.message_id == subtask.message_id:
                    if i < len(related_subtasks) - 1:
                        next_subtask = related_subtasks[i + 1]
                    break

            # Build aggregated prompt
            aggregated_prompt = ""
            # User input prompt
            if user_prompt:
                aggregated_prompt = user_prompt
            # Previous subtask result
            if previous_subtask_results != "":
                aggregated_prompt += (
                    f"\nPrevious execution result: {previous_subtask_results}"
                )
            # Get task information from kinds table
            task = (
                db.query(Kind)
                .filter(
                    Kind.id == subtask.task_id,
                    Kind.kind == "Task",
                    Kind.is_active == True,
                )
                .first()
            )

            if not task:
                continue

            task_crd = Task.model_validate(task.json)

            # Get workspace information
            workspace = (
                db.query(Kind)
                .filter(
                    Kind.user_id == task.user_id,
                    Kind.kind == "Workspace",
                    Kind.name == task_crd.spec.workspaceRef.name,
                    Kind.namespace == task_crd.spec.workspaceRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            git_url = ""
            git_repo = ""
            git_repo_id = 0
            git_domain = ""
            branch_name = ""

            if workspace and workspace.json:
                workspace_crd = Workspace.model_validate(workspace.json)
                git_url = workspace_crd.spec.repository.gitUrl
                git_repo = workspace_crd.spec.repository.gitRepo
                git_repo_id = workspace_crd.spec.repository.gitRepoId or 0
                git_domain = workspace_crd.spec.repository.gitDomain
                branch_name = workspace_crd.spec.repository.branchName

            # Build user git information - query user by user_id
            user = db.query(User).filter(User.id == subtask.user_id).first()
            git_info = (
                next(
                    (
                        info
                        for info in user.git_info
                        if info.get("git_domain") == git_domain
                    ),
                    None,
                )
                if user and user.git_info
                else None
            )

            # Get team information from kinds table
            team = (
                db.query(Kind)
                .filter(Kind.id == subtask.team_id, Kind.is_active == True)
                .first()
            )

            if not team:
                continue

            team_crd = Team.model_validate(team.json)
            team_members = team_crd.spec.members
            collaboration_model = team_crd.spec.collaborationModel

            # Build bot information
            bots = []

            pipeline_index = 0
            if collaboration_model == "pipeline":
                for i, related in enumerate(related_subtasks):
                    if related.role == SubtaskRole.USER:
                        continue
                    if related.id == subtask.id:
                        break
                    pipeline_index = pipeline_index + 1

            for index, bot_id in enumerate(subtask.bot_ids):
                # Get bot from kinds table
                bot = (
                    db.query(Kind)
                    .filter(Kind.id == bot_id, Kind.is_active == True)
                    .first()
                )

                if not bot:
                    continue

                bot_crd = Bot.model_validate(bot.json)

                # Get ghost for system prompt and mcp servers
                ghost = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == team.user_id,
                        Kind.kind == "Ghost",
                        Kind.name == bot_crd.spec.ghostRef.name,
                        Kind.namespace == bot_crd.spec.ghostRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                # Get shell for agent name - first check user's custom shells, then public shells
                shell = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == team.user_id,
                        Kind.kind == "Shell",
                        Kind.name == bot_crd.spec.shellRef.name,
                        Kind.namespace == bot_crd.spec.shellRef.namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                # If user shell not found, try public shells
                shell_base_image = None
                if not shell:

                    public_shell = (
                        db.query(Kind)
                        .filter(
                            Kind.name == bot_crd.spec.shellRef.name,
                            Kind.is_active == True,
                        )
                        .first()
                    )
                    if public_shell and public_shell.json:
                        shell_crd_temp = Shell.model_validate(public_shell.json)
                        shell_base_image = shell_crd_temp.spec.baseImage

                        # Create a mock shell object for compatibility
                        class MockShell:
                            def __init__(self, json_data):
                                self.json = json_data

                        shell = MockShell(public_shell.json)

                # Get model for agent config (modelRef is optional)
                # Try to find in kinds table (user's private models) first, then public_models table
                model = None
                if bot_crd.spec.modelRef:
                    model = (
                        db.query(Kind)
                        .filter(
                            Kind.user_id == team.user_id,
                            Kind.kind == "Model",
                            Kind.name == bot_crd.spec.modelRef.name,
                            Kind.namespace == bot_crd.spec.modelRef.namespace,
                            Kind.is_active == True,
                        )
                        .first()
                    )

                    # If not found in kinds table, try public_models table
                    if not model:

                        public_model = (
                            db.query(Kind)
                            .filter(
                                Kind.name == bot_crd.spec.modelRef.name,
                                Kind.namespace == bot_crd.spec.modelRef.namespace,
                                Kind.is_active == True,
                            )
                            .first()
                        )
                        if public_model:
                            model = public_model
                            logger.info(
                                f"Found model '{bot_crd.spec.modelRef.name}' in public_models table for bot {bot.name}"
                            )

                # Extract data from components
                system_prompt = ""
                mcp_servers = {}
                skills = []
                shell_type = ""
                agent_config = {}

                if ghost and ghost.json:
                    ghost_crd = Ghost.model_validate(ghost.json)
                    system_prompt = ghost_crd.spec.systemPrompt
                    mcp_servers = ghost_crd.spec.mcpServers or {}
                    skills = ghost_crd.spec.skills or []
                    logger.info(
                        f"Bot {bot.name} (ID: {bot.id}) - Ghost {ghost.name} skills: {skills}"
                    )

                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type = shell_crd.spec.shellType
                    # Extract baseImage from shell (user-defined shell overrides public shell)
                    if shell_crd.spec.baseImage:
                        shell_base_image = shell_crd.spec.baseImage

                if model and model.json:
                    model_crd = Model.model_validate(model.json)
                    agent_config = model_crd.spec.modelConfig

                    # Check for private_model in agent_config (legacy compatibility)
                    agent_config = self._get_model_config_from_public_model(
                        db, agent_config
                    )

                    # Decrypt API key for executor
                    if isinstance(agent_config, dict) and "env" in agent_config:
                        if "api_key" in agent_config["env"]:
                            agent_config["env"]["api_key"] = decrypt_api_key(
                                agent_config["env"]["api_key"]
                            )

                # Get team member info for bot prompt and role
                team_member_info = None
                if collaboration_model == "pipeline":
                    if pipeline_index < len(team_members):
                        team_member_info = team_members[pipeline_index]
                else:
                    if index < len(team_members):
                        team_member_info = team_members[index]

                bot_prompt = system_prompt
                if team_member_info and team_member_info.prompt:
                    bot_prompt += f"\n{team_member_info.prompt}"
                agent_config_data = agent_config

                # Model resolution logic with support for bind_model and task-level override
                try:
                    if isinstance(agent_config, dict):
                        # 1. Get Task-level model information
                        task_model_name = None
                        force_override = False

                        if task_crd.metadata.labels:
                            task_model_name = task_crd.metadata.labels.get("modelId")
                            force_override = (
                                task_crd.metadata.labels.get("forceOverrideBotModel")
                                == "true"
                            )

                        # 2. Determine which model name to use
                        model_name_to_use = None

                        if force_override and task_model_name:
                            # Force override: use Task-specified model
                            model_name_to_use = task_model_name
                            logger.info(
                                f"Using task model (force override): {model_name_to_use}"
                            )
                        else:
                            # Check for bind_model in agent_config
                            bind_model_name = agent_config.get("bind_model")
                            if (
                                isinstance(bind_model_name, str)
                                and bind_model_name.strip()
                            ):
                                model_name_to_use = bind_model_name.strip()
                                logger.info(
                                    f"Using bot bound model: {model_name_to_use}"
                                )
                            # Fallback to task-specified model
                            if not model_name_to_use and task_model_name:
                                model_name_to_use = task_model_name
                                logger.info(
                                    f"Using task model (no bot binding): {model_name_to_use}"
                                )

                        # 3. Query kinds table for Model CRD and replace config
                        if model_name_to_use:
                            # First try to find in kinds table (user's private models)
                            model_kind = (
                                db.query(Kind)
                                .filter(
                                    Kind.kind == "Model",
                                    Kind.name == model_name_to_use,
                                    Kind.namespace == "default",
                                    Kind.is_active == True,
                                )
                                .first()
                            )

                            if model_kind and model_kind.json:
                                try:
                                    model_crd = Model.model_validate(model_kind.json)
                                    model_config = model_crd.spec.modelConfig
                                    if isinstance(model_config, dict):
                                        # Decrypt API key for executor
                                        if (
                                            "env" in model_config
                                            and "api_key" in model_config["env"]
                                        ):
                                            model_config["env"]["api_key"] = (
                                                decrypt_api_key(
                                                    model_config["env"]["api_key"]
                                                )
                                            )
                                        agent_config_data = model_config
                                        logger.info(
                                            f"Successfully loaded model config from kinds: {model_name_to_use}"
                                        )
                                except Exception as e:
                                    logger.warning(
                                        f"Failed to parse model CRD {model_name_to_use}: {e}"
                                    )
                            else:
                                # Fallback to public_models table (legacy)
                                model_row = (
                                    db.query(Kind)
                                    .filter(Kind.name == model_name_to_use)
                                    .first()
                                )
                                if model_row and model_row.json:
                                    model_config = model_row.json.get("spec", {}).get(
                                        "modelConfig", {}
                                    )
                                    if isinstance(model_config, dict):
                                        # Decrypt API key for executor (public models may also have encrypted keys)
                                        if (
                                            "env" in model_config
                                            and "api_key" in model_config["env"]
                                        ):
                                            model_config["env"]["api_key"] = (
                                                decrypt_api_key(
                                                    model_config["env"]["api_key"]
                                                )
                                            )
                                        agent_config_data = model_config
                                        logger.info(
                                            f"Successfully loaded model config from public_models: {model_name_to_use}"
                                        )
                                else:
                                    logger.warning(
                                        f"Model '{model_name_to_use}' not found in kinds or public_models table"
                                    )

                except Exception as e:
                    logger.error(f"Failed to resolve model config: {e}")
                    # On any error, fallback to original agent_config
                    agent_config_data = agent_config

                bots.append(
                    {
                        "id": bot.id,
                        "name": bot.name,
                        "shell_type": shell_type,
                        "agent_config": agent_config_data,
                        "system_prompt": bot_prompt,
                        "mcp_servers": mcp_servers,
                        "skills": skills,
                        "role": team_member_info.role if team_member_info else "",
                        "base_image": shell_base_image,  # Custom base image for executor
                    }
                )

            type = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("type")
                or "online"
            )

            # Generate auth token for skills download
            # Use user's JWT token or generate a temporary one
            auth_token = None
            if user:
                # Generate a JWT token for the user to access backend API
                from app.core.config import settings
                from app.core.security import create_access_token

                try:
                    # Create a token valid for 24 hours (1440 minutes) for skills download
                    auth_token = create_access_token(
                        data={"sub": user.user_name, "user_id": user.id},
                        expires_delta=1440,  # 24 hours in minutes
                    )
                    logger.info(
                        f"Successfully generated auth token for user {user.id} (username: {user.user_name})"
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to generate auth token for user {user.id}: {e}"
                    )

            formatted_subtasks.append(
                {
                    "subtask_id": subtask.id,
                    "subtask_next_id": next_subtask.id if next_subtask else None,
                    "task_id": subtask.task_id,
                    "type": type,
                    "executor_name": subtask.executor_name,
                    "executor_namespace": subtask.executor_namespace,
                    "subtask_title": subtask.title,
                    "task_title": task_crd.spec.title,
                    "user": {
                        "id": user.id if user else None,
                        "name": user.user_name if user else None,
                        "git_domain": git_info.get("git_domain") if git_info else None,
                        "git_token": git_info.get("git_token") if git_info else None,
                        "git_id": git_info.get("git_id") if git_info else None,
                        "git_login": git_info.get("git_login") if git_info else None,
                        "git_email": git_info.get("git_email") if git_info else None,
                        "user_name": git_info.get("user_name") if git_info else None,
                    },
                    "bot": bots,
                    "team_id": team.id,
                    "mode": collaboration_model,
                    "git_domain": git_domain,
                    "git_repo": git_repo,
                    "git_repo_id": git_repo_id,
                    "branch_name": branch_name,
                    "git_url": git_url,
                    "prompt": aggregated_prompt,
                    "auth_token": auth_token,
                    "status": subtask.status,
                    "progress": subtask.progress,
                    "created_at": subtask.created_at,
                    "updated_at": subtask.updated_at,
                }
            )

        # Log before returning the formatted response
        subtask_ids = [item.get("subtask_id") for item in formatted_subtasks]
        logger.info(
            f"dispatch subtasks response count={len(formatted_subtasks)} ids={subtask_ids}"
        )
        return {"tasks": formatted_subtasks}

    async def update_subtask(
        self, db: Session, *, subtask_update: SubtaskExecutorUpdate
    ) -> Dict:
        """
        Update subtask and automatically update associated task status using kinds table
        """
        logger.info(
            f"update subtask subtask_id={subtask_update.subtask_id}, subtask_status={subtask_update.status}, subtask_progress={subtask_update.progress}"
        )

        # Get subtask
        subtask = db.query(Subtask).get(subtask_update.subtask_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        # Update subtask title (if provided)
        if subtask_update.subtask_title:
            subtask.title = subtask_update.subtask_title

        # Update task title (if provided) using kinds table
        if subtask_update.task_title:
            task = (
                db.query(Kind)
                .filter(
                    Kind.id == subtask.task_id,
                    Kind.kind == "Task",
                    Kind.is_active == True,
                )
                .first()
            )
            if task:
                task_crd = Task.model_validate(task.json)
                task_crd.spec.title = subtask_update.task_title
                task.json = task_crd.model_dump(mode="json")
                task.updated_at = datetime.now()
                flag_modified(task, "json")
                db.add(task)

        # Update other subtask fields
        update_data = subtask_update.model_dump(
            exclude={"subtask_title", "task_title"}, exclude_unset=True
        )
        for field, value in update_data.items():
            setattr(subtask, field, value)

        # Set completion time
        if subtask_update.status == SubtaskStatus.COMPLETED:
            subtask.completed_at = datetime.now()

        db.add(subtask)
        db.flush()  # Ensure subtask update is complete

        # Update associated task status
        self._update_task_status_based_on_subtasks(db, subtask.task_id)

        db.commit()

        return {
            "subtask_id": subtask.id,
            "task_id": subtask.task_id,
            "status": subtask.status,
            "progress": subtask.progress,
            "message": "Subtask updated successfully",
        }

    def _update_task_status_based_on_subtasks(self, db: Session, task_id: int) -> None:
        """Update task status based on subtask status using kinds table"""
        # Get task from kinds table
        task = (
            db.query(Kind)
            .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
            .first()
        )
        if not task:
            return

        subtasks = (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id, Subtask.role == SubtaskRole.ASSISTANT)
            .order_by(Subtask.message_id.asc())
            .all()
        )
        if not subtasks:
            return

        total_subtasks = len(subtasks)
        completed_subtasks = len(
            [s for s in subtasks if s.status == SubtaskStatus.COMPLETED]
        )
        failed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.FAILED])
        cancelled_subtasks = len(
            [s for s in subtasks if s.status == SubtaskStatus.CANCELLED]
        )

        task_crd = Task.model_validate(task.json)
        current_task_status = task_crd.status.status if task_crd.status else "PENDING"

        # Calculate task progress
        progress = int((completed_subtasks / total_subtasks) * 100)
        if task_crd.status:
            task_crd.status.progress = progress

        # Find the last non-pending subtask
        last_non_pending_subtask = None
        for subtask in reversed(subtasks):
            if subtask.status != SubtaskStatus.PENDING:
                last_non_pending_subtask = subtask
                break

        # Priority 1: Handle CANCELLED status
        # If task is in CANCELLING state and any subtask is CANCELLED, update task to CANCELLED
        if current_task_status == "CANCELLING" and cancelled_subtasks > 0:
            if task_crd.status:
                task_crd.status.status = "CANCELLED"
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.now()
                if last_non_pending_subtask:
                    task_crd.status.result = last_non_pending_subtask.result
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                        or "Task was cancelled by user"
                    )
                else:
                    task_crd.status.errorMessage = "Task was cancelled by user"
                logger.info(
                    f"Task {task_id} status updated from CANCELLING to CANCELLED (cancelled_subtasks={cancelled_subtasks})"
                )
        # Priority 2: Check if the last non-pending subtask is cancelled
        elif (
            last_non_pending_subtask
            and last_non_pending_subtask.status == SubtaskStatus.CANCELLED
        ):
            if task_crd.status:
                task_crd.status.status = "CANCELLED"
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.now()
                if last_non_pending_subtask.error_message:
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                    )
                else:
                    task_crd.status.errorMessage = "Task was cancelled by user"
                if last_non_pending_subtask.result:
                    task_crd.status.result = last_non_pending_subtask.result
                logger.info(
                    f"Task {task_id} status updated to CANCELLED based on last subtask"
                )
        # Priority 3: Check if the last non-pending subtask is failed
        elif (
            last_non_pending_subtask
            and last_non_pending_subtask.status == SubtaskStatus.FAILED
        ):
            if task_crd.status:
                task_crd.status.status = "FAILED"
                if last_non_pending_subtask.error_message:
                    task_crd.status.errorMessage = (
                        last_non_pending_subtask.error_message
                    )
                if last_non_pending_subtask.result:
                    task_crd.status.result = last_non_pending_subtask.result
        # Priority 4: Check if the last subtask is completed
        elif subtasks and subtasks[-1].status == SubtaskStatus.COMPLETED:
            # Get last completed subtask
            last_subtask = subtasks[-1] if subtasks else None
            if last_subtask and task_crd.status:
                task_crd.status.status = last_subtask.status.value
                task_crd.status.result = last_subtask.result
                task_crd.status.errorMessage = last_subtask.error_message
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.now()
        else:
            # Update to running status (only if not in a final state)
            if task_crd.status and current_task_status not in [
                "CANCELLED",
                "COMPLETED",
                "FAILED",
            ]:
                task_crd.status.status = "RUNNING"
                # If there is only one subtask, use the subtask's progress
                if total_subtasks == 1:
                    task_crd.status.progress = subtasks[0].progress
                    task_crd.status.result = subtasks[0].result
                    task_crd.status.errorMessage = subtasks[0].error_message

        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json")
        task.updated_at = datetime.now()
        flag_modified(task, "json")

        # auto delete executor
        self._auto_delete_executors_if_enabled(db, task_id, task_crd, subtasks)

        # Send notification when task is completed or failed
        self._send_task_completion_notification(db, task_id, task_crd)

        db.add(task)

    def _auto_delete_executors_if_enabled(
        self, db: Session, task_id: int, task_crd: Task, subtasks: List[Subtask]
    ) -> None:
        """Auto delete executors if enabled and task is in completed status"""
        # Check if auto delete executor is enabled and task is in completed status
        if (
            task_crd.metadata
            and task_crd.metadata.labels
            and task_crd.metadata.labels.get("autoDeleteExecutor") == "true"
            and task_crd.status
            and task_crd.status.status in ["COMPLETED", "FAILED"]
        ):

            # Prepare data for async execution - extract needed values before async execution
            # Filter subtasks with valid executor information and deduplicate
            unique_executor_keys = set()
            executors_data = []

            for subtask in subtasks:
                if subtask.executor_name:
                    subtask.executor_deleted_at = True
                    db.add(subtask)
                    executor_key = (subtask.executor_namespace, subtask.executor_name)
                    if executor_key not in unique_executor_keys:
                        unique_executor_keys.add(executor_key)
                        executors_data.append(
                            {
                                "name": subtask.executor_name,
                                "namespace": subtask.executor_namespace,
                            }
                        )

            async def delete_executors_async():
                """Asynchronously delete all executors for the task"""
                for executor in executors_data:
                    try:
                        logger.info(
                            f"Auto deleting executor for task {task_id}: ns={executor['namespace']} name={executor['name']}"
                        )
                        result = await self.delete_executor_task_async(
                            executor["name"], executor["namespace"]
                        )
                        logger.info(f"Successfully auto deleted executor: {result}")

                    except Exception as e:
                        logger.error(
                            f"Failed to auto delete executor ns={executor['namespace']} name={executor['name']}: {e}"
                        )

            # Schedule async execution
            asyncio.create_task(delete_executors_async())

    def _send_task_completion_notification(
        self, db: Session, task_id: int, task_crd: Task
    ) -> None:
        """Send webhook notification when task is completed or failed"""
        # Only send notification when task status is COMPLETED or FAILED
        if not task_crd.status or task_crd.status.status not in ["COMPLETED", "FAILED"]:
            return

        try:
            user_message = task_crd.spec.title
            task_start_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            task_end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            user_id = None

            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id.asc())
                .all()
            )

            # Check if any subtask is still in RUNNING status
            running_subtasks = [
                s for s in subtasks if s.status == SubtaskStatus.RUNNING
            ]
            if running_subtasks:
                logger.info(
                    f"Skip notification for task {task_id}: {len(running_subtasks)} subtask(s) still running"
                )
                return

            for subtask in subtasks:
                user_id = subtask.user_id
                if subtask.status == SubtaskStatus.PENDING:
                    continue
                if subtask.role == SubtaskRole.USER:
                    user_message = subtask.prompt
                    task_start_time = (
                        subtask.created_at.strftime("%Y-%m-%d %H:%M:%S")
                        if isinstance(subtask.created_at, datetime)
                        else subtask.created_at
                    )
                if subtask.role == SubtaskRole.ASSISTANT:
                    task_end_time = (
                        subtask.updated_at.strftime("%Y-%m-%d %H:%M:%S")
                        if isinstance(subtask.updated_at, datetime)
                        else subtask.updated_at
                    )

            user_name = "Unknown"
            if user_id:
                user = db.query(User).filter(User.id == user_id).first()
                user_name = user.user_name

            task_type = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("taskType")
                or "chat"
            )
            task_url = f"{settings.FRONTEND_URL}/{task_type}?taskId={task_id}"

            # Truncate description if too long
            description = user_message
            if len(user_message) > 20:
                description = user_message[:20] + "..."

            notification = Notification(
                user_name=user_name,
                event="task.end",
                id=str(task_id),
                start_time=task_start_time,
                end_time=task_end_time,
                description=description,
                status=task_crd.status.status,
                detail_url=task_url,
            )

            # Send notification asynchronously in background daemon thread to avoid blocking
            def send_notification_background():
                try:
                    webhook_notification_service.send_notification_sync(notification)
                except Exception as e:
                    logger.error(
                        f"Background webhook notification failed for task {task_id}: {str(e)}"
                    )

            thread = threading.Thread(target=send_notification_background, daemon=True)
            thread.start()
            logger.info(
                f"Webhook notification scheduled for task {task_id} with status {task_crd.status.status}"
            )

        except Exception as e:
            logger.error(
                f"Failed to schedule webhook notification for task {task_id}: {str(e)}"
            )

    def delete_executor_task_sync(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Synchronous version of delete_executor_task to avoid event loop issues

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            import requests

            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete sync request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            response = requests.post(
                settings.EXECUTOR_DELETE_TASK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30.0,
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )

    async def delete_executor_task_async(
        self, executor_name: str, executor_namespace: str
    ) -> Dict:
        """
        Asynchronous version of delete_executor_task

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name:
            raise HTTPException(status_code=400, detail="executor_name are required")
        try:
            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(
                f"executor.delete async request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_TASK_URL,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=500, detail=f"Error deleting executor task: {str(e)}"
            )


executor_kinds_service = ExecutorKindsService(Kind)
