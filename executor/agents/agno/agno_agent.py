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

from .config_utils import ConfigManager
from .member_builder import MemberBuilder
from .model_factory import ModelFactory
from .mcp_manager import MCPManager
from .team_builder import TeamBuilder
from .thinking_step_manager import ThinkingStepManager

db = SqliteDb(db_file="/tmp/agno_data.db")
logger = setup_logger("agno_agent")


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

        self.mode = task_data.get("mode", "")
        self.task_data = task_data

        # Initialize configuration manager
        self.config_manager = ConfigManager(EXECUTOR_ENV)
        
        # Extract Agno options from task_data
        self.options = self.config_manager.extract_agno_options(task_data)
        
        # Initialize team builder
        self.team_builder = TeamBuilder(db, self.config_manager)

        # Initialize member builder
        self.member_builder = MemberBuilder(db, self.config_manager)

        # debug mode
        self.debug_mode: bool = DEBUG_RUN != ""

        # stream mode
        self.enable_streaming: bool = True
        
        # Initialize thinking step manager
        self.thinking_manager = ThinkingStepManager(progress_reporter=self.report_progress)

    def add_thinking_step(self, title: str, action: str, reasoning: str,
                         result: str = "", confidence: float = -1,
                         next_action: str = "continue", report_immediately: bool = True) -> None:
        """
        Add a thinking step
        
        Args:
            title: Step title
            action: Action description
            reasoning: Reasoning process
            result: Result (optional)
            confidence: Confidence level (0.0-1.0, default -1)
            next_action: Next action (default "continue")
            report_immediately: Whether to report this thinking step immediately (default True)
        """
        self.thinking_manager.add_thinking_step(
            title, action, reasoning, result, confidence, next_action, report_immediately
        )
    
    def add_thinking_step_by_key(self, title_key: str, action_key: str, reasoning_key: str,
                                result_key: str = "", confidence: float = -1,
                                next_action_key: str = "thinking.continue",
                                report_immediately: bool = True) -> None:
        """
        Add a thinking step using i18n key

        Args:
            title_key: i18n key for step title
            action_key: i18n key for action description
            reasoning_key: i18n key for reasoning process
            result_key: i18n key for result (optional)
            confidence: Confidence level (0.0-1.0, default -1)
            next_action_key: i18n key for next action (default "thinking.continue")
            report_immediately: Whether to report this thinking step immediately (default True)
        """
        self.thinking_manager.add_thinking_step_by_key(
            title_key, action_key, reasoning_key, result_key,
            confidence, next_action_key, report_immediately
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
            logger.info("Initializing Agno Agent")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_agent",
                action_key="thinking.starting_initialization",
                reasoning_key="thinking.initializing_with_config",
                report_immediately=False
            )
            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Agno Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_failed",
                action_key="thinking.failed_initialize",
                reasoning_key=f"${{thinking.initialization_error}} {str(e)}",
                next_action_key="thinking.exit",
                report_immediately=False
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
            self.add_thinking_step_by_key(
                title_key="thinking.pre_execution_setup",
                action_key="thinking.starting_pre_execution",
                reasoning_key="thinking.setting_up_environment",
                report_immediately=False
            )
            
            git_url = self.task_data.get("git_url")
            if git_url and git_url != "":
                self.add_thinking_step_by_key(
                    title_key="thinking.download_code",
                    action_key=f"${{thinking.downloading_code_from}} {git_url}",
                    reasoning_key="thinking.code_download_required",
                    report_immediately=False
                )
                self.download_code()
                self.add_thinking_step_by_key(
                    title_key="thinking.download_code_completed",
                    action_key="thinking.code_download_success",
                    reasoning_key="thinking.code_ready",
                    result_key="thinking.code_download_success",
                    report_immediately=False
                )
        except Exception as e:
            logger.error(f"Pre-execution failed: {str(e)}")
            self.add_thinking_step(
                title="Pre-execution Failed",
                action="Pre-execution setup failed",
                reasoning=f"Pre-execution failed with error: {str(e)}",
                next_action="exit",
                report_immediately=False
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
            
            self.add_thinking_step_by_key(
                title_key="thinking.execute_task",
                action_key="thinking.starting_execution",
                reasoning_key="thinking.beginning_execution",
                report_immediately=False
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
                self.add_thinking_step(
                    title="Async Execution",
                    action="Detected async context, switching to async execution",
                    reasoning="Running in coroutine context, will execute asynchronously",
                    report_immediately=False
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
                self.add_thinking_step(
                    title="Sync Execution",
                    action="No async context detected, creating new event loop",
                    reasoning="Not in coroutine context, will create new event loop for execution",
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

    async def execute_async(self) -> TaskStatus:
        """
        Execute Agno Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            self.add_thinking_step(
                title="Async Execution Started",
                action="Starting asynchronous execution",
                reasoning="Task is now executing in async mode",
                report_immediately=False)
            # Update current progress
            self._update_progress(60)
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.starting_agent_async}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )
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
            progress = 65
            # Update current progress
            self._update_progress(progress)
            # Check if a team already exists for the corresponding task_id
            # Check if a team already exists for the corresponding task_id
            if self.session_id in self._clients:
                logger.info(
                    f"Reusing existing Agno team for session_id: {self.session_id}"
                )
                self.add_thinking_step(
                    title="Reuse Existing Team",
                    action=f"${{thinking.reusing_team_session}} {self.session_id}",
                    reasoning="Team already exists for this session, reusing to maintain context",
                    report_immediately=False
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
                self.add_thinking_step(
                    title="Create New Team",
                    action=f"${{thinking.creating_team_session}} {self.session_id}",
                    reasoning="No existing team found for this session, creating a new one",
                    report_immediately=False
                )
                self.team = await self._create_team()
                progress = 70
                # Update current progress
                self._update_progress(progress)
                if self.team is not None:
                    # Store team for reuse
                    self._clients[self.session_id] = self.team
                    self.add_thinking_step(
                        title="Team Created Successfully",
                        action="Team created and stored for reuse",
                        reasoning="Team has been created successfully and will be reused for this session",
                        result="Team created successfully",
                        report_immediately=False
                    )
                else:
                    self.single_agent = await self._create_agent()
                    self._clients[self.session_id] = self.single_agent
                    self.add_thinking_step(
                        title="Single Agent Created",
                        action="Created single agent instead of team",
                        reasoning="Team creation failed, falling back to single agent",
                        result="Single agent created",
                        report_immediately=False
                    )
            # Prepare prompt
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
            self.add_thinking_step(
                title="Prepare Prompt",
                action="Preparing execution prompt",
                reasoning=f"${{thinking.prepared_prompt_with_info}} {prompt[:100]}...",
                report_immediately=False
            )
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

        if result_content:
            logger.info(
                f"{execution_type} completed with content length: {len(result_content)}"
            )
            self.add_thinking_step(
                title="Execution Completed",
                action=f"Completed {execution_type}",
                reasoning=f"{execution_type} completed successfully with content length: {len(result_content)}",
                result=result_content[:200] + "..." if len(result_content) > 200 else result_content,
                confidence=0.9,
                next_action="complete",
                report_immediately=False
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
            self.add_thinking_step(
                title="Execution Failed",
                action=f"{execution_type} failed - no content received",
                reasoning=f"{execution_type} completed but no content was returned",
                next_action="exit",
                report_immediately=False
            )
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
        
        self.add_thinking_step(
            title="Execution Error",
            action=f"{execution_type} encountered an error",
            reasoning=f"Error occurred during {execution_type}: {error_message}",
            next_action="exit",
            report_immediately=False
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
            self.report_progress(
                80, TaskStatus.RUNNING.value, f"${{thinking.using_tool}} {run_response_event.tool.tool_name}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

        if run_response_event.event in [RunEvent.tool_call_completed]:
            logger.info(f"✅ AGENT TOOL COMPLETED: {run_response_event.tool.tool_name}")
            logger.info(f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}...")

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
            self.add_thinking_step(
                title="Agent Non-streaming Execution",
                action="Starting agent non-streaming execution",
                reasoning="Agent will now execute the task in non-streaming mode",
                report_immediately=False
            )
            
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

            self.add_thinking_step(
                title="Agent Streaming Execution",
                action="Starting agent streaming execution",
                reasoning="Agent will now execute the task in streaming mode",
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
                result_content = await self._handle_agent_streaming_event(
                    run_response_event, result_content
                )

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
            
            self.add_thinking_step(
                title="Team Non-streaming Execution",
                action="Starting team non-streaming execution",
                reasoning="Team will now execute the task in non-streaming mode",
                report_immediately=False
            )

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
                result_content, reasoning = await self._handle_team_streaming_event(
                    run_response_event, result_content
                )
                # Thinking steps are already handled in _handle_team_streaming_event
                # Here we only need to report progress, no need to add thinking again

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
                self.add_thinking_step(
                    title=reasoning.title,
                    action=reasoning.action,
                    reasoning=reasoning.reasoning,
                    confidence=reasoning.confidence,
                    next_action=reasoning.next_action,
                    report_immediately=False
                )

        # Handle team-level events
        if run_response_event.event in [
            TeamRunEvent.run_started,
            TeamRunEvent.run_completed,
        ]:
            logger.info(f"\n🎯 TEAM EVENT: {run_response_event.event}")
            if run_response_event.event == TeamRunEvent.run_started:
                self.report_progress(
                    75, TaskStatus.RUNNING.value, "${{thinking.team_execution_started}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
                )

        # Handle team tool call events
        if run_response_event.event in [TeamRunEvent.tool_call_started]:
            logger.info(f"\n🔧 TEAM TOOL STARTED: {run_response_event.tool.tool_name}")
            logger.info(f"   Args: {run_response_event.tool.tool_args}")
            self.add_thinking_step_by_key(
                title_key=f"{{thinking.agno.team_tool_started_title}}: {run_response_event.tool.tool_name}",
                action_key="thinking.agno.team_tool_started_action",
                reasoning_key=f"${{thinking.agno.team_tool_started_reasoning}}: {json.dumps(run_response_event.tool.tool_args, ensure_ascii=False)}",
                next_action_key="thinking.agno.team_tool_started_next_action",
                report_immediately=False
            )
            self.report_progress(
                80, TaskStatus.RUNNING.value, f"${{thinking.team_using_tool}} {run_response_event.tool.tool_name}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )

        if run_response_event.event in [TeamRunEvent.tool_call_completed]:
            logger.info(f"\n✅ TEAM TOOL COMPLETED: {run_response_event.tool.tool_name}")
            self.add_thinking_step_by_key(
                title_key=f"{{thinking.agno.team_tool_completed_title}}: {run_response_event.tool.tool_name}",
                action_key="thinking.agno.team_tool_completed_action",
                reasoning_key=f"${{thinking.agno.team_tool_completed_reasoning}}: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}...",
                next_action_key="thinking.agno.team_tool_completed_next_action",
                report_immediately=False
            )
            logger.info(f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}...")

        # Handle member-level events
        if run_response_event.event in [RunEvent.tool_call_started]:
            logger.info(f"\n🤖 MEMBER TOOL STARTED: {run_response_event.agent_id}")
            logger.info(f"   Tool: {run_response_event.tool.tool_name}")
            logger.info(f"   Args: {run_response_event.tool.tool_args}")
            self.add_thinking_step_by_key(
                title_key=f"{{thinking.agno.member_tool_started_title}}: {run_response_event.tool.tool_name}",
                action_key="thinking.agno.member_tool_started_action",
                reasoning_key=f"${{thinking.agno.member_tool_started_reasoning}}: {json.dumps(run_response_event.tool.tool_args, ensure_ascii=False)}",
                next_action_key="thinking.agno.member_tool_started_next_action",
                report_immediately=False
            )

        if run_response_event.event in [RunEvent.tool_call_completed]:
            logger.info(f"\n✅ MEMBER TOOL COMPLETED: {run_response_event.agent_id}")
            logger.info(f"   Tool: {run_response_event.tool.tool_name}")
            logger.info(
                f"   Result: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}..."
            )
            self.add_thinking_step_by_key(
                title_key=f"{{thinking.agno.member_tool_completed_title}}: {run_response_event.tool.tool_name}",
                action_key="thinking.agno.member_tool_completed_action",
                reasoning_key=f"${{thinking.agno.member_tool_completed_reasoning}}: {run_response_event.tool.result[:100] if run_response_event.tool.result else 'None'}..",
                next_action_key="thinking.agno.member_tool_completed_next_action",
                report_immediately=False
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
                team = cls._clients[session_id]
                # Clean up team resources if needed
                team.cancel_run(session_id)
                del cls._clients[session_id]
                logger.info(f"Closed Agno team for session_id: {session_id}")
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
        for session_id, team in list(cls._clients.items()):
            try:
                # Clean up team resources if needed
                team.cancel_run(session_id)
                logger.info(f"Closed Agno team for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()
    
    async def cleanup(self) -> None:
        """
        Clean up resources used by the agent
        """
        await self.team_builder.cleanup()
