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

                # Send chat:start WebSocket event for executor tasks
                # This allows frontend to establish subtask-to-task mapping
                # and prepare for receiving chat:done event later
                self._emit_chat_start_ws_event(
                    task_id=updated_subtask.task_id,
                    subtask_id=updated_subtask.id,
                )

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

                    # Send WebSocket event for task status update (PENDING -> RUNNING)
                    self._emit_task_status_ws_event(
                        user_id=task.user_id,
                        task_id=task_id,
                        status="RUNNING",
                        progress=task_crd.status.progress if task_crd.status else 0,
                    )

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

    def _query_ghost(
        self,
        db: Session,
        ghost_ref_name: str,
        ghost_ref_namespace: str,
        bot_user_id: int,
    ) -> Optional[Kind]:
        """
        Query Ghost resource based on namespace.

        Args:
            db: Database session
            ghost_ref_name: Ghost reference name
            ghost_ref_namespace: Ghost reference namespace
            bot_user_id: Bot's user_id for personal resource lookup

        Returns:
            Ghost Kind object or None
        """
        is_group = ghost_ref_namespace and ghost_ref_namespace != "default"

        if is_group:
            # Group resource - don't filter by user_id
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "Ghost",
                    Kind.name == ghost_ref_name,
                    Kind.namespace == ghost_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Default namespace - first try user's ghost, then public ghost
            ghost = (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_user_id,
                    Kind.kind == "Ghost",
                    Kind.name == ghost_ref_name,
                    Kind.namespace == ghost_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not ghost:
                ghost = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Ghost",
                        Kind.name == ghost_ref_name,
                        Kind.namespace == ghost_ref_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
            return ghost

    def _query_shell(
        self,
        db: Session,
        shell_ref_name: str,
        shell_ref_namespace: str,
        bot_user_id: int,
    ) -> tuple[Optional[Kind], Optional[str]]:
        """
        Query Shell resource based on namespace.

        Args:
            db: Database session
            shell_ref_name: Shell reference name
            shell_ref_namespace: Shell reference namespace
            bot_user_id: Bot's user_id for personal resource lookup

        Returns:
            Tuple of (Shell Kind object or None, base_image or None)
        """
        is_group = shell_ref_namespace and shell_ref_namespace != "default"
        shell_base_image = None

        if is_group:
            # Group resource - don't filter by user_id
            shell = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.name == shell_ref_name,
                    Kind.namespace == shell_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            return shell, shell_base_image
        else:
            # Default namespace - first try user's shell
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_user_id,
                    Kind.kind == "Shell",
                    Kind.name == shell_ref_name,
                    Kind.namespace == shell_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if shell:
                return shell, shell_base_image

            # If user shell not found, try public shells (user_id = 0)
            public_shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == shell_ref_name,
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

                return MockShell(public_shell.json), shell_base_image

            return None, shell_base_image

    def _query_model(
        self,
        db: Session,
        model_ref_name: str,
        model_ref_namespace: str,
        bot_user_id: int,
        bot_name: str,
    ) -> Optional[Kind]:
        """
        Query Model resource based on namespace.

        Args:
            db: Database session
            model_ref_name: Model reference name
            model_ref_namespace: Model reference namespace
            bot_user_id: Bot's user_id for personal resource lookup
            bot_name: Bot name for logging

        Returns:
            Model Kind object or None
        """
        is_group = model_ref_namespace and model_ref_namespace != "default"

        if is_group:
            # Group resource - don't filter by user_id
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_ref_name,
                    Kind.namespace == model_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Default namespace - first try user's private models
            model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_user_id,
                    Kind.kind == "Model",
                    Kind.name == model_ref_name,
                    Kind.namespace == model_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if model:
                return model

            # If not found, try public models (user_id = 0)
            public_model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_ref_name,
                    Kind.namespace == model_ref_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if public_model:
                logger.info(
                    f"Found model '{model_ref_name}' in public models for bot {bot_name}"
                )
            return public_model

    def _resolve_model_by_type(
        self,
        db: Session,
        model_name: str,
        bind_model_type: Optional[str],
        bind_model_namespace: str,
        bot_user_id: int,
    ) -> Optional[Kind]:
        """
        Resolve model by bind_model_type.

        Args:
            db: Database session
            model_name: Model name to resolve
            bind_model_type: Model type ('public', 'user', 'group', or None)
            bind_model_namespace: Model namespace
            bot_user_id: Bot's user_id for personal resource lookup

        Returns:
            Model Kind object or None
        """
        if bind_model_type == "public":
            # Explicitly public model - query with user_id = 0
            return (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .first()
            )
        elif bind_model_type == "group":
            # Group model - query without user_id filter
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == bind_model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        elif bind_model_type == "user":
            # User's private model - query with bot's user_id
            return (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == bind_model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # No explicit type - use fallback logic
            # First try user's private models
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == bot_user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .first()
            )
            # If not found, try public models
            if not model_kind:
                model_kind = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == model_name,
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                    .first()
                )
            return model_kind

    def _resolve_model_config(
        self,
        db: Session,
        agent_config: Dict[str, Any],
        task_crd: Task,
        bot_user_id: int,
    ) -> Dict[str, Any]:
        """
        Resolve model configuration with support for bind_model and task-level override.

        Args:
            db: Database session
            agent_config: Current agent configuration
            task_crd: Task CRD for task-level model info
            bot_user_id: Bot's user_id for model lookup

        Returns:
            Resolved agent configuration
        """
        if not isinstance(agent_config, dict):
            return agent_config

        agent_config_data = agent_config

        try:
            # 1. Get Task-level model information
            task_model_name = None
            force_override = False

            if task_crd.metadata.labels:
                task_model_name = task_crd.metadata.labels.get("modelId")
                force_override = (
                    task_crd.metadata.labels.get("forceOverrideBotModel") == "true"
                )

            # 2. Determine which model name to use
            model_name_to_use = None

            if force_override and task_model_name:
                # Force override: use Task-specified model
                model_name_to_use = task_model_name
                logger.info(f"Using task model (force override): {model_name_to_use}")
            else:
                # Check for bind_model in agent_config
                bind_model_name = agent_config.get("bind_model")
                if isinstance(bind_model_name, str) and bind_model_name.strip():
                    model_name_to_use = bind_model_name.strip()
                    logger.info(f"Using bot bound model: {model_name_to_use}")
                # Fallback to task-specified model
                if not model_name_to_use and task_model_name:
                    model_name_to_use = task_model_name
                    logger.info(
                        f"Using task model (no bot binding): {model_name_to_use}"
                    )

            # 3. Query kinds table for Model CRD and replace config
            if model_name_to_use:
                bind_model_type = agent_config.get("bind_model_type")
                bind_model_namespace = agent_config.get(
                    "bind_model_namespace", "default"
                )

                model_kind = self._resolve_model_by_type(
                    db,
                    model_name_to_use,
                    bind_model_type,
                    bind_model_namespace,
                    bot_user_id,
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
                                model_config["env"]["api_key"] = decrypt_api_key(
                                    model_config["env"]["api_key"]
                                )
                            agent_config_data = model_config
                            logger.info(
                                f"Successfully loaded model config from kinds: {model_name_to_use} (type={bind_model_type})"
                            )
                    except Exception as e:
                        logger.warning(
                            f"Failed to parse model CRD {model_name_to_use}: {e}"
                        )
                else:
                    logger.warning(
                        f"Model '{model_name_to_use}' not found in kinds table (type={bind_model_type}, namespace={bind_model_namespace})"
                    )

        except Exception as e:
            logger.error(f"Failed to resolve model config: {e}")
            # On any error, fallback to original agent_config
            agent_config_data = agent_config

        return agent_config_data

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

                # Query ghost, shell, model using helper methods
                ghost = self._query_ghost(
                    db,
                    bot_crd.spec.ghostRef.name,
                    bot_crd.spec.ghostRef.namespace,
                    bot.user_id,
                )

                shell, shell_base_image = self._query_shell(
                    db,
                    bot_crd.spec.shellRef.name,
                    bot_crd.spec.shellRef.namespace,
                    bot.user_id,
                )

                # Get model for agent config (modelRef is optional)
                model = None
                if bot_crd.spec.modelRef:
                    model = self._query_model(
                        db,
                        bot_crd.spec.modelRef.name,
                        bot_crd.spec.modelRef.namespace,
                        bot.user_id,
                        bot.name,
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

                # Resolve model config using helper method
                agent_config_data = self._resolve_model_config(
                    db, agent_config, task_crd, bot.user_id
                )

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
        Update subtask and automatically update associated task status using kinds table.

        For streaming support:
        - When status is RUNNING and result contains content, emit chat:chunk events
        - Track previous content length to send only incremental updates
        """
        logger.info(
            f"update subtask subtask_id={subtask_update.subtask_id}, subtask_status={subtask_update.status}, subtask_progress={subtask_update.progress}"
        )

        # Get subtask
        subtask = db.query(Subtask).get(subtask_update.subtask_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        # Track previous content for streaming chunk calculation
        previous_content = ""
        if subtask.result and isinstance(subtask.result, dict):
            prev_value = subtask.result.get("value", "")
            if isinstance(prev_value, str):
                previous_content = prev_value

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

        # Emit chat:chunk event for streaming content updates
        # This allows frontend to display content in real-time during executor task execution
        # For executor tasks, result contains thinking and workbench data, not just value
        if subtask_update.status == SubtaskStatus.RUNNING and subtask_update.result:
            if isinstance(subtask_update.result, dict):
                # For executor tasks, send the full result (thinking, workbench)
                # Calculate offset from value if present
                new_content = ""
                new_value = subtask_update.result.get("value", "")
                if isinstance(new_value, str):
                    new_content = new_value

                # Calculate offset based on value content length
                offset = len(new_content) if new_content else 0

                # Check if there's any meaningful data to send (thinking or workbench)
                has_thinking = bool(subtask_update.result.get("thinking"))
                has_workbench = bool(subtask_update.result.get("workbench"))
                has_new_content = new_content and len(new_content) > len(
                    previous_content
                )

                if has_thinking or has_workbench or has_new_content:
                    # Calculate chunk content for text streaming
                    chunk_content = ""
                    if has_new_content:
                        chunk_content = new_content[len(previous_content) :]
                        offset = len(previous_content)

                    logger.info(
                        f"[WS] Emitting chat:chunk for executor task={subtask.task_id} subtask={subtask.id} "
                        f"offset={offset} has_thinking={has_thinking} has_workbench={has_workbench}"
                    )

                    self._emit_chat_chunk_ws_event(
                        task_id=subtask.task_id,
                        subtask_id=subtask.id,
                        content=chunk_content,
                        offset=offset,
                        result=subtask_update.result,  # Send full result with thinking and workbench
                    )

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

        # Send WebSocket event for task status update
        if task_crd.status:
            self._emit_task_status_ws_event(
                user_id=task.user_id,
                task_id=task_id,
                status=task_crd.status.status,
                progress=task_crd.status.progress,
            )

        # Send chat:done WebSocket event for completed/failed subtasks
        # This allows frontend to receive message content in real-time via WebSocket
        # instead of relying on polling
        if last_non_pending_subtask and last_non_pending_subtask.status in [
            SubtaskStatus.COMPLETED,
            SubtaskStatus.FAILED,
        ]:
            self._emit_chat_done_ws_event(
                task_id=task_id,
                subtask_id=last_non_pending_subtask.id,
                result=last_non_pending_subtask.result,
                message_id=last_non_pending_subtask.message_id,
            )

        db.add(task)

    def _emit_task_status_ws_event(
        self,
        user_id: int,
        task_id: int,
        status: str,
        progress: Optional[int] = None,
    ) -> None:
        """
        Emit task:status WebSocket event to notify frontend of task status changes.

        This method schedules the WebSocket event emission asynchronously to avoid
        blocking the database transaction.

        Args:
            user_id: User ID who owns the task
            task_id: Task ID
            status: New task status
            progress: Optional progress percentage
        """
        logger.info(
            f"[WS] _emit_task_status_ws_event called for task={task_id} status={status} progress={progress} user_id={user_id}"
        )

        async def emit_async():
            try:
                from app.services.chat.ws_emitter import get_ws_emitter

                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    await ws_emitter.emit_task_status(
                        user_id=user_id,
                        task_id=task_id,
                        status=status,
                        progress=progress,
                    )
                    logger.info(
                        f"[WS] Successfully emitted task:status event for task={task_id} status={status} progress={progress}"
                    )
                else:
                    logger.warning(
                        f"[WS] ws_emitter is None, cannot emit task:status event for task={task_id}"
                    )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit task:status WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        # First try to get the running event loop from the current context
        try:
            # Try to get the running event loop
            loop = asyncio.get_running_loop()
            # We're in an async context, use create_task directly
            loop.create_task(emit_async())
            logger.info(
                f"[WS] Scheduled task:status event via loop.create_task for task={task_id}"
            )
        except RuntimeError:
            # No running event loop in current thread
            # Try to use the main event loop reference from ws_emitter
            logger.info(
                f"[WS] No running event loop in current thread, trying main event loop for task={task_id}"
            )
            try:
                from app.services.chat.ws_emitter import get_main_event_loop

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    # Schedule the coroutine to run in the main event loop
                    asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
                    logger.info(
                        f"[WS] Scheduled task:status event via run_coroutine_threadsafe (main loop) for task={task_id}"
                    )
                else:
                    # Fallback: try asyncio.get_event_loop()
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.run_coroutine_threadsafe(emit_async(), loop)
                        logger.info(
                            f"[WS] Scheduled task:status event via run_coroutine_threadsafe (fallback) for task={task_id}"
                        )
                    else:
                        logger.warning(
                            f"[WS] No running event loop available, cannot emit task:status event for task={task_id}"
                        )
            except RuntimeError as e:
                # No event loop available at all
                logger.warning(
                    f"[WS] Could not emit task:status event - no event loop available: {e}"
                )

    def _emit_chat_start_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        bot_name: Optional[str] = None,
    ) -> None:
        """
        Emit chat:start WebSocket event to notify frontend that AI response is starting.

        This method is called when an executor task starts running. It allows the frontend
        to establish the subtask-to-task mapping and prepare for receiving chat:done event.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            bot_name: Optional bot name
        """
        logger.info(
            f"[WS] _emit_chat_start_ws_event called for task={task_id} subtask={subtask_id}"
        )

        async def emit_async():
            try:
                from app.services.chat.ws_emitter import get_ws_emitter

                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    await ws_emitter.emit_chat_start(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        bot_name=bot_name,
                    )
                    logger.info(
                        f"[WS] Successfully emitted chat:start event for task={task_id} subtask={subtask_id}"
                    )
                else:
                    logger.warning(
                        f"[WS] ws_emitter is None, cannot emit chat:start event for task={task_id}"
                    )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:start WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution using the same pattern as _emit_task_status_ws_event
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(emit_async())
            logger.info(
                f"[WS] Scheduled chat:start event via loop.create_task for task={task_id}"
            )
        except RuntimeError:
            logger.info(
                f"[WS] No running event loop in current thread, trying main event loop for task={task_id}"
            )
            try:
                from app.services.chat.ws_emitter import get_main_event_loop

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
                    logger.info(
                        f"[WS] Scheduled chat:start event via run_coroutine_threadsafe (main loop) for task={task_id}"
                    )
                else:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.run_coroutine_threadsafe(emit_async(), loop)
                        logger.info(
                            f"[WS] Scheduled chat:start event via run_coroutine_threadsafe (fallback) for task={task_id}"
                        )
                    else:
                        logger.warning(
                            f"[WS] No running event loop available, cannot emit chat:start event for task={task_id}"
                        )
            except RuntimeError as e:
                logger.warning(
                    f"[WS] Could not emit chat:start event - no event loop available: {e}"
                )

    def _emit_chat_done_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """
        Emit chat:done WebSocket event to notify frontend of completed subtask with message content.

        This method sends the message content to the frontend via WebSocket so that
        the frontend can display the AI response in real-time without polling.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            result: Result data containing the message content
            message_id: Message ID for ordering (primary sort key)
        """
        logger.info(
            f"[WS] _emit_chat_done_ws_event called for task={task_id} subtask={subtask_id} message_id={message_id}"
        )

        async def emit_async():
            try:
                from app.services.chat.ws_emitter import get_ws_emitter

                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    # Calculate offset from result content length
                    offset = 0
                    if result and isinstance(result, dict):
                        value = result.get("value", "")
                        if isinstance(value, str):
                            offset = len(value)

                    await ws_emitter.emit_chat_done(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        offset=offset,
                        result=result,
                        message_id=message_id,
                    )
                    logger.info(
                        f"[WS] Successfully emitted chat:done event for task={task_id} subtask={subtask_id} message_id={message_id}"
                    )
                else:
                    logger.warning(
                        f"[WS] ws_emitter is None, cannot emit chat:done event for task={task_id}"
                    )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:done WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution using the same pattern as _emit_task_status_ws_event
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(emit_async())
            logger.info(
                f"[WS] Scheduled chat:done event via loop.create_task for task={task_id}"
            )
        except RuntimeError:
            logger.info(
                f"[WS] No running event loop in current thread, trying main event loop for task={task_id}"
            )
            try:
                from app.services.chat.ws_emitter import get_main_event_loop

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
                    logger.info(
                        f"[WS] Scheduled chat:done event via run_coroutine_threadsafe (main loop) for task={task_id}"
                    )
                else:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.run_coroutine_threadsafe(emit_async(), loop)
                        logger.info(
                            f"[WS] Scheduled chat:done event via run_coroutine_threadsafe (fallback) for task={task_id}"
                        )
                    else:
                        logger.warning(
                            f"[WS] No running event loop available, cannot emit chat:done event for task={task_id}"
                        )
            except RuntimeError as e:
                logger.warning(
                    f"[WS] Could not emit chat:done event - no event loop available: {e}"
                )

    def _emit_chat_chunk_ws_event(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Emit chat:chunk WebSocket event to notify frontend of streaming content update.

        This method sends incremental content updates to the frontend via WebSocket
        for real-time streaming display.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk to send (for text streaming)
            offset: Current offset in the full response
            result: Optional full result data (for executor tasks with thinking/workbench)
        """
        logger.info(
            f"[WS] _emit_chat_chunk_ws_event called for task={task_id} subtask={subtask_id} offset={offset}"
        )

        async def emit_async():
            try:
                from app.services.chat.ws_emitter import get_ws_emitter

                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    await ws_emitter.emit_chat_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=content,
                        offset=offset,
                        result=result,
                    )
                    logger.info(
                        f"[WS] Successfully emitted chat:chunk event for task={task_id} subtask={subtask_id}"
                    )
                else:
                    logger.warning(
                        f"[WS] ws_emitter is None, cannot emit chat:chunk event for task={task_id}"
                    )
            except Exception as e:
                logger.error(
                    f"[WS] Failed to emit chat:chunk WebSocket event: {e}",
                    exc_info=True,
                )

        # Schedule async execution
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(emit_async())
        except RuntimeError:
            try:
                from app.services.chat.ws_emitter import get_main_event_loop

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(emit_async(), main_loop)
                else:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.run_coroutine_threadsafe(emit_async(), loop)
            except RuntimeError:
                pass  # Silently ignore if no event loop available for chunk events

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
