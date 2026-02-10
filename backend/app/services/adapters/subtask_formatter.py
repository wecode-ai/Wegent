# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask response formatter module.

This module handles the formatting of subtask responses for executor dispatch.
It was extracted from executor_kinds.py to reduce file size and improve maintainability.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team, Workspace
from app.services.context import context_service
from shared.telemetry.context import SpanAttributes
from shared.telemetry.core import get_tracer, is_telemetry_enabled
from shared.utils.crypto import decrypt_api_key

logger = logging.getLogger(__name__)


class SubtaskFormatter:
    """
    Handles formatting of subtask responses for executor dispatch.

    This class encapsulates all the logic for:
    - Querying Ghost, Shell, Model resources
    - Resolving model configurations
    - Building bot information
    - Formatting the final response structure
    """

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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                        Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
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
        model_user_id: int,
    ) -> Optional[Kind]:
        """
        Resolve model by bind_model_type.

        Args:
            db: Database session
            model_name: Model name to resolve
            bind_model_type: Model type ('public', 'user', 'group', or None)
            bind_model_namespace: Model namespace
            model_user_id: User ID for model lookup (chat user for force_override, bot user otherwise)

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
                    Kind.is_active.is_(True),
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
                    Kind.is_active.is_(True),
                )
                .first()
            )
        elif bind_model_type == "user":
            # User's private model - query with the provided user_id
            # When force_override is true, this is the chat user's ID
            # Otherwise, this is the bot's user_id
            return (
                db.query(Kind)
                .filter(
                    Kind.user_id == model_user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == bind_model_namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )
        else:
            # No explicit type - use fallback logic
            # First try user's private models
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == model_user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == "default",
                    Kind.is_active.is_(True),
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
                        Kind.is_active.is_(True),
                    )
                    .first()
                )
            return model_kind

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

    def _resolve_model_config(
        self,
        db: Session,
        agent_config: Dict[str, Any],
        task_crd: Task,
        bot_user_id: int,
        chat_user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Resolve model configuration with support for bind_model and task-level override.

        Args:
            db: Database session
            agent_config: Current agent configuration
            task_crd: Task CRD for task-level model info
            bot_user_id: Bot's user_id for model lookup (used when not force_override)
            chat_user_id: Chat user's ID for model lookup (used when force_override is true)

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
                # When force_override is true, get model type from task labels
                # This is the type specified by the user when sending the message
                if force_override and task_model_name:
                    bind_model_type = task_crd.metadata.labels.get(
                        "forceOverrideBotModelType"
                    )
                    bind_model_namespace = "default"
                    # Use chat_user_id for force_override (the user who sent the message)
                    model_user_id = (
                        chat_user_id if chat_user_id is not None else bot_user_id
                    )
                else:
                    bind_model_type = agent_config.get("bind_model_type")
                    bind_model_namespace = agent_config.get(
                        "bind_model_namespace", "default"
                    )
                    # Use bot_user_id for normal model lookup
                    model_user_id = bot_user_id

                model_kind = self._resolve_model_by_type(
                    db,
                    model_name_to_use,
                    bind_model_type,
                    bind_model_namespace,
                    model_user_id,
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

    def _enhance_prompt_for_subscription(self, system_prompt: str) -> str:
        """Enhance system prompt with subscription mode notification info.

        When running in subscription mode (background scheduled tasks), this method
        adds a note about notification behavior and the silent_exit tool.

        This method is called in backend (not chat_shell) so it applies to ALL shell types
        (ClaudeCode, Agno, Chat, etc.) when tasks are dispatched to executors.

        Args:
            system_prompt: The base system prompt

        Returns:
            Enhanced system prompt with subscription mode info
        """
        subscription_prompt = """

<subscription_mode>
This is a subscription task (scheduled background task). Note:
- Any reply you generate will trigger a notification to the user.
- Use the `silent_exit` tool to end the task silently without notifying the user.
</subscription_mode>
"""
        logger.info("[EXECUTOR_DISPATCH] Enhanced system prompt for subscription mode")
        return system_prompt + subscription_prompt

    def _start_dispatch_traces(self, formatted_subtasks: List[Dict]) -> None:
        """
        Start a new trace for each dispatched task.

        This method creates a root span for each task being dispatched to executor.
        The trace context is added to the task data so executor can continue the trace.

        Args:
            formatted_subtasks: List of formatted subtask dictionaries
        """
        if not is_telemetry_enabled():
            return

        if not formatted_subtasks:
            return

        try:
            from opentelemetry import trace

            from shared.telemetry.context import get_trace_context_for_propagation

            tracer = get_tracer("backend.dispatch")

            for task_data in formatted_subtasks:
                task_id = task_data.get("task_id")
                subtask_id = task_data.get("subtask_id")
                user_data = task_data.get("user", {})
                user_id = user_data.get("id") if user_data else None
                user_name = user_data.get("name") if user_data else None
                task_title = task_data.get("task_title", "")

                # Create a new root span for the task dispatch
                # Use PRODUCER kind to indicate this starts a new trace for async processing
                with tracer.start_as_current_span(
                    name="task.dispatch",
                    kind=trace.SpanKind.PRODUCER,
                ) as span:
                    # Set task and user context attributes
                    span.set_attribute(SpanAttributes.TASK_ID, task_id)
                    span.set_attribute(SpanAttributes.SUBTASK_ID, subtask_id)
                    if user_id:
                        span.set_attribute(SpanAttributes.USER_ID, str(user_id))
                    if user_name:
                        span.set_attribute(SpanAttributes.USER_NAME, user_name)
                    span.set_attribute("task.title", task_title)
                    span.set_attribute("dispatch.type", "executor")

                    # Get bot info for tracing
                    bots = task_data.get("bot", [])
                    if bots:
                        bot_names = [b.get("name", "") for b in bots]
                        shell_types = [b.get("shell_type", "") for b in bots]
                        span.set_attribute("bot.names", ",".join(bot_names))
                        span.set_attribute("shell.types", ",".join(shell_types))

                    # Extract trace context for propagation to executor
                    trace_context = get_trace_context_for_propagation()
                    if trace_context:
                        # Add trace context to task data for executor to continue the trace
                        task_data["trace_context"] = trace_context
                        logger.debug(
                            f"Added trace context to task {task_id}: traceparent={trace_context.get('traceparent', 'N/A')}"
                        )

        except Exception as e:
            logger.warning(f"Failed to start dispatch traces: {e}")

    def format_subtasks_response(
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
            user_subtask = None
            for i, related in enumerate(related_subtasks):
                if related.role == SubtaskRole.USER:
                    user_prompt = related.prompt
                    previous_subtask_results = ""
                    user_subtask = related
                    continue
                if related.message_id < subtask.message_id:
                    previous_subtask_results = related.result
                if related.message_id == subtask.message_id:
                    if i < len(related_subtasks) - 1:
                        next_subtask = related_subtasks[i + 1]
                    break

            # Build aggregated prompt
            aggregated_prompt = ""
            # Check if this subtask has a confirmed_prompt from stage confirmation
            confirmed_prompt_from_stage = None
            # Flag to indicate this subtask should start a new session (no conversation history)
            # This is used in pipeline mode when user confirms a stage and proceeds to next bot
            new_session = False
            if subtask.result and isinstance(subtask.result, dict):
                if subtask.result.get("from_stage_confirmation"):
                    confirmed_prompt_from_stage = subtask.result.get("confirmed_prompt")
                    # Mark that this subtask should use a new session
                    # The next bot should not inherit conversation history from previous bot
                    new_session = True
                    # Clear the temporary result so it doesn't interfere with execution
                    subtask.result = None
                    subtask.updated_at = datetime.now()

            if confirmed_prompt_from_stage:
                # Use the confirmed prompt from stage confirmation instead of building from previous results
                aggregated_prompt = confirmed_prompt_from_stage
            else:
                # User input prompt
                if user_prompt:
                    aggregated_prompt = user_prompt
                # Previous subtask result
                if previous_subtask_results != "":
                    aggregated_prompt += (
                        f"\nPrevious execution result: {previous_subtask_results}"
                    )
            # Get task information from tasks table
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active.is_(True),
                )
                .first()
            )

            if not task:
                continue

            task_crd = Task.model_validate(task.json)

            # Get workspace information
            workspace = (
                db.query(TaskResource)
                .filter(
                    TaskResource.user_id == task.user_id,
                    TaskResource.kind == "Workspace",
                    TaskResource.name == task_crd.spec.workspaceRef.name,
                    TaskResource.namespace == task_crd.spec.workspaceRef.namespace,
                    TaskResource.is_active.is_(True),
                )
                .first()
            )

            git_url = ""
            git_repo = ""
            git_repo_id = 0
            git_domain = ""
            branch_name = ""

            if workspace and workspace.json:
                try:
                    workspace_crd = Workspace.model_validate(workspace.json)
                    git_url = workspace_crd.spec.repository.gitUrl
                    git_repo = workspace_crd.spec.repository.gitRepo
                    git_repo_id = workspace_crd.spec.repository.gitRepoId or 0
                    git_domain = workspace_crd.spec.repository.gitDomain
                    branch_name = workspace_crd.spec.repository.branchName
                except Exception:
                    # Handle workspaces with incomplete repository data
                    pass

            # Build user git information - query user by user_id
            user = db.query(User).filter(User.id == subtask.user_id).first()
            git_info = None
            if user and user.git_info and git_domain:
                # First try exact match
                git_info = next(
                    (
                        info
                        for info in user.git_info
                        if info.get("git_domain") == git_domain
                    ),
                    None,
                )
                # If no exact match, try contains match
                if git_info is None:
                    git_info = next(
                        (
                            info
                            for info in user.git_info
                            if git_domain in info.get("git_domain", "")
                        ),
                        None,
                    )

            # Get team information from kinds table
            team = (
                db.query(Kind)
                .filter(Kind.id == subtask.team_id, Kind.is_active.is_(True))
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
                    .filter(Kind.id == bot_id, Kind.is_active.is_(True))
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
                # Pass subtask.user_id as chat_user_id for force_override model lookup
                agent_config_data = self._resolve_model_config(
                    db, agent_config, task_crd, bot.user_id, subtask.user_id
                )

                bots.append(
                    {
                        "id": bot.id,
                        "name": bot.name,
                        "shell_type": shell_type,
                        "agent_config": agent_config_data,
                        "system_prompt": bot_prompt,
                        "mcp_servers": mcp_servers,
                        "skills": skills,  # Will be merged with user_selected_skills later
                        "role": team_member_info.role if team_member_info else "",
                        "base_image": shell_base_image,  # Custom base image for executor
                    }
                )

            task_type = (
                task_crd.metadata.labels
                and task_crd.metadata.labels.get("type")
                or "online"
            )

            # Check if this is a subscription task for silent exit support
            is_subscription = task_type == "subscription"

            # Enhance system prompt for subscription tasks
            # This is done here (in backend) so it applies to ALL shell types
            # (ClaudeCode, Agno, Chat, etc.)
            if is_subscription:
                for bot_config in bots:
                    bot_config["system_prompt"] = self._enhance_prompt_for_subscription(
                        bot_config["system_prompt"]
                    )

            # Extract user-selected skills from task labels
            # These are skills explicitly selected by the user for this task
            user_selected_skills = []
            if task_crd.metadata.labels:
                additional_skills_json = task_crd.metadata.labels.get(
                    "additionalSkills"
                )
                if additional_skills_json:
                    try:
                        parsed_skills = json.loads(additional_skills_json)
                        # Validate that parsed result is a list of strings
                        if isinstance(parsed_skills, list):
                            # Filter to only include string elements
                            user_selected_skills = [
                                s for s in parsed_skills if isinstance(s, str) and s
                            ]
                            if len(user_selected_skills) != len(parsed_skills):
                                logger.warning(
                                    f"[EXECUTOR_DISPATCH] Filtered out {len(parsed_skills) - len(user_selected_skills)} "
                                    f"non-string entries from additionalSkills for task {subtask.task_id}"
                                )
                        else:
                            logger.warning(
                                f"[EXECUTOR_DISPATCH] additionalSkills is not a list for task {subtask.task_id}, "
                                f"got {type(parsed_skills)}"
                            )
                        logger.info(
                            f"[EXECUTOR_DISPATCH] task_id={subtask.task_id} user_selected_skills={user_selected_skills}"
                        )
                    except json.JSONDecodeError as e:
                        logger.warning(
                            f"[EXECUTOR_DISPATCH] Failed to parse additionalSkills JSON for task {subtask.task_id}: {e}"
                        )

            # Merge user_selected_skills into each bot's skills list
            # This ensures user-selected skills are downloaded by executor
            if user_selected_skills:
                for bot_config in bots:
                    existing_skills = bot_config.get("skills", [])
                    # Add user-selected skills that are not already in the bot's skills
                    for skill_name in user_selected_skills:
                        if skill_name not in existing_skills:
                            existing_skills.append(skill_name)
                    bot_config["skills"] = existing_skills
                logger.info(
                    f"[EXECUTOR_DISPATCH] Merged user_selected_skills {user_selected_skills} into {len(bots)} bot(s) for task {subtask.task_id}"
                )

            logger.info(
                f"[EXECUTOR_DISPATCH] task_id={subtask.task_id}, subtask_id={subtask.id}, "
                f"type={task_type}, is_subscription={is_subscription}, "
                f"labels={task_crd.metadata.labels}"
            )

            # Generate auth token for skills download
            # Use user's JWT token or generate a temporary one
            auth_token = None
            task_token = None
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

                # Generate task token for MCP Server authentication
                try:
                    from app.mcp_server.auth import create_task_token

                    task_token = create_task_token(
                        task_id=subtask.task_id,
                        subtask_id=subtask.id,
                        user_id=user.id,
                        user_name=user.user_name,
                        expires_delta_minutes=1440,  # 24 hours
                    )
                    logger.info(
                        f"Successfully generated task token for task={subtask.task_id}, subtask={subtask.id}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to generate task token: {e}")

            # Generate system MCP configuration for subscription tasks
            system_mcp_config = None
            if is_subscription and task_token:
                try:
                    from app.mcp_server.server import get_mcp_system_config

                    # Get backend URL from settings
                    backend_url = settings.BACKEND_INTERNAL_URL
                    system_mcp_config = get_mcp_system_config(backend_url, task_token)
                    logger.info(
                        f"Generated system MCP config for subscription task {subtask.task_id}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to generate system MCP config: {e}")

            # Query attachments for this subtask using context service
            attachments_data = []
            if user_subtask:
                attachment_contexts = context_service.get_attachments_by_subtask(
                    db=db,
                    subtask_id=user_subtask.id,
                )
            else:
                # No USER subtask found, skip attachment query
                attachment_contexts = []

            # Note: We don't include download_url here.
            # The executor will construct the download URL using TASK_API_DOMAIN env var,
            # similar to how skill downloads work. This decouples backend from knowing its own URL.
            for ctx in attachment_contexts:
                # Only include ready attachments
                if ctx.status != "ready":
                    continue

                att_data = {
                    "id": ctx.id,
                    "original_filename": ctx.original_filename,
                    "file_extension": ctx.file_extension,
                    "file_size": ctx.file_size,
                    "mime_type": ctx.mime_type,
                }
                # Note: We intentionally don't include image_base64 here to avoid
                # large task JSON payloads. The executor will download attachments
                # via AttachmentDownloader using the attachment id.
                attachments_data.append(att_data)

            if attachments_data:
                logger.info(
                    f"Found {len(attachments_data)} attachments for subtask {subtask.id}"
                )

            formatted_subtasks.append(
                {
                    "subtask_id": subtask.id,
                    "subtask_next_id": next_subtask.id if next_subtask else None,
                    "task_id": subtask.task_id,
                    "type": task_type,
                    "is_subscription": is_subscription,  # For silent exit tool injection
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
                    "team_namespace": team.namespace,  # Team namespace for skill lookup
                    "mode": collaboration_model,
                    "git_domain": git_domain,
                    "git_repo": git_repo,
                    "git_repo_id": git_repo_id,
                    "branch_name": branch_name,
                    "git_url": git_url,
                    "backend_url": settings.BACKEND_INTERNAL_URL.rstrip("/"),
                    "prompt": aggregated_prompt,
                    "auth_token": auth_token,
                    "task_token": task_token,  # For MCP Server authentication
                    "system_mcp_config": system_mcp_config,  # System MCP for subscription tasks
                    "attachments": attachments_data,
                    "status": subtask.status,
                    "progress": subtask.progress,
                    "created_at": (
                        subtask.created_at.isoformat() if subtask.created_at else None
                    ),
                    "updated_at": (
                        subtask.updated_at.isoformat() if subtask.updated_at else None
                    ),
                    # Flag to indicate this subtask should start a new session (no conversation history)
                    # Used in pipeline mode when user confirms a stage and proceeds to next bot
                    "new_session": new_session,
                    # User-selected skills for skill emphasis in executor
                    # These are skills explicitly selected by the user for this task
                    "user_selected_skills": user_selected_skills,
                }
            )

        # Log before returning the formatted response
        subtask_ids = [item.get("subtask_id") for item in formatted_subtasks]
        logger.info(
            f"dispatch subtasks response count={len(formatted_subtasks)} ids={subtask_ids}"
        )

        # Start a new trace for each dispatched task
        # This creates a root span for the task execution lifecycle
        self._start_dispatch_traces(formatted_subtasks)

        # Note: Push mode dispatch is handled by task_dispatcher.schedule_dispatch()
        # which is called after task/subtask creation. Do NOT dispatch here to avoid
        # duplicate dispatches (schedule_dispatch already calls dispatch_tasks internally).

        return {"tasks": formatted_subtasks}


# Singleton instance
subtask_formatter = SubtaskFormatter()
