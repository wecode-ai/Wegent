#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import re
from typing import List, Dict, Any, Optional, Callable

from shared.logger import setup_logger
from shared.models.task import ThinkingStep, ExecutionResult
from shared.status import TaskStatus

logger = setup_logger("thinking_step_manager")


class ThinkingStepManager:
    """
    Class for managing thinking steps, encapsulating functions like adding thinking steps and progress tracking
    """
    
    def __init__(self, progress_reporter: Optional[Callable] = None):
        """
        Initialize ThinkingStepManager
        
        Args:
            progress_reporter: Progress report callback function with signature (progress, status, message, result)
        """
        self.thinking_steps: List[ThinkingStep] = []
        self._current_progress: int = 50
        self.progress_reporter = progress_reporter
    
    def add_thinking_step(self, title: str, action: str, reasoning: str,
                         result: str = "", confidence: float = -1,
                         next_action: str = "continue", report_immediately: bool = True,
                         use_i18n_keys: bool = False) -> None:
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
            use_i18n_keys: Whether to use i18n key directly instead of English text (default False)
        """
        # Decide whether to convert text to i18n key based on use_i18n_keys parameter
        if use_i18n_keys:
            title_key = title
            action_key = action
            reasoning_key = reasoning
            result_key = result if result else ""
            next_action_key = next_action
        else:
            # Convert text to i18n key
            title_key = self._text_to_i18n_key(title)
            action_key = self._text_to_i18n_key(action)
            reasoning_key = self._text_to_i18n_key(reasoning)
            result_key = self._text_to_i18n_key(result) if result else ""
            next_action_key = self._text_to_i18n_key(next_action)
        
        # Handle None values to prevent Pydantic validation errors
        safe_title = title_key if title_key is not None else ""
        safe_action = action_key if action_key is not None else ""
        safe_reasoning = reasoning_key if reasoning_key is not None else ""
        safe_result = result_key if result_key is not None else ""
        safe_confidence = confidence if confidence is not None else 0.5
        safe_next_action = next_action_key if next_action_key is not None else "continue"
        
        thinking_step = ThinkingStep(
            title=safe_title,
            action=safe_action,
            reasoning=safe_reasoning,
            result=safe_result,
            confidence=safe_confidence,
            next_action=safe_next_action
        )
        self.thinking_steps.append(thinking_step)
        logger.info(f"Added thinking step: {title}")
        
        # Report this thinking step if immediate reporting is needed
        if report_immediately and self.progress_reporter:
            # Use current progress value, do not update main task progress
            self.progress_reporter(
                progress=self._current_progress,
                status=TaskStatus.RUNNING.value,
                message=f"Thinking: {title}",
                result=ExecutionResult(thinking=self.thinking_steps).dict()
            )
    
    def _text_to_i18n_key(self, text: str) -> str:
        """
        Convert text to i18n key
        
        Args:
            text: Text to convert
            
        Returns:
            str: Corresponding i18n key
        """
        # Define i18n key mapping for common operations
        i18n_mappings = {
            # Initialization related
            "Initialize Agno Agent": "thinking.initialize_agent",
            "Starting initialization of Agno Agent": "thinking.starting_initialization",
            "Initializing the agent with provided task data and configuration": "thinking.initializing_with_config",
            "Initialize Agno Agent Failed": "thinking.initialize_failed",
            "Failed to initialize Agno Agent": "thinking.failed_initialize",
            "Initialization failed with error:": "thinking.initialization_error",
            
            # Claude Code initialization related
            "Initialize Claude Code Agent": "thinking.claude.initialize_agent",
            "Starting initialization of Claude Code Agent": "thinking.claude.starting_initialization",
            "Initializing the agent with provided task data and configuration": "thinking.claude.initializing_with_config",
            "Initialize Claude Code Agent Completed": "thinking.claude.initialize_completed",
            "Claude Code Agent initialization completed successfully": "thinking.claude.initialization_success",
            "Agent has been initialized with configuration and is ready for execution": "thinking.claude.agent_ready",
            "Initialize Claude Code Agent Failed": "thinking.claude.initialize_failed",
            "Failed to initialize Claude Code Agent": "thinking.claude.failed_initialize",
            "Initialization failed with error:": "thinking.claude.initialization_error",
            
            # Pre-execution related
            "Pre-execution Setup": "thinking.pre_execution_setup",
            "Starting pre-execution setup": "thinking.starting_pre_execution",
            "Setting up environment": "thinking.setting_up_environment",
            "Download Code": "thinking.download_code",
            "Downloading code from": "thinking.downloading_code_from",
            "Code download is required for the task": "thinking.code_download_required",
            "Download Code Completed": "thinking.download_code_completed",
            "Code download completed successfully": "thinking.code_download_success",
            "Code has been downloaded and is ready for execution": "thinking.code_ready",
            "Set Working Directory": "thinking.set_working_directory",
            "Set working directory to": "thinking.setting_working_directory",
            "Working directory has been set to the downloaded code path": "thinking.working_directory_set",
            "Pre-execution Failed": "thinking.pre_execution_failed",
            "Pre-execution setup failed": "thinking.pre_execution_setup_failed",
            "Pre-execution failed with error:": "thinking.pre_execution_error",
            
            # Execution related
            "Execute Task": "thinking.execute_task",
            "Starting task execution": "thinking.starting_execution",
            "Beginning the execution of the Agno Agent task": "thinking.beginning_execution",
            "Beginning the execution of the Claude Code Agent task": "thinking.claude.beginning_execution",
            "Async Execution": "thinking.async_execution",
            "Detected async context, switching to async execution": "thinking.async_context_detected",
            "Running in coroutine context, will execute asynchronously": "thinking.running_async",
            "Sync Execution": "thinking.sync_execution",
            "No async context detected, creating new event loop": "thinking.sync_context_detected",
            "Not in coroutine context, will create new event loop for execution": "thinking.creating_event_loop",
            "Async Execution Started": "thinking.async_execution_started",
            "Starting asynchronous execution": "thinking.starting_async_execution",
            "Task is now executing in async mode": "thinking.executing_async_mode",
            
            # Team related
            "Reuse Existing Team": "thinking.reuse_existing_team",
            "Reusing existing team for session": "thinking.reusing_team_session",
            "Team already exists for this session, reusing to maintain context": "thinking.team_reuse_context",
            "Create New Team": "thinking.create_new_team",
            "Creating new team for session": "thinking.creating_team_session",
            "No existing team found for this session, creating a new one": "thinking.no_existing_team",
            "Team Created Successfully": "thinking.team_created_successfully",
            "Team created and stored for reuse": "thinking.team_stored_reuse",
            "Team has been created successfully and will be reused for this session": "thinking.team_reuse_session",
            "Single Agent Created": "thinking.single_agent_created",
            "Created single agent instead of team": "thinking.created_single_agent",
            "Team creation failed, falling back to single agent": "thinking.team_creation_failed",
            
            # Claude Code client related
            "Reuse Existing Client": "thinking.claude.reuse_existing_client",
            "Reusing existing client for session": "thinking.claude.reusing_client_session",
            "Client already exists for this session, reusing to maintain context": "thinking.claude.client_reuse_context",
            "Create New Client": "thinking.claude.create_new_client",
            "Creating new client for session": "thinking.claude.creating_client_session",
            "No existing client found for this session, creating a new one": "thinking.claude.no_existing_client",
            "Client Created Successfully": "thinking.claude.client_created_successfully",
            "Client created and stored for reuse": "thinking.claude.client_stored_reuse",
            "Client has been created successfully and will be reused for this session": "thinking.claude.client_reuse_session",
            
            # Prompt related
            "Prepare Prompt": "thinking.prepare_prompt",
            "Preparing execution prompt": "thinking.preparing_execution_prompt",
            "Prepared prompt with working directory and project URL:": "thinking.prepared_prompt_with_info",
            
            # Agent execution related
            "Agent Non-streaming Execution": "thinking.agent_non_streaming_execution",
            "Starting agent non-streaming execution": "thinking.starting_agent_non_streaming",
            "Agent will now execute the task in non-streaming mode": "thinking.agent_non_streaming_mode",
            "Agent Streaming Execution": "thinking.agent_streaming_execution",
            "Starting agent streaming execution": "thinking.starting_agent_streaming",
            "Agent will now execute the task in streaming mode": "thinking.agent_streaming_mode",
            
            # Team execution related
            "Team Non-streaming Execution": "thinking.team_non_streaming_execution",
            "Starting team non-streaming execution": "thinking.starting_team_non_streaming",
            "Team will now execute the task in non-streaming mode": "thinking.team_non_streaming_mode",
            
            # Execution result related
            "Execution Completed": "thinking.execution_completed",
            "Completed": "thinking.completed",
            "execution completed successfully with content length:": "thinking.execution_success_with_length",
            "Execution Failed": "thinking.execution_failed",
            "failed - no content received": "thinking.failed_no_content",
            "completed but no content was returned": "thinking.completed_no_content",
            "Execution Error": "thinking.execution_error",
            "encountered an error": "thinking.encountered_error",
            "Error occurred during": "thinking.error_occurred_during",
            
            # Response processing related
            "Process Response": "thinking.claude.process_response",
            "Starting to process Claude response": "thinking.claude.starting_process_response",
            "Beginning to process the response messages from Claude": "thinking.claude.beginning_process_response",
            "Receive Message": "thinking.claude.receive_message",
            "Processing message": "thinking.claude.processing_message",
            "from Claude": "thinking.claude.from_claude",
            "Received message of type": "thinking.claude.received_message_type",
            "System Message": "thinking.claude.system_message",
            "Processing system message with subtype:": "thinking.claude.processing_system_message",
            "Handling system message from Claude": "thinking.claude.handling_system_message",
            "Assistant Message": "thinking.claude.assistant_message",
            "Processing assistant message with": "thinking.claude.processing_assistant_message",
            "content blocks": "thinking.claude.content_blocks",
            "Handling assistant message from Claude": "thinking.claude.handling_assistant_message",
            "Tool Use": "thinking.claude.tool_use",
            "Using tool:": "thinking.claude.using_tool",
            "Claude is using the": "thinking.claude.is_using_tool",
            "tool": "thinking.claude.tool",
            "Text Response": "thinking.claude.text_response",
            "Processing text response of": "thinking.claude.processing_text_response",
            "characters": "thinking.claude.characters",
            "Claude is generating text response": "thinking.claude.generating_text_response",
            "Unknown Block Type": "thinking.claude.unknown_block_type",
            "Processing unknown block type:": "thinking.claude.processing_unknown_block",
            "Claude sent an unknown block type": "thinking.claude.unknown_block_sent",
            "Legacy Message": "thinking.claude.legacy_message",
            "Processing legacy message of type:": "thinking.claude.processing_legacy_message",
            "Handling legacy message format from Claude": "thinking.claude.handling_legacy_message",
            "Legacy Tool Use": "thinking.claude.legacy_tool_use",
            "Using tool (legacy format):": "thinking.claude.using_tool_legacy",
            "Claude is using the": "thinking.claude.is_using_tool_legacy",
            "tool in legacy format": "thinking.claude.tool_legacy_format",
            "Legacy Content": "thinking.claude.legacy_content",
            "Processing content (legacy format) of length:": "thinking.claude.processing_content_legacy",
            "Claude is sending content in legacy format": "thinking.claude.sending_content_legacy",
            "Unknown Legacy Message": "thinking.claude.unknown_legacy_message",
            "Processing unknown legacy message type:": "thinking.claude.processing_unknown_legacy",
            "Claude sent an unknown legacy message type": "thinking.claude.unknown_legacy_sent",
            "Process Result Message": "thinking.claude.process_result_message",
            "Processing result message with subtype:": "thinking.claude.processing_result_message",
            "Handling result message from Claude, is_error:": "thinking.claude.handling_result_message",
            "Result Processing Success": "thinking.claude.result_processing_success",
            "Successfully processed result message": "thinking.claude.successfully_processed_result",
            "Result processed successfully with content length:": "thinking.claude.result_success_with_length",
            "Result Parsing Error": "thinking.claude.result_parsing_error",
            "Failed to parse result as dictionary": "thinking.claude.failed_parse_dict",
            "Error occurred while parsing result:": "thinking.claude.error_parsing_result",
            "Result Processing Error": "thinking.claude.result_processing_error",
            "Received error result from Claude": "thinking.claude.received_error_result",
            "Claude returned an error result:": "thinking.claude.error_result_from_claude",
            "Response Processing Error": "thinking.claude.response_processing_error",
            "Failed to process Claude response": "thinking.claude.failed_process_response",
            "Error occurred during response processing:": "thinking.claude.error_during_response_processing",
            
            # Default values
            "continue": "thinking.continue",
            "validate": "thinking.validate",
            "complete": "thinking.complete",
            "exit": "thinking.exit"
        }
        
        # If there's a predefined mapping, return the corresponding key
        if text in i18n_mappings:
            return i18n_mappings[text]

        return text
    
    def add_thinking_step_by_key(self, title_key: str, action_key: str = "", reasoning_key: str = "",
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
        self.add_thinking_step(
            title=title_key,
            action=action_key,
            reasoning=reasoning_key,
            result=result_key,
            confidence=confidence,
            next_action=next_action_key,
            report_immediately=report_immediately,
            use_i18n_keys=True
        )
    
    def _is_i18n_key(self, text: str) -> bool:
        """
        Check if text is an i18n key
        
        Args:
            text: Text to check
            
        Returns:
            bool: True if it's an i18n key, otherwise False
        """
        # i18n keys usually contain dots and do not contain spaces
        return '.' in text and ' ' not in text and len(text) > 3

    def update_progress(self, progress: int) -> None:
        """
        Update current progress value for thinking steps
        
        Args:
            progress: Current progress value (0-100)
        """
        self._current_progress = progress

    def get_thinking_steps(self) -> List[ThinkingStep]:
        """
        Get all thinking steps
        
        Returns:
            List[ThinkingStep]: List of thinking steps
        """
        return self.thinking_steps

    def clear_thinking_steps(self) -> None:
        """
        Clear all thinking steps
        """
        self.thinking_steps.clear()
        logger.info("Cleared all thinking steps")
    
    def set_progress_reporter(self, progress_reporter: Callable) -> None:
        """
        Set progress report callback function
        
        Args:
            progress_reporter: Progress report callback function with signature (progress, status, message, result)
        """
        self.progress_reporter = progress_reporter