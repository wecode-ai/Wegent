#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from executor.agents.agno.thinking_step_manager import ThinkingStepManager
from executor.agents.base import Agent
from executor.agents.claude_code.attachment_handler import (
    download_attachments,
    get_attachment_thinking_step_details,
)
from executor.agents.claude_code.config_manager import (
    HookManager,
    build_claude_json_config,
    create_claude_model_config,
    extract_claude_options,
    get_claude_config_dir,
)
from executor.agents.claude_code.git_operations import (
    add_to_git_exclude,
    setup_claude_md_symlink,
    setup_git_authentication,
)
from executor.agents.claude_code.mode_strategy import (
    ExecutionModeStrategy,
    ModeStrategyFactory,
)
from executor.agents.claude_code.multimodal_prompt import (
    append_text_to_vision_prompt,
    convert_openai_to_anthropic_content,
    create_multimodal_query,
    is_vision_prompt,
    save_vision_images,
)
from executor.agents.claude_code.progress_state_manager import ProgressStateManager
from executor.agents.claude_code.prompt_enrichment import inject_kb_meta_prompt
from executor.agents.claude_code.response_processor import (
    process_response,
)
from executor.agents.claude_code.session_manager import (
    SessionManager,
    resolve_session_id,
)
from executor.agents.claude_code.skill_deployer import (
    build_skill_emphasis_prompt,
    download_and_deploy_skills,
    setup_claudecode_dir,
    setup_coordinate_mode,
)
from executor.config import config
from executor.services.task_identity import build_task_identity_context
from executor.tasks.resource_manager import ResourceManager
from executor.tasks.task_state_manager import TaskState, TaskStateManager
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.responses_api_emitter import ResponsesAPIEmitter
from shared.models.task import ExecutionResult, ThinkingStep
from shared.status import TaskStatus
from shared.telemetry.decorators import add_span_event, trace_async

logger = setup_logger("claude_code_agent")


def _extract_claude_agent_attributes(self, *args, **kwargs) -> Dict[str, Any]:
    """Extract trace attributes from ClaudeCodeAgent instance."""
    return {
        "task.id": str(self.task_id),
        "task.subtask_id": str(self.subtask_id),
        "agent.type": "ClaudeCode",
        "agent.session_id": str(self.session_id),
    }


class ClaudeCodeAgent(Agent):
    """
    Claude Code Agent that integrates with Claude Code SDK.

    Uses SessionManager for client connection management and session persistence.
    Uses HookManager for hook function loading and execution.
    """

    def get_name(self) -> str:
        return "ClaudeCode"

    def _get_claude_config_dir(self) -> str:
        """Get the .claude config directory path for the current task."""
        return get_claude_config_dir(self.task_id, self.options.get("cwd"))

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        """Get list of active task IDs.

        Delegates to SessionManager.

        Returns:
            List of active task IDs
        """
        return SessionManager.get_active_task_ids()

    @classmethod
    def get_active_session_count(cls) -> int:
        """Get the number of active Claude Code sessions.

        Returns:
            Number of active sessions
        """
        return SessionManager.get_active_session_count()

    def __init__(
        self,
        task_data: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ):
        """
        Initialize the Claude Code Agent

        Args:
            task_data: The task data object
            emitter: Emitter instance for sending events. Required parameter.
        """
        super().__init__(task_data, emitter)
        self.client = None
        self.new_session = task_data.new_session

        # Extract bot_id from task_data for session key
        # Store bot_id as instance variable for session file management
        self._bot_id = None
        bots = task_data.bot
        if bots and len(bots) > 0:
            self._bot_id = bots[0].get("id")

        # Initialize task state manager and resource manager
        self.task_state_manager = TaskStateManager()
        self.resource_manager = ResourceManager()

        # Resolve session ID using SessionManager (pass task_state_manager for interruption support)
        self._internal_session_key, self.session_id = resolve_session_id(
            self.task_id, self._bot_id, self.new_session, self.task_state_manager
        )

        self.prompt = task_data.prompt or ""
        self.project_path = None

        # Load hooks on first initialization
        HookManager.load_hooks()

        # Extract Claude Code options from task_data
        self.options = extract_claude_options(task_data)
        self.options["permission_mode"] = "bypassPermissions"

        # Set git-related environment variables
        setup_git_authentication(task_data)

        # Initialize thinking step manager
        self.thinking_manager = ThinkingStepManager(
            progress_reporter=self.report_progress
        )

        # Initialize progress state manager - will be fully initialized when task starts
        self.state_manager: Optional[ProgressStateManager] = None

        # Set initial task state to RUNNING (but preserve INTERRUPTED if resuming)
        current_state = self.task_state_manager.get_state(self.task_id)
        if current_state != TaskState.INTERRUPTED:
            self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)

        # Silent exit tracking for subscription tasks
        self.is_silent_exit: bool = False
        self.silent_exit_reason: str = ""

        # Config directory and env config for Local mode (populated in initialize())
        self._claude_config_dir: str = ""
        self._claude_env_config: Dict[str, Any] = {}

        # Callback for when client is created (used for heartbeat updates)
        self.on_client_created_callback: Optional[callable] = None

        # Initialize execution mode strategy
        self._mode_strategy: ExecutionModeStrategy = ModeStrategyFactory.create()

        # Note: emitter is created in base class Agent.__init__()
        # using EmitterBuilder with CallbackTransport

    def _stderr_callback(self, stderr_output: str) -> None:
        """
        Callback for handling stderr output from Claude CLI.

        Args:
            stderr_output: The stderr output string from CLI
        """
        if stderr_output:
            # Log stderr output for debugging
            logger.warning(f"Claude CLI stderr: {stderr_output}")

    def add_thinking_step(
        self,
        title: str,
        action: str = "",
        reasoning: str = "",
        result: str = "",
        confidence: float = -1,
        next_action: str = "continue",
        report_immediately: bool = True,
        use_i18n_keys: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step (wrapper for backward compatibility)

        Args:
            title: Step title
            action: Action description (ignored)
            reasoning: Reasoning process (ignored)
            result: Result (ignored)
            confidence: Confidence level (ignored)
            next_action: Next action (ignored)
            report_immediately: Whether to report this thinking step immediately (default True)
            use_i18n_keys: Whether to use i18n key directly instead of English text (default False)
            details: Additional details for the thinking step (optional)
        """
        self.thinking_manager.add_thinking_step(
            title=title,
            report_immediately=report_immediately,
            use_i18n_keys=use_i18n_keys,
            details=details,
        )

    def add_thinking_step_by_key(
        self,
        title_key: str,
        report_immediately: bool = True,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step using i18n key (wrapper for backward compatibility)

        Args:
            title_key: i18n key for step title
            action_key: i18n key for action description (ignored)
            reasoning_key: i18n key for reasoning process (ignored)
            result_key: i18n key for result (ignored)
            confidence: Confidence level (ignored)
            next_action_key: i18n key for next action (ignored)
            report_immediately: Whether to report this thinking step immediately (default True)
            details: Additional details for thinking step (optional)
        """
        self.thinking_manager.add_thinking_step_by_key(
            title_key=title_key, report_immediately=report_immediately, details=details
        )

    def _text_to_i18n_key(self, text: str) -> str:
        """
        Convert text to i18n key

        Args:
            text: Text to convert

        Returns:
            str: Corresponding i18n key
        """
        return self.thinking_manager._text_to_i18n_key(text)

    def _update_progress(self, progress: int) -> None:
        """
        Update current progress value for thinking steps

        Args:
            progress: Current progress value (0-100)
        """
        self.thinking_manager.update_progress(progress)

    def get_thinking_steps(self) -> List[ThinkingStep]:
        """
        Get all thinking steps

        Returns:
            List[ThinkingStep]: List of thinking steps
        """
        return self.thinking_manager.get_thinking_steps()

    def clear_thinking_steps(self) -> None:
        """
        Clear all thinking steps
        """
        self.thinking_manager.clear_thinking_steps()

    def _initialize_state_manager(self) -> None:
        """
        Initialize the progress state manager
        """
        if self.state_manager is None:
            # Get project path from options or use default
            project_path = self.options.get("cwd", self.project_path)

            self.state_manager = ProgressStateManager(
                thinking_manager=self.thinking_manager,
                task_data=self.task_data,
                report_progress_callback=self.report_progress,
                project_path=project_path,
            )

            # Set state_manager to thinking_manager for immediate reporting
            self.thinking_manager.set_state_manager(self.state_manager)

            logger.info("Initialized progress state manager")

    def update_prompt(self, new_prompt: str) -> None:
        """
        Update the prompt attribute while keeping other attributes unchanged

        Args:
            new_prompt: The new prompt to use
        """
        if new_prompt:
            logger.info(f"Updating prompt for session_id: {self.session_id}")
            self.prompt = new_prompt

    def initialize(self) -> TaskStatus:
        """
        Initialize the Claude Code Agent with configuration from task_data.
        Generates config files to task workspace directory and passes via settings parameter.

        Returns:
            TaskStatus: Initialization status
        """
        try:
            # Check if task was hard-cancelled before initialization
            # Note: INTERRUPTED tasks should continue to allow resumption
            task_state = self.task_state_manager.get_state(self.task_id)
            if task_state == TaskState.CANCELLED:
                logger.info(
                    f"Task {self.task_id} was hard-cancelled before initialization"
                )
                return TaskStatus.COMPLETED

            self.add_thinking_step_by_key(
                title_key="thinking.initialize_agent", report_immediately=False
            )

            # Check if bot config is available
            bots = self.task_data.bot
            if bots and len(bots) > 0:
                bot_config = bots[0]
                user = self.task_data.user if self.task_data.user else {}
                user_name = user.get("user_name") or user.get("name") or "unknown"
                git_url = self.task_data.git_url or ""
                # Get config from bot using config_manager
                agent_config = create_claude_model_config(
                    bot_config, user_name=user_name, git_url=git_url
                )
                if agent_config:
                    # Generate config files to task workspace directory
                    self._save_claude_config_files(agent_config)

                    # Download and deploy Skills if configured
                    download_and_deploy_skills(
                        bot_config,
                        self.task_data,
                        self._mode_strategy,
                        getattr(self, "_claude_config_dir", None),
                    )
            else:
                logger.info("No bot config found for Claude Code Agent")

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Claude Code Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_failed", report_immediately=False
            )
            return TaskStatus.FAILED

    def _save_claude_config_files(self, agent_config: Dict[str, Any]) -> None:
        """
        Save Claude config files to appropriate directory based on execution mode.

        Delegates to the mode strategy which handles:
        - Docker mode: saves to ~/.claude/ (SDK reads from default location)
        - Local mode: Does NOT write settings.json (contains sensitive API keys).
          Sensitive config is passed via environment variables in _create_and_connect_client().
          Only writes non-sensitive claude.json (user preferences) with strict file permissions.

        Args:
            agent_config: The agent configuration dictionary
        """
        # Non-sensitive user preferences config for claude.json
        claude_json_config = build_claude_json_config()

        # Delegate to mode strategy
        config_dir, env_config = self._mode_strategy.save_config_files(
            task_id=self.task_id,
            agent_config=agent_config,
            claude_json_config=claude_json_config,
        )

        # Store config directory and env config for SDK configuration
        self._claude_config_dir = config_dir
        self._claude_env_config = env_config

    async def pre_execute(self) -> Tuple[TaskStatus, Optional[str]]:
        """
        Pre-execution setup for Claude Code Agent

        Returns:
            Tuple[TaskStatus, Optional[str]]: A tuple containing:
                - TaskStatus: Pre-execution status
                - Optional[str]: Error message if failed, None if successful
        """
        try:
            git_url = self.task_data.git_url
            # Download code if git_url is provided
            if git_url and git_url != "":
                await self.download_code()

                # Update cwd in options if not already set
                if (
                    "cwd" not in self.options
                    and self.project_path is not None
                    and os.path.exists(self.project_path)
                ):
                    self.options["cwd"] = self.project_path
                    logger.info(f"Set cwd to {self.project_path}")

            # Setup Claude Code custom instructions
            if self.project_path:
                try:
                    custom_rules = self._load_custom_instructions(self.project_path)
                    if custom_rules:
                        # Setup .claudecode directory for Claude Code compatibility
                        setup_claudecode_dir(self.project_path, custom_rules)

                        # Update .git/info/exclude to ignore .claudecode
                        self._update_git_exclude(self.project_path)

                        logger.info(
                            f"Setup Claude Code custom instructions with {len(custom_rules)} files"
                        )

                    # Setup Claude.md symlink from Agents.md if exists
                    setup_claude_md_symlink(self.project_path)

                except Exception as e:
                    logger.warning(f"Failed to process custom instructions: {e}")
                    # Continue execution with original systemPrompt

            # Setup SubAgent configuration files for coordinate mode
            setup_coordinate_mode(self.task_data, self.project_path, self.options)

            # Download attachments for this task
            self._download_attachments()

            return TaskStatus.SUCCESS, None
        except Exception as e:
            error_msg = f"Pre-execution failed: {str(e)}"
            logger.error(error_msg)
            self.add_thinking_step(
                title="Pre-execution Failed",
                report_immediately=True,
                use_i18n_keys=False,
                details={"error": str(e)},
            )
            return TaskStatus.FAILED, error_msg

    def execute(self) -> TaskStatus:
        """
        Execute the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            progress = 55
            progress = 55
            # Update current progress
            self._update_progress(progress)

            # Initialize state manager and workbench at task start
            self._initialize_state_manager()
            self.state_manager.initialize_workbench("running")

            # Report starting progress using state manager
            self.state_manager.report_progress(
                progress, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}"
            )

            # Check if this is a subscription task - subscription tasks need to wait for completion
            # so the container can exit properly after task finishes
            is_subscription = self.task_data.is_subscription

            # Check if currently running in coroutine
            try:
                # Try to get current running event loop
                loop = asyncio.get_running_loop()
                # If we can get running event loop, we're in coroutine
                # Call async version directly
                logger.info(
                    "Detected running in an async context, calling execute_async"
                )

                if is_subscription:
                    # For subscription tasks, we need to wait for completion
                    # so the container can exit with proper status
                    logger.info(
                        "Subscription task detected, waiting for async execution to complete"
                    )
                    # Run in a new event loop in a separate thread to avoid blocking
                    # the current async context while still waiting for completion
                    import concurrent.futures

                    def run_async_task():
                        new_loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(new_loop)
                        try:
                            return new_loop.run_until_complete(self._async_execute())
                        finally:
                            new_loop.close()

                    with concurrent.futures.ThreadPoolExecutor() as executor:
                        future = executor.submit(run_async_task)
                        result = future.result()
                        logger.info(
                            f"Subscription task async execution completed with status: {result}"
                        )
                        return result
                else:
                    # For non-subscription tasks, create background task and return immediately
                    asyncio.create_task(self.execute_async())
                    logger.info(
                        "Created async task for execution, returning RUNNING status"
                    )
                    return TaskStatus.RUNNING
            except RuntimeError:
                # No running event loop, can safely use run_until_complete
                logger.info("No running event loop detected, using new event loop")
                self.add_thinking_step(
                    title="Sync Execution",
                    report_immediately=False,
                    use_i18n_keys=False,
                )

                # Copy ContextVars before creating new event loop
                # ContextVars don't automatically propagate to new event loops
                try:
                    from shared.telemetry.context import (
                        copy_context_vars,
                        restore_context_vars,
                    )

                    saved_context = copy_context_vars()
                except ImportError:
                    saved_context = None

                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    # Restore ContextVars in the new event loop
                    if saved_context:
                        restore_context_vars(saved_context)
                    return loop.run_until_complete(self._async_execute())
                finally:
                    loop.close()
        except Exception as e:
            return self._handle_execution_error(e, "Claude Code Agent execution")

    @trace_async(
        span_name="claude_code_execute_async",
        tracer_name="executor.agents.claude_code",
        extract_attributes=_extract_claude_agent_attributes,
    )
    async def execute_async(self) -> TaskStatus:
        """
        Execute Claude Code Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Reset task state to RUNNING at the start of new execution
            # This ensures that a previously cancelled task can be re-executed
            self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)
            logger.info(f"Task {self.task_id} state set to RUNNING for new execution")

            # Update current progress
            self._update_progress(60)

            # Initialize state manager and workbench if not already initialized
            if self.state_manager is None:
                self._initialize_state_manager()
                self.state_manager.initialize_workbench("running")

            # Report starting progress using state manager
            self.state_manager.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}"
            )

            # Add trace event for state manager initialization
            add_span_event("state_manager_initialized")

            return await self._async_execute()
        except Exception as e:
            return self._handle_execution_error(e, "Claude Code Agent async execution")

    async def _async_execute(self) -> TaskStatus:
        """
        Asynchronous execution of the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if task was cancelled before execution
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} was cancelled before execution")
                return TaskStatus.CANCELLED

            progress = 65
            # Update current progress
            self._update_progress(progress)

            # Always create a new client for each subtask execution
            # Since each subtask creates a new Agent instance and destroys it after completion,
            # there's no need to check for cached clients
            await self._create_and_connect_client()

            # Check cancellation again before proceeding
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled during client setup")
                return TaskStatus.CANCELLED

            # Prepare prompt with skill emphasis if user selected skills
            prompt = self.prompt
            user_selected_skills = self.task_data.user_selected_skills
            if is_vision_prompt(prompt):
                # Vision content: append text to the text block in the list
                if user_selected_skills:
                    skill_emphasis = self._build_skill_emphasis_prompt(
                        user_selected_skills
                    )
                    prompt = append_text_to_vision_prompt(
                        prompt, skill_emphasis, prepend=True
                    )
                    logger.info(
                        f"Added skill emphasis for {len(user_selected_skills)} user-selected skills: {user_selected_skills}"
                    )
                prompt = inject_kb_meta_prompt(
                    prompt,
                    self.task_data.kb_meta_prompt,
                    executor_mode=config.EXECUTOR_MODE,
                    is_user_selected_kb=self.task_data.is_user_selected_kb,
                )
                if self.task_data.kb_meta_prompt and config.EXECUTOR_MODE == "local":
                    logger.info("Injected kb_meta_prompt into ClaudeCode query prompt")
                if self.options.get("cwd"):
                    cwd_text = "\nCurrent working directory: " + self.options.get("cwd")
                    git_url = self.task_data.git_url
                    if git_url:
                        cwd_text += "\n project url:" + git_url
                    prompt = append_text_to_vision_prompt(
                        prompt, cwd_text, prepend=False
                    )
            else:
                # Plain text prompt (or content block list without images)
                if isinstance(prompt, list):
                    # Handle content block list (non-vision)
                    if user_selected_skills:
                        skill_emphasis = self._build_skill_emphasis_prompt(
                            user_selected_skills
                        )
                        prompt = append_text_to_vision_prompt(
                            prompt, skill_emphasis, prepend=True
                        )
                        logger.info(
                            f"Added skill emphasis for {len(user_selected_skills)} user-selected skills: {user_selected_skills}"
                        )
                    prompt = inject_kb_meta_prompt(
                        prompt,
                        self.task_data.kb_meta_prompt,
                        executor_mode=config.EXECUTOR_MODE,
                        is_user_selected_kb=self.task_data.is_user_selected_kb,
                    )
                    if (
                        self.task_data.kb_meta_prompt
                        and config.EXECUTOR_MODE == "local"
                    ):
                        logger.info(
                            "Injected kb_meta_prompt into ClaudeCode query prompt"
                        )
                    if self.options.get("cwd"):
                        cwd_text = "\nCurrent working directory: " + self.options.get(
                            "cwd"
                        )
                        git_url = self.task_data.git_url
                        if git_url:
                            cwd_text += "\n project url:" + git_url
                        prompt = append_text_to_vision_prompt(
                            prompt, cwd_text, prepend=False
                        )
                else:
                    # Handle string prompt
                    if user_selected_skills:
                        skill_emphasis = self._build_skill_emphasis_prompt(
                            user_selected_skills
                        )
                        prompt = skill_emphasis + "\n\n" + prompt
                        logger.info(
                            f"Added skill emphasis for {len(user_selected_skills)} user-selected skills: {user_selected_skills}"
                        )
                    prompt = inject_kb_meta_prompt(
                        prompt,
                        self.task_data.kb_meta_prompt,
                        executor_mode=config.EXECUTOR_MODE,
                        is_user_selected_kb=self.task_data.is_user_selected_kb,
                    )
                    if (
                        self.task_data.kb_meta_prompt
                        and config.EXECUTOR_MODE == "local"
                    ):
                        logger.info(
                            "Injected kb_meta_prompt into ClaudeCode query prompt"
                        )
                    if self.options.get("cwd"):
                        prompt = (
                            prompt
                            + "\nCurrent working directory: "
                            + self.options.get("cwd")
                        )
                        git_url = self.task_data.git_url
                        if git_url:
                            prompt = prompt + "\n project url:" + git_url

            progress = 75
            # Update current progress
            self._update_progress(progress)

            # Check cancellation before sending query
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled before sending query")
                return TaskStatus.CANCELLED

            # If new_session is True, update session_id to subtask_id
            # This is used for pipeline stage changes where each bot needs independent session
            # Note: Client was already created above, no need to create again
            if self.new_session:
                new_session_id = str(self.subtask_id)
                old_session_id = self.session_id
                self.session_id = new_session_id
                logger.info(
                    f"new_session=True, updated session_id from {old_session_id} to {new_session_id}"
                )

            # Use session_id to send messages, ensuring messages are in the same session
            # Use the current updated prompt for each execution, even with the same session ID
            prompt_length = len(prompt) if isinstance(prompt, str) else len(str(prompt))
            logger.info(
                f"Sending query with prompt (length: {prompt_length}) for session_id: {self.session_id}"
            )

            if is_vision_prompt(prompt):
                # Save images to disk before sending to SDK
                saved_paths = save_vision_images(prompt, task_id=self.task_id)
                if saved_paths:
                    logger.info(
                        f"Saved {len(saved_paths)} images to disk: {saved_paths}"
                    )
                anthropic_content = convert_openai_to_anthropic_content(prompt)
                await self.client.query(
                    create_multimodal_query(anthropic_content),
                    session_id=self.session_id,
                )
            elif isinstance(prompt, list):
                # Content block list without images - convert to Anthropic format
                # and send via multimodal query (SDK expects async generator for content blocks)
                anthropic_content = convert_openai_to_anthropic_content(prompt)
                await self.client.query(
                    create_multimodal_query(anthropic_content),
                    session_id=self.session_id,
                )
            else:
                await self.client.query(prompt, session_id=self.session_id)

            logger.info(f"Waiting for response for session_id: {self.session_id}")

            # Process and handle the response using the external processor
            result = await process_response(
                self.client,
                self.state_manager,
                self.get_emitter(),
                self.thinking_manager,
                self.task_state_manager,
                session_id=self.session_id,
            )

            # Task completed or failed

            if result is None:
                # No final result received, keep RUNNING status
                logger.warning("No final result received from process_response")
                result = TaskStatus.RUNNING

            # Update task state based on result
            if result == TaskStatus.COMPLETED:
                self.task_state_manager.set_state(self.task_id, TaskState.COMPLETED)
            elif result == TaskStatus.FAILED:
                self.task_state_manager.set_state(self.task_id, TaskState.FAILED)
            elif result == TaskStatus.CANCELLED:
                self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)

            # Auto-close CC process after completion to free device slot.
            # Session ID is preserved on disk for resume on next message.
            # Skip for CANCELLED — cancel/interrupt flow has its own cleanup.
            if result in (TaskStatus.COMPLETED, TaskStatus.FAILED):
                await self._auto_close_session()

            return result

        except Exception as e:
            return self._handle_execution_error(e, "async execution")

    async def _create_and_connect_client(self) -> None:
        """
        Create and connect a new Claude SDK client.
        Sets up the working directory if needed, creates the client with options,
        connects it, and stores it in the cache.

        Config files are generated in initialize() and passed via 'settings' parameter.

        If resuming a saved session fails (e.g., session expired or invalid),
        automatically retries with a fresh session.
        """
        logger.info(f"Creating new Claude client for session_id: {self.session_id}")

        # Ensure working directory exists
        if self.options.get("cwd") is None or self.options.get("cwd") == "":
            cwd = os.path.join(config.get_workspace_root(), str(self.task_id))
            os.makedirs(cwd, exist_ok=True)
            self.options["cwd"] = cwd

        # Delegate mode-specific configuration to strategy
        if self._claude_config_dir:
            task_identity_env = build_task_identity_context(self.task_data)
            self.options = self._mode_strategy.configure_client_options(
                options=self.options,
                config_dir=self._claude_config_dir,
                env_config=self._claude_env_config,
                task_identity_env=task_identity_env,
            )

        # Check if there's a saved session ID to resume
        # Skip resume in these cases:
        # 1. resume option is already set (e.g., from retry logic)
        # 2. new_session=True (pipeline stage change requires fresh session without history)
        saved_session_id = None
        if self.new_session:
            # Pipeline stage change: delete session file and skip resume to create fresh session
            # Each bot in pipeline needs independent conversation without previous bot's history
            # Deleting the session file enables stage rollback - user can go back to previous stage
            # and the bot will start fresh without the old session history
            SessionManager.delete_saved_session_id(self.task_id, self._bot_id)
            logger.info(
                f"Deleted session file and skipping resume for task {self.task_id} "
                f"(bot_id={self._bot_id}) because new_session=True "
                f"(pipeline stage change requires fresh session, enables rollback)"
            )
        elif "resume" not in self.options:
            # Load session ID for this specific bot (pipeline mode: each bot has its own session file)
            saved_session_id = SessionManager.load_saved_session_id(
                self.task_id, self._bot_id
            )
            if saved_session_id:
                logger.info(
                    f"Resuming Claude session for task {self.task_id} "
                    f"(bot_id={self._bot_id}): {saved_session_id}"
                )
                self.options["resume"] = saved_session_id
                await SessionManager.terminate_stale_resumed_process(
                    self.task_id, self._bot_id, saved_session_id
                )

        # On Windows, write large options to files to avoid command line length limit
        # Windows has a ~8191 character limit (WinError 206 if exceeded)
        from executor.platform_compat import prepare_options_for_windows

        self.options = prepare_options_for_windows(
            self.options, self._get_claude_config_dir()
        )

        # Add stderr callback to capture CLI stderr output
        self.options["stderr"] = self._stderr_callback

        # Create client with options
        if self.options:
            # Log MCP servers being passed to SDK
            mcp_in_opts = self.options.get("mcp_servers") or self.options.get(
                "mcpServers"
            )
            if mcp_in_opts:
                if isinstance(mcp_in_opts, dict):
                    logger.info(
                        "[SDK-INIT] Passing %d MCP server(s) to Claude SDK: %s",
                        len(mcp_in_opts),
                        list(mcp_in_opts.keys()),
                    )
                    for sname, scfg in mcp_in_opts.items():
                        logger.info(
                            "[SDK-INIT]   %s -> type=%s, url=%s",
                            sname,
                            scfg.get("type", "?") if isinstance(scfg, dict) else "?",
                            scfg.get("url", "?") if isinstance(scfg, dict) else "?",
                        )
                elif isinstance(mcp_in_opts, str):
                    logger.info(
                        "[SDK-INIT] MCP servers via config file: %s", mcp_in_opts
                    )
                else:
                    logger.info(
                        "[SDK-INIT] MCP servers (type=%s): %s",
                        type(mcp_in_opts).__name__,
                        mcp_in_opts,
                    )
            else:
                logger.info("[SDK-INIT] No MCP servers in options")

            code_options = ClaudeAgentOptions(**self.options)
            self.client = ClaudeSDKClient(options=code_options)
        else:
            self.client = ClaudeSDKClient()

        # Connect the client with retry logic for resume failures
        try:
            await self.client.connect()
        except Exception as e:
            # Check if this is a resume failure (session expired or invalid)
            if saved_session_id and "resume" in self.options:
                logger.warning(
                    f"Failed to resume session {saved_session_id} for task {self.task_id} "
                    f"(bot_id={self._bot_id}): {e}. "
                    f"Deleting invalid session file and retrying with fresh session."
                )
                # Delete the invalid session ID file for this specific bot
                SessionManager.delete_saved_session_id(self.task_id, self._bot_id)

                # Remove resume option and retry
                del self.options["resume"]
                saved_session_id = None

                # Recreate client without resume option
                if self.options:
                    code_options = ClaudeAgentOptions(**self.options)
                    self.client = ClaudeSDKClient(options=code_options)
                else:
                    self.client = ClaudeSDKClient()

                # Retry connection
                logger.info(
                    f"Retrying connection for task {self.task_id} with fresh session"
                )
                await self.client.connect()
            else:
                # Not a resume failure, re-raise the exception
                raise

        # Persist process PID for resume-session cleanup on next execution
        if saved_session_id:
            pid = None
            transport = getattr(self.client, "_transport", None)
            if transport is not None:
                process = getattr(transport, "_process", None)
                pid = getattr(process, "pid", None)

            if isinstance(pid, int):
                SessionManager.register_client_process(
                    self.task_id, self._bot_id, saved_session_id, pid
                )

        # Note: No longer caching client in SessionManager since each subtask
        # creates a new Agent instance and destroys it after completion.
        # Client is stored as self.client for use within this execution only.

        # Trigger callback to notify that client is created (e.g., for heartbeat update)
        if self.on_client_created_callback:
            try:
                if asyncio.iscoroutinefunction(self.on_client_created_callback):
                    await self.on_client_created_callback()
                else:
                    # Handle case where callback is a lambda that returns a coroutine
                    result = self.on_client_created_callback()
                    if asyncio.iscoroutine(result):
                        await result
            except Exception as e:
                logger.warning(f"Error in on_client_created_callback: {e}")

        # Register client as a resource for cleanup
        self.resource_manager.register_resource(
            task_id=self.task_id,
            resource_id=f"claude_client_{self.session_id}",
            is_async=True,
        )

    async def _close_client_for_retry(self) -> None:
        """
        Close the current client for retry purposes.

        This method closes the client connection but preserves the session_id
        so it can be used to resume the session with a new client.
        """
        if self.client is None:
            logger.warning("No client to close for retry")
            return

        try:
            # Terminate the client process
            await SessionManager._terminate_client_process(self.client, self.session_id)

            # Clear local client reference
            # Note: No longer using in-memory cache since each subtask creates new Agent instance
            self.client = None

            logger.info(
                f"Closed client for retry, session_id={self.session_id} preserved for resume"
            )
        except Exception as e:
            logger.warning(f"Error closing client for retry: {e}")
            # Clear client reference anyway to allow new client creation
            self.client = None

    async def _auto_close_session(self) -> None:
        """
        Auto-close the CC process after message completion (local mode only).

        Terminates the CC process but preserves the on-disk session ID file
        so the next message can resume. This frees the device slot immediately
        instead of keeping the process alive between messages.

        Note: No longer using in-memory cache since each subtask creates new Agent instance.
        """
        if config.EXECUTOR_MODE != "local":
            return

        if self.client is None:
            logger.debug("No client to auto-close")
            return

        try:
            logger.info(
                f"Auto-closing CC session after completion: "
                f"session_id={self.session_id}, task_id={self.task_id}"
            )

            # Terminate the CC process
            await SessionManager._terminate_client_process(self.client, self.session_id)

            # Clear local client reference
            # Note: No longer using in-memory cache since each subtask creates new Agent instance
            self.client = None

            # Trigger heartbeat callback to immediately update slot usage
            if self.on_client_created_callback:
                try:
                    if asyncio.iscoroutinefunction(self.on_client_created_callback):
                        await self.on_client_created_callback()
                    else:
                        result = self.on_client_created_callback()
                        if asyncio.iscoroutine(result):
                            await result
                except Exception as e:
                    logger.warning(f"Error in heartbeat callback after auto-close: {e}")

            logger.info(
                f"Auto-closed CC session: session_id={self.session_id}, "
                f"task_id={self.task_id}. Session ID preserved on disk for resume."
            )
        except Exception as e:
            logger.warning(f"Error auto-closing CC session: {e}")
            self.client = None

    def _handle_execution_result(
        self, result_content: str, execution_type: str = "execution"
    ) -> TaskStatus:
        """
        Handle the execution result and report progress

        Args:
            result_content: The content to handle
            execution_type: Type of execution for logging

        Returns:
            TaskStatus: Execution status
        """
        if result_content:
            logger.info(
                f"{execution_type} completed with content length: {len(result_content)}"
            )
            self.add_thinking_step(
                title="Execution Completed",
                report_immediately=False,
                use_i18n_keys=False,
                details={
                    "execution_type": execution_type,
                    "content_length": len(result_content),
                    "result_preview": (
                        result_content[:200] + "..."
                        if len(result_content) > 200
                        else result_content
                    ),
                },
            )
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                f"${{thinking.execution_completed}} {execution_type}",
                result=ExecutionResult(
                    value=result_content,
                    thinking=self.thinking_manager.get_thinking_steps(),
                ).model_dump(),
            )
            return TaskStatus.COMPLETED
        else:
            logger.warning(f"No content received from {execution_type}")
            self.add_thinking_step(
                title="Execution Failed",
                report_immediately=False,
                use_i18n_keys=False,
                details={"execution_type": execution_type},
            )
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"${{thinking.failed_no_content}} {execution_type}",
                result=ExecutionResult(
                    thinking=self.thinking_manager.get_thinking_steps()
                ).model_dump(),
            )
            return TaskStatus.FAILED

    def _handle_execution_error(
        self, error: Exception, execution_type: str = "execution"
    ) -> TaskStatus:
        """
        Handle execution error and report progress

        Args:
            error: The exception to handle
            execution_type: Type of execution for logging

        Returns:
            TaskStatus: Failed status
        """
        error_message = str(error)
        logger.exception(f"Error in {execution_type}: {error_message}")

        self.add_thinking_step(
            title="thinking.execution_failed",
            report_immediately=False,
            use_i18n_keys=False,
            details={"execution_type": execution_type, "error_message": error_message},
        )

        self.report_progress(
            100,
            TaskStatus.FAILED.value,
            f"${{thinking.execution_failed}} {execution_type}: {error_message}",
            result=ExecutionResult(
                thinking=self.thinking_manager.get_thinking_steps()
            ).model_dump(),
        )
        return TaskStatus.FAILED

    @classmethod
    async def close_client(cls, session_id: str) -> TaskStatus:
        """Close a specific client connection.

        Delegates to SessionManager.

        Args:
            session_id: Session ID to close

        Returns:
            TaskStatus: SUCCESS if closed, FAILED otherwise
        """
        success = await SessionManager.close_client(session_id)
        return TaskStatus.SUCCESS if success else TaskStatus.FAILED

    @classmethod
    async def close_all_clients(cls) -> None:
        """Close all client connections.

        Delegates to SessionManager.
        """
        await SessionManager.close_all_clients()

    @classmethod
    async def cleanup_task_clients(cls, task_id: int) -> int:
        """Close all client connections for a specific task_id.

        Delegates to SessionManager.

        Args:
            task_id: Task ID to cleanup clients for

        Returns:
            Number of clients cleaned up
        """
        return await SessionManager.cleanup_task_clients(task_id)

    def cancel_run(self) -> bool:
        """
        Cancel the current running task using multi-level cancellation strategy:
        1. Set cancellation state to CANCELLED immediately (not CANCELLING)
        2. Try SDK interrupt
        3. No longer send callback here, it will be sent asynchronously by background task to avoid blocking
        4. Wait briefly for cleanup

        Returns:
            bool: True if cancellation was successful, False otherwise
        """
        try:
            # Step 1: Immediately set to CANCELLED state (skip CANCELLING)
            # This ensures response_processor checks will immediately detect cancellation
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            logger.info(f"Task {self.task_id} marked as cancelled immediately")

            # Step 2: Try SDK interrupt if client is available
            if self.client and hasattr(self.client, "interrupt"):
                self._sync_cancel_run()
                logger.info(f"Sent interrupt signal to task {self.task_id}")
            else:
                logger.warning(
                    f"No client or interrupt method available for task {self.task_id}"
                )

            # Step 3: Wait briefly (2 seconds max) for graceful cleanup
            max_wait = min(config.GRACEFUL_SHUTDOWN_TIMEOUT, 2)
            waited = 0
            while waited < max_wait:
                # Check if cleanup completed (task state is None means cleaned up)
                if self.task_state_manager.get_state(self.task_id) is None:
                    logger.info(f"Task {self.task_id} cleaned up gracefully")
                    return True
                time.sleep(0.1)  # Check more frequently (100ms)
                waited += 0.1

            # Note: No longer send callback here
            # Callback will be sent asynchronously by background task in main.py to avoid blocking executor_manager's cancel request
            logger.info(
                f"Task {self.task_id} cancelled (cleanup may continue in background), callback will be sent asynchronously"
            )
            return True

        except Exception as e:
            logger.exception(f"Error cancelling task {self.task_id}: {e}")
            # Ensure cancelled state even on error
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            return False

    def _sync_cancel_run(self) -> None:
        """
        Synchronous helper method to cancel the current run
        """
        try:
            if self.client is not None:
                # Check if we're in an async context
                try:
                    loop = asyncio.get_running_loop()
                    # If we're in an async context, create a task
                    asyncio.create_task(self._async_cancel_run())
                except RuntimeError:
                    # No running event loop, run the async method in a new loop
                    # Copy ContextVars before creating new event loop
                    try:
                        from shared.telemetry.context import (
                            copy_context_vars,
                            restore_context_vars,
                        )

                        saved_context = copy_context_vars()
                    except ImportError:
                        saved_context = None

                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        # Restore ContextVars in the new event loop
                        if saved_context:
                            restore_context_vars(saved_context)
                        loop.run_until_complete(self._async_cancel_run())
                    finally:
                        loop.close()
        except Exception as e:
            logger.exception(
                f"Error during sync interrupt for session_id {self.session_id}: {str(e)}"
            )

    async def _async_cancel_run(self) -> None:
        """
        Asynchronous helper method to cancel the current run.
        No longer send callback, handled by background task.
        """
        try:
            if self.client is not None:
                await self.client.interrupt()
                logger.info(
                    f"Successfully sent interrupt to client for session_id: {self.session_id}"
                )
        except Exception as e:
            logger.exception(
                f"Error during async interrupt for session_id {self.session_id}: {str(e)}"
            )

    def _update_git_exclude(self, project_path: str) -> None:
        """Update .git/info/exclude to ignore .claudecode directory.

        Args:
            project_path: Project root directory
        """
        add_to_git_exclude(project_path, ".claudecode/")

    def _download_attachments(self) -> None:
        """Download attachments from Backend API to workspace.

        Uses attachment_handler module to download attachments and update prompt.
        """
        result = download_attachments(
            self.task_data,
            self.task_id,
            self.subtask_id,
            self.prompt,
        )

        # Update prompt with processed content
        self.prompt = result.prompt

        # Store image content blocks for potential vision support
        self._image_content_blocks = result.image_content_blocks

        # Add thinking step if successful
        details = get_attachment_thinking_step_details(result)
        if details:
            self.add_thinking_step_by_key(
                title_key="thinking.attachments_downloaded",
                report_immediately=False,
                details=details,
            )

    def _build_skill_emphasis_prompt(self, user_selected_skills: List[str]) -> str:
        """Build skill emphasis prompt for user-selected skills.

        Delegates to skill_deployer module.

        Args:
            user_selected_skills: List of skill names that the user explicitly selected

        Returns:
            Skill emphasis prompt to prepend to the user's message
        """
        return build_skill_emphasis_prompt(user_selected_skills)
