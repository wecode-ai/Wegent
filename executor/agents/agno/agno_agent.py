#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import json
import os
from typing import Dict, Any, Optional, Tuple, List

from agno.team import Team
from agno.agent import Agent as AgnoSDKAgent, RunEvent
from agno.team.team import TeamRunEvent
from agno.db.sqlite import SqliteDb
from executor.agents.base import Agent
from executor.config.config import EXECUTOR_ENV, DEBUG_RUN
from shared.logger import setup_logger
from shared.models.task import ExecutionResult, ThinkingStep
from shared.status import TaskStatus
from shared.telemetry.decorators import trace_async, add_span_event

from .config_utils import ConfigManager
from .member_builder import MemberBuilder
from .model_factory import ModelFactory
from .mcp_manager import MCPManager
from .team_builder import TeamBuilder
from .thinking_step_manager import ThinkingStepManager
from executor.tasks.task_state_manager import TaskStateManager, TaskState
from executor.tasks.resource_manager import ResourceManager

db = SqliteDb(db_file="/tmp/agno_data.db")
logger = setup_logger("agno_agent")


def _extract_agno_agent_attributes(self, *args, **kwargs) -> dict:
    """Extract trace attributes from AgnoAgent instance."""
    return {
        "task.id": str(self.task_id),
        "task.subtask_id": str(self.subtask_id),
        "agent.type": "Agno",
        "agent.session_id": str(self.session_id),
        "agent.mode": self.mode or "default",
    }


class AgnoAgent(Agent):
    """
    Agno Agent that integrates with Agno SDK
    """

    # Static dictionary for storing client connections to enable connection reuse
    _clients: Dict[str, Any] = {}

    def get_name(self) -> str:
        return "Agno"

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the Agno Agent

        Args:
            task_data: The task data dictionary
        """
        super().__init__(task_data)
        self.client = None
        self.session_id = self.task_id
        self.prompt = task_data.get("prompt", "")
        self.project_path = None

        self.team: Optional[Team] = None
        self.single_agent: Optional[AgnoSDKAgent] = None
        self.current_run_id: Optional[str] = None

        self.mode = task_data.get("mode", "")
        self.task_data = task_data

        # Initialize thinking step manager first
        self.thinking_manager = ThinkingStepManager(progress_reporter=self.report_progress)

        # Initialize configuration manager
        self.config_manager = ConfigManager(EXECUTOR_ENV)

        # Extract Agno options from task_data
        self.options = self.config_manager.extract_agno_options(task_data)

        # Initialize team builder
        self.team_builder = TeamBuilder(db, self.config_manager, self.thinking_manager)

        # Initialize member builder
        self.member_builder = MemberBuilder(db, self.config_manager, self.thinking_manager)

        # debug mode
        self.debug_mode: bool = DEBUG_RUN != ""

        # stream mode
        self.enable_streaming: bool = True

        # Initialize task state manager for cancellation support
        self.task_state_manager = TaskStateManager()
        self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)
        
        # Initialize resource manager for resource cleanup
        self.resource_manager = ResourceManager()

    def add_thinking_step(self, title: str, report_immediately: bool = True,
                         use_i18n_keys: bool = False, details: Optional[Dict[str, Any]] = None) -> None:
        """
        Add a thinking step (wrapper for backward compatibility)
        
        Args:
            title: Step title
            action: Action description (ignored, kept for backward compatibility)
            reasoning: Reasoning process (ignored, kept for backward compatibility)
            result: Result (ignored, kept for backward compatibility)
            confidence: Confidence level (ignored, kept for backward compatibility)
            next_action: Next action (ignored, kept for backward compatibility)
            report_immediately: Whether to report this thinking step immediately (default True)
            use_i18n_keys: Whether to use i18n key directly instead of English text (default False)
            details: Additional details for the thinking step (optional)
        """
        # Only pass the 4 required parameters to ThinkingStepManager
        self.thinking_manager.add_thinking_step(
            title=title,
            report_immediately=report_immediately,
            use_i18n_keys=use_i18n_keys,
            details=details
        )
    
    def add_thinking_step_by_key(self, title_key: str, report_immediately: bool = True, details: Optional[Dict[str, Any]] = None) -> None:
        """
        Add a thinking step using i18n key (wrapper for backward compatibility)

        Args:
            title_key: i18n key for step title
            action_key: i18n key for action description (ignored, kept for backward compatibility)
            reasoning_key: i18n key for reasoning process (ignored, kept for backward compatibility)
            result_key: i18n key for result (ignored, kept for backward compatibility)
            confidence: Confidence level (ignored, kept for backward compatibility)
            next_action_key: i18n key for next action (ignored, kept for backward compatibility)
            report_immediately: Whether to report this thinking step immediately (default True)
            details: Additional details for thinking step (optional)
        """
        # Only pass the 3 required parameters to ThinkingStepManager
        self.thinking_manager.add_thinking_step_by_key(
            title_key=title_key,
            report_immediately=report_immediately,
            details=details
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
        Initialize the Agno Agent with configuration from task_data.

        Returns:
            TaskStatus: Initialization status
        """
        try:
            # Check if task was cancelled before initialization
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} was cancelled before initialization")
                return TaskStatus.COMPLETED
            
            logger.info("Initializing Agno Agent")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_agent",
                report_immediately=False
            )
            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Agno Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_failed",
                report_immediately=False,
                details={"error": str(e)}
            )
            return TaskStatus.FAILED

    async def _create_agent(self) -> Optional[AgnoSDKAgent]:
        """
        Create a team with configured members
        """
        agents = await self.member_builder.create_members_from_config(self.options["team_members"], self.task_data)
        if len(agents) < 0:
            return None
        return agents[0]

    async def _create_team(self) -> Optional[Team]:
        """
        Create a team with configured members
        """
        return await self.team_builder.create_team(self.options, self.mode, self.session_id, self.task_data)

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution setup for Agno Agent

        Returns:
            TaskStatus: Pre-execution status
        """
        # Download code if git_url is provided
        try:
            git_url = self.task_data.get("git_url")
            if git_url and git_url != "":
                self.add_thinking_step_by_key(
                    title_key="thinking.download_code",
                    report_immediately=False,
                    details={"git_url": git_url}
                )
                self.download_code()
        except Exception as e:
            logger.error(f"Pre-execution failed: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.pre_execution_failed",
                report_immediately=False,
                details={"error": str(e)}
            )
            return TaskStatus.FAILED

        return TaskStatus.SUCCESS

    def execute(self) -> TaskStatus:
        """
        Execute the Agno Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            progress = 55
            # Update current progress
            self._update_progress(progress)
            # Report starting progress
            self.report_progress(
                progress, TaskStatus.RUNNING.value, "Starting Agno Agent", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

            # Check if currently running in coroutine
            try:
                # Try to get current running event loop
                loop = asyncio.get_running_loop()
                # If we can get running event loop, we're in coroutine
                # Call async version directly
                logger.info(
                    "Detected running in an async context, calling execute_async"
                )
                # Create async task to run in background, but return PENDING instead of task object
                asyncio.create_task(self.execute_async())
                logger.info(
                    "Created async task for execution, returning RUNNING status"
                )
                return TaskStatus.RUNNING
            except RuntimeError:
                # No running event loop, can safely use run_until_complete
                logger.info("No running event loop detected, using new event loop")
                self.add_thinking_step_by_key(
                    title_key="thinking.sync_execution",
                    report_immediately=False
                )
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    return loop.run_until_complete(self._async_execute())
                finally:
                    loop.close()
        except Exception as e:
            return self._handle_execution_error(e, "Agno Agent execution")

    @trace_async(
        span_name="agno_execute_async",
        tracer_name="executor.agents.agno",
        extract_attributes=_extract_agno_agent_attributes
    )
    async def execute_async(self) -> TaskStatus:
        """
        Execute Agno Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            self.add_thinking_step_by_key(
                title_key="thinking.async_execution_started",
                report_immediately=False
            )
            # Update current progress
            self._update_progress(60)
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.starting_agent_async}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )
            
            # Add trace event for async execution started
            add_span_event("async_execution_started")
            
            return await self._async_execute()
        except Exception as e:
            return self._handle_execution_error(e, "Agno Agent async execution")

    async def _async_execute(self) -> TaskStatus:
        """
        Asynchronous execution of the Agno Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Checkpoint 1: Check cancellation before execution starts
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled before execution")
                return TaskStatus.COMPLETED
            
            progress = 65
            # Update current progress
            self._update_progress(progress)
            # Check if a team already exists for the corresponding task_id
            # Check if a team already exists for the corresponding task_id
            if self.session_id in self._clients:
                logger.info(
                    f"Reusing existing Agno team for session_id: {self.session_id}"
                )
                self.add_thinking_step_by_key(
                    title_key="thinking.reuse_existing_team",
                    report_immediately=False,
                    details={"session_id": self.session_id}
                )
                tmp = self._clients[self.session_id]
                if isinstance(tmp, Team):
                    self.team = tmp
                elif isinstance(tmp, AgnoSDKAgent):
                    self.single_agent = tmp

            else:
                # Create new team
                logger.info(
                    f"Creating new Agno team for session_id: {self.session_id}"
                )
                self.team = await self._create_team()
                progress = 70
                # Update current progress
                self._update_progress(progress)
                if self.team is not None:
                    # Store team for reuse
                    self._clients[self.session_id] = self.team
                else:
                    self.single_agent = await self._create_agent()
                    self._clients[self.session_id] = self.single_agent
            
            # Checkpoint 2: Check cancellation after team/agent creation
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled after team/agent creation")
                return TaskStatus.COMPLETED
            
            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd")
            if self.task_data.get("git_url"):
                prompt = prompt + "\nProject URL: " + self.task_data.get("git_url")

            logger.info(f"Executing Agno team with prompt: {prompt}")

            progress = 75
            # Update current progress
            self._update_progress(progress)
            # Execute the team run
            result = await self._run_async(prompt)

            return result

        except Exception as e:
            return self._handle_execution_error(e, "async execution")

    def _normalize_result_content(self, result: Any) -> str:
        """
        Normalize the result into a string
        
        Args:
            result: The result to normalize
            
        Returns:
            str: Normalized result content
        """
        result_content: str = ""
        try:
            if result is None:
                result_content = ""
            elif hasattr(result, "content") and getattr(result, "content") is not None:
                result_content = str(getattr(result, "content"))
            elif hasattr(result, "to_dict"):
                result_content = json.dumps(result.to_dict(), ensure_ascii=False)
            else:
                result_content = str(result)
        except Exception:
            # Fallback to string coercion
            result_content = str(result)
        
        return result_content

    def _handle_execution_result(self, result_content: str, execution_type: str = "execution", reasoning=None) -> TaskStatus:
        """
        Handle the execution result and report progress
        
        Args:
            result_content: The content to handle
            execution_type: Type of execution for logging
            
        Returns:
            TaskStatus: Execution status
        """
        if reasoning is None:
            reasoning = self.thinking_manager.get_thinking_steps()

        if result_content is not None:
            logger.info(
                f"{execution_type} completed with content length: {len(result_content)}"
            )
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                f"${{thinking.execution_completed}} {execution_type}",
                result=ExecutionResult(value=result_content, thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
            return TaskStatus.COMPLETED
        else:
            logger.warning(f"No content received from {execution_type}")
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"${{thinking.failed_no_content}} {execution_type}",
                result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
            return TaskStatus.FAILED

    def _handle_execution_error(self, error: Exception, execution_type: str = "execution") -> TaskStatus:
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
        
        # Add thinking step for execution failure
        self.add_thinking_step_by_key(
            title_key="thinking.execution_failed",
            report_immediately=False,
            details={"error_message": error_message, "execution_type": execution_type}
        )
        
        self.report_progress(
            100,
            TaskStatus.FAILED.value,
            f"${{thinking.execution_failed}} {execution_type}: {error_message}",
            result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
        )
        return TaskStatus.FAILED

    async def _handle_agent_streaming_event(self, run_response_event, result_content: str) -> str:
        """
        Handle agent streaming events

        Args:
            run_response_event: The streaming event
            result_content: Current result content

        Returns:
            str: Updated result content
        """
        # Handle agent run events
        if run_response_event.event in [RunEvent.run_started]:
            logger.info(f"🚀 AGENT RUN STARTED: {run_response_event.agent_id}")
            # Store run_id for cancel_run functionality
            if hasattr(run_response_event, 'run_id'):
                self.current_run_id = run_response_event.run_id
                logger.info(f"Stored run_id: {self.current_run_id}")
            self.report_progress(
                75, TaskStatus.RUNNING.value, "${{thinking.agent_execution_started}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

        # Handle agent run completion
        if run_response_event.event in [RunEvent.run_completed]:
            logger.info(f"✅ AGENT RUN COMPLETED: {run_response_event.agent_id}")

        # Handle tool call events
        if run_response_event.event in [RunEvent.tool_call_started]:
            logger.info(f"🔧 AGENT TOOL STARTED: {run_response_event.tool.tool_name}")
            logger.info(f"   Args: {run_response_event.tool.tool_args}")
            
            # Build tool call details in target format
            tool_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": getattr(run_response_event.tool, 'id', ''),
                        "name": run_response_event.tool.tool_name,
                        "input": run_response_event.tool.tool_args
                    }]
                }
            }
            
            self.add_thinking_step_by_key(
                title_key="thinking.tool_use",
                report_immediately=True,
                details=tool_details
            )
            
            self.report_progress(
                80, TaskStatus.RUNNING.value, f"${{thinking.using_tool}} {run_response_event.tool.tool_name}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

        if run_response_event.event in [RunEvent.tool_call_completed]:
            logger.info(f"✅ AGENT TOOL COMPLETED: {run_response_event.tool.tool_name}")
            logger.info(f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}...")
            
            # Build tool result details in target format
            tool_result_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": getattr(run_response_event.tool, 'id', ''),
                        "content": run_response_event.tool.result,
                        "is_error": False
                    }]
                }
            }
            
            self.add_thinking_step_by_key(
                title_key="thinking.tool_result",
                report_immediately=True,
                details=tool_result_details
            )

        # Handle content generation
        if run_response_event.event in [RunEvent.run_content]:
            content_chunk = run_response_event.content
            if content_chunk:
                result_content += str(content_chunk)
        
        return result_content

    def _get_team_config(self) -> Dict[str, Any]:
        """
        Get team configuration based on mode
        
        Returns:
            Dict[str, Any]: Team configuration
        """
        ext_config = {}
        if self.mode == "coordinate":
            ext_config = {
                "show_full_reasoning": True,
            }
        return ext_config

    async def _run_async(self, prompt: str) -> TaskStatus:
        if self.team:
            logger.info("_run_team_async")
            return await self._run_team_async(prompt)
        elif self.single_agent:
            logger.info("_run_agent_async")
            return await self._run_agent_async(prompt)
        else:
            logger.error(f"The team and agent is None.")
            return TaskStatus.FAILED

    async def _run_agent_async(self, prompt: str) -> TaskStatus:
        """
        Run the agent asynchronously with the given prompt

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if streaming is enabled in options
            # enable_streaming = self.options.get("stream", False)
            enable_streaming = self.enable_streaming

            if enable_streaming:
                return await self._run_agent_streaming_async(prompt)
            else:
                return await self._run_agent_non_streaming_async(prompt)

        except Exception as e:
            return self._handle_execution_error(e, "agent execution")

    async def _run_agent_non_streaming_async(self, prompt: str) -> TaskStatus:
        """
        Run the agent asynchronously with non-streaming mode

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Run to completion (non-streaming) and gather final output
            result = await self.single_agent.arun(
                prompt,
                stream=False,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2
            )

            logger.info(f"agent run success. result:{json.dumps(result.to_dict())}")
            result_content = self._normalize_result_content(result)
            return self._handle_execution_result(result_content, "agent execution")

        except Exception as e:
            return self._handle_execution_error(e, "agent execution (non-streaming)")



    async def _run_agent_streaming_async(self, prompt: str) -> TaskStatus:
        """
        Run the agent asynchronously with streaming mode

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            content_started = False
            result_content = ""
            # Update current progress
            self._update_progress(70)
            # Report initial progress
            self.report_progress(
                70, TaskStatus.RUNNING.value, "${{thinking.starting_agent_streaming}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

            self.add_thinking_step_by_key(
                title_key="thinking.agent_streaming_execution",
                report_immediately=False
            )

            # Run with streaming enabled
            async for run_response_event in self.single_agent.arun(
                prompt,
                stream=True,
                stream_intermediate_steps=True,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2
            ):
                # Checkpoint: Check cancellation during streaming
                if self.task_state_manager.is_cancelled(self.task_id):
                    logger.info(f"Task {self.task_id} cancelled during agent streaming")
                    return TaskStatus.COMPLETED
                
                result_content = await self._handle_agent_streaming_event(
                    run_response_event, result_content
                )

            # Check if task was cancelled
            if self.task_state_manager.is_cancelled(self.task_id):
                return TaskStatus.COMPLETED
            
            return self._handle_execution_result(result_content, "agent streaming execution")

        except Exception as e:
            return self._handle_execution_error(e, "agent streaming execution")

    async def _run_team_async(self, prompt: str) -> TaskStatus:
        """
        Run the team asynchronously with the given prompt

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if streaming is enabled in options
            enable_streaming = self.enable_streaming
            
            if enable_streaming:
                return await self._run_team_streaming_async(prompt)
            else:
                return await self._run_team_non_streaming_async(prompt)

        except Exception as e:
            return self._handle_execution_error(e, "team execution")

    async def _run_team_non_streaming_async(self, prompt: str) -> TaskStatus:
        """
        Run the team asynchronously with non-streaming mode

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            ext_config = self._get_team_config()
            # Run to completion (non-streaming) and gather final output
            result = await self.team.arun(
                prompt,
                stream=False,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2,
                show_members_responses=True,
                stream_intermediate_steps=True,
                markdown=True,
                **ext_config
            )

            logger.info(f"team run success. result:{json.dumps(result.to_dict(), ensure_ascii=False)}")
            result_content = self._normalize_result_content(result)
            return self._handle_execution_result(result_content, "team execution")

        except Exception as e:
            return self._handle_execution_error(e, "team execution (non-streaming)")

    async def _run_team_streaming_async(self, prompt: str) -> TaskStatus:
        """
        Run the team asynchronously with streaming mode

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            ext_config = self._get_team_config()

            content_started = False
            result_content = ""
            # Update current progress
            self._update_progress(70)
            # Report initial progress
            self.report_progress(
                70, TaskStatus.RUNNING.value, "${{thinking.starting_team_streaming}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

            # Run with streaming enabled
            async for run_response_event in self.team.arun(
                prompt,
                stream=True,
                stream_intermediate_steps=True,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2,
                show_members_responses=True,
                markdown=True,
                **ext_config
            ):
                # Checkpoint: Check cancellation during streaming
                if self.task_state_manager.is_cancelled(self.task_id):
                    logger.info(f"Task {self.task_id} cancelled during team streaming")
                    return TaskStatus.COMPLETED
                
                result_content, reasoning = await self._handle_team_streaming_event(
                    run_response_event, result_content
                )
                # Thinking steps are already handled in _handle_team_streaming_event
                # Here we only need to report progress, no need to add thinking again

            # Check if task was cancelled
            if self.task_state_manager.is_cancelled(self.task_id):
                return TaskStatus.COMPLETED
            
            return self._handle_execution_result(result_content, "team streaming execution")

        except Exception as e:
            return self._handle_execution_error(e, "team streaming execution")

    async def _handle_team_streaming_event(self, run_response_event, result_content: str) -> Tuple[str, Optional[Any]]:
        """
        Handle team streaming events
        
        Args:
            run_response_event: The streaming event
            result_content: Current result content
            
        Returns:
            str: Updated result content
        """
        reasoning = None

        if run_response_event.event != "TeamRunContent" and run_response_event.event != "RunContent":
            logger.info(f"\nStreaming content: {json.dumps(run_response_event.to_dict(), ensure_ascii=False)}")

        if run_response_event.event == "TeamReasoningStep":
            reasoning = run_response_event.content
            # Convert team reasoning step to ThinkingStep format
            if reasoning:
                # Handle None values to prevent Pydantic validation errors
                action_value = reasoning.action if reasoning.action is not None else ""
                confidence_value = reasoning.confidence if reasoning.confidence is not None else 0.5
                next_action_value = reasoning.next_action if reasoning.next_action is not None else "continue"
                
                # Build reasoning step details in target format
                reasoning_details = {
                    "type": "assistant",
                    "message": {
                        "id": getattr(run_response_event, 'id', ''),
                        "type": "message",
                        "role": "assistant",
                        "model": "agno-team",
                        "content": [{
                            "type": "text",
                            "text": f"{reasoning.title}\n\nAction: {action_value}\nReasoning: {reasoning.reasoning}\nConfidence: {confidence_value}\nNext Action: {next_action_value}"
                        }],
                        "stop_reason": None,
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0
                        }
                    },
                    "parent_tool_use_id": None
                }
                
                self.add_thinking_step_by_key(
                    title_key="thinking.assistant_message_received",
                    report_immediately=False,
                    details=reasoning_details
                )

        # Handle team-level events
        if run_response_event.event in [
            TeamRunEvent.run_started,
            TeamRunEvent.run_completed,
        ]:
            logger.info(f"\n🎯 TEAM EVENT: {run_response_event.event}")
            if run_response_event.event == TeamRunEvent.run_started:
                # Store run_id for cancel_run functionality
                if hasattr(run_response_event, 'run_id'):
                    self.current_run_id = run_response_event.run_id
                    logger.info(f"Stored run_id: {self.current_run_id}")
                self.report_progress(
                    75, TaskStatus.RUNNING.value, "${{thinking.team_execution_started}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
                )

        # Handle team tool call events
        if run_response_event.event in [TeamRunEvent.tool_call_started]:
            logger.info(f"\n🔧 TEAM TOOL STARTED: {run_response_event.tool.tool_name}")
            logger.info(f"   Args: {run_response_event.tool.tool_args}")
            
            # Build team tool call details in target format
            team_tool_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": getattr(run_response_event.tool, 'id', ''),
                        "name": run_response_event.tool.tool_name,
                        "input": run_response_event.tool.tool_args
                    }]
                }
            }

            self.add_thinking_step_by_key(
                title_key="thinking.tool_use",
                report_immediately=False,
                details=team_tool_details
            )
            self.report_progress(
                80, TaskStatus.RUNNING.value, f"${{thinking.team_using_tool}} {run_response_event.tool.tool_name}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

        if run_response_event.event in [TeamRunEvent.tool_call_completed]:
            logger.info(f"\n✅ TEAM TOOL COMPLETED: {run_response_event.tool.tool_name}")
            
            # Build team tool result details in target format
            team_tool_result_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": getattr(run_response_event.tool, 'id', ''),
                        "content": run_response_event.tool.result,
                        "is_error": False
                    }]
                }
            }
            
            self.add_thinking_step_by_key(
                title_key="thinking.tool_result",
                report_immediately=False,
                details=team_tool_result_details
            )
            logger.info(f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}...")

        # Handle member-level events
        if run_response_event.event in [RunEvent.tool_call_started]:
            logger.info(f"\n🤖 MEMBER TOOL STARTED: {run_response_event.agent_id}")
            logger.info(f"   Tool: {run_response_event.tool.tool_name}")
            logger.info(f"   Args: {run_response_event.tool.tool_args}")
            
            # Build member tool call details in target format
            member_tool_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": getattr(run_response_event.tool, 'id', ''),
                        "name": run_response_event.tool.tool_name,
                        "input": run_response_event.tool.tool_args
                    }]
                }
            }
            
            self.add_thinking_step_by_key(
                title_key="thinking.tool_use",
                report_immediately=False,
                details=member_tool_details
            )

        if run_response_event.event in [RunEvent.tool_call_completed]:
            logger.info(f"\n✅ MEMBER TOOL COMPLETED: {run_response_event.agent_id}")
            logger.info(f"   Tool: {run_response_event.tool.tool_name}")
            logger.info(
                f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}..."
            )
            
            # Build member tool result details in target format
            member_tool_result_details = {
                "type": "assistant",
                "message": {
                    "id": getattr(run_response_event, 'id', ''),
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": getattr(run_response_event.tool, 'id', ''),
                        "content": run_response_event.tool.result,
                        "is_error": False
                    }]
                }
            }
            
            self.add_thinking_step_by_key(
                title_key="thinking.tool_result",
                report_immediately=False,
                details=member_tool_result_details
            )

        # Handle content generation
        if run_response_event.event in [TeamRunEvent.run_content]:
            content_chunk = run_response_event.content
            if content_chunk:
                result_content += str(content_chunk)
        
        return result_content, reasoning

    @classmethod
    async def close_client(cls, session_id: str) -> TaskStatus:
        try:
            if session_id in cls._clients:
                client = cls._clients[session_id]
                # Try to cancel the current run if run_id is available
                # Note: We need the agent instance to get the run_id
                # For now, we'll attempt to call cancel_run with session_id as run_id
                # This may need refinement based on actual usage
                try:
                    if isinstance(client, Team) or isinstance(client, AgnoSDKAgent):
                        # Attempt to cancel any running tasks
                        # The actual run_id should be tracked at the agent instance level
                        logger.info(f"Attempting to cancel run for session_id: {session_id}")
                        # We cannot directly access run_id here, so we skip cancellation
                        # Cancellation should be done through the agent instance's cancel_run method
                except Exception as e:
                    logger.warning(f"Could not cancel run for session_id {session_id}: {str(e)}")

                # Clean up client resources
                del cls._clients[session_id]
                logger.info(f"Closed Agno client for session_id: {session_id}")
                return TaskStatus.SUCCESS
            return TaskStatus.FAILED
        except Exception as e:
            logger.exception(
                f"Error closing client for session_id {session_id}: {str(e)}"
            )
            return TaskStatus.FAILED

    @classmethod
    async def close_all_clients(cls) -> None:
        """
        Close all client connections
        """
        for session_id, client in list(cls._clients.items()):
            try:
                # Attempt to cancel any running tasks
                # Note: We don't have access to run_id here
                # Cancellation should ideally be done at the agent instance level
                logger.info(f"Closing Agno client for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()

    def cancel_run(self) -> bool:
        """
        Cancel the current running task for this agent instance

        Supports cancellation at any stage of the task lifecycle:
        1. Immediately mark state as CANCELLED (not CANCELLING)
        2. If task is executing (has run_id), call SDK's cancel_run()
        3. No longer send callback here, it will be sent asynchronously by background task to avoid blocking

        Returns:
            bool: True if cancellation was successful, False otherwise
        """
        try:
            # Layer 1: Immediately mark state as CANCELLED
            # This ensures execution loops will immediately detect cancellation
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            logger.info(f"Marked task {self.task_id} as CANCELLED immediately")

            # Layer 2: If run_id exists, call SDK's cancel_run()
            cancelled = False
            if self.current_run_id is not None:
                if self.team is not None:
                    logger.info(f"Cancelling team run with run_id: {self.current_run_id}")
                    cancelled = self.team.cancel_run(self.current_run_id)
                elif self.single_agent is not None:
                    logger.info(f"Cancelling agent run with run_id: {self.current_run_id}")
                    cancelled = self.single_agent.cancel_run(self.current_run_id)

                if cancelled:
                    logger.info(f"Successfully cancelled run_id: {self.current_run_id}")
                    self.current_run_id = None
                else:
                    logger.warning(f"Failed to cancel run_id: {self.current_run_id}")
            else:
                # Task hasn't started executing yet, no run_id
                # State is already marked as CANCELLED, execution will exit immediately
                logger.info(f"Task {self.task_id} has no run_id yet, cancelled before execution")
                cancelled = True  # Consider cancellation successful

            # Note: No longer send callback here
            # Callback will be sent asynchronously by background task in main.py to avoid blocking executor_manager's cancel request
            logger.info(f"Task {self.task_id} cancellation completed, callback will be sent asynchronously")

            return cancelled

        except Exception as e:
            logger.exception(f"Error cancelling task {self.task_id}: {str(e)}")
            # Ensure cancelled state even on error
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            return False

    async def cleanup(self) -> None:
        """
        Clean up resources used by the agent
        """
        await self.team_builder.cleanup()

