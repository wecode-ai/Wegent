#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, List, Union

from claude_agent_sdk import ClaudeSDKClient
from shared.status import TaskStatus
from shared.logger import setup_logger
from shared.models.task import ExecutionResult
from claude_agent_sdk.types import (
    Message,
    SystemMessage,
    AssistantMessage,
    ResultMessage,
    ToolUseBlock,
    TextBlock,
)

logger = setup_logger("claude_response_processor")


async def process_response(
    client: ClaudeSDKClient, report_progress_callback, thinking_manager=None
) -> TaskStatus:
    """
    Process the response messages from Claude

    Args:
        client: Claude SDK client
        report_progress_callback: Callback function to report progress
        thinking_manager: Optional ThinkingStepManager instance for adding thinking steps

    Returns:
        TaskStatus: Processing status
    """
    index = 0
    try:
        # Add thinking step for starting response processing
        if thinking_manager:
            thinking_manager.add_thinking_step_by_key(
                title_key="thinking.claude.process_response",
                action_key="thinking.claude.starting_process_response",
                reasoning_key="thinking.claude.beginning_process_response",
                report_immediately=False
            )
        
        async for msg in client.receive_response():
            index += 1
            # Log the number of messages received
            logger.info(f"claude message index: {index}, received: {msg}")
            
            # Add thinking step for each message received
            if thinking_manager:
                # # Check if msg has content attribute
                # if hasattr(msg, 'content') and msg.content is not None:
                #     # Use content in reasoning_key, truncate if too long
                #     content_str = str(msg.content)
                #     content_preview = content_str[:200] + "..." if len(content_str) > 200 else content_str
                #     reasoning_key = f"${{thinking.claude.from_claude}}:{content_preview}"
                # else:
                # Use message type name when content is not available
                reasoning_key = f"${{thinking.claude.from_claude}}:{type(msg).__name__}"
                
                thinking_manager.add_thinking_step_by_key(
                    title_key="thinking.claude.receive_message",
                    reasoning_key=reasoning_key,
                    report_immediately=True
                )
            
            # Handle different message types based on their class

            if isinstance(msg, SystemMessage):
                # Handle SystemMessage
                _handle_system_message(msg, thinking_manager)

            elif isinstance(msg, AssistantMessage):
                _handle_assistant_message(msg, thinking_manager)

            elif isinstance(msg, ResultMessage):
                # Use specialized function to handle ResultMessage
                result_status = _process_result_message(msg, report_progress_callback, thinking_manager)
                if result_status:
                    return result_status

            elif isinstance(msg, dict):
                _handle_legacy_message(msg, thinking_manager)

        return TaskStatus.RUNNING
    except Exception as e:
        logger.exception(f"Error processing response: {str(e)}")
        
        # Add thinking step for error
        if thinking_manager:
            thinking_manager.add_thinking_step_by_key(
                title_key="thinking.claude.response_processing_error",
                action_key="thinking.claude.failed_process_response",
                reasoning_key=f"${{thinking.claude.error_during_response_processing}} {str(e)}",
                next_action_key="thinking.exit",
                report_immediately=False
            )
        
        # Also try to send error information as result on failure
        error_result = {"error": str(e)}
        if thinking_manager:
            error_result["thinking"] = [step.dict() for step in thinking_manager.get_thinking_steps()]
        
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Error processing response: {str(e)}",
            result=error_result,
        )
        return TaskStatus.FAILED


def _handle_system_message(msg: SystemMessage, thinking_manager=None):
    logger.info(f"SystemMessage: subtype = {msg.subtype}")
    
    if thinking_manager:
        thinking_manager.add_thinking_step_by_key(
            title_key="thinking.claude.system_message",
            action_key=f"${{thinking.claude.processing_system_message}} {msg.subtype}",
            reasoning_key="thinking.claude.handling_system_message",
            report_immediately=False
        )


def _handle_assistant_message(msg: AssistantMessage, thinking_manager=None):
    logger.info(f"AssistantMessage: {len(msg.content)} content blocks")
    
    if thinking_manager:
        thinking_manager.add_thinking_step_by_key(
            title_key="thinking.claude.assistant_message",
            reasoning_key="thinking.claude.handling_assistant_message",
            report_immediately=False
        )

    for block in msg.content:
        if isinstance(block, ToolUseBlock):
            logger.info(f"ToolUseBlock: tool = {block.name}")
            if thinking_manager:
                thinking_manager.add_thinking_step_by_key(
                    title_key="thinking.claude.tool_use",
                    action_key=f"${{thinking.claude.using_tool}} {block.name}",
                    reasoning_key=f"${{thinking.claude.is_using_tool}} {block.name}",
                    report_immediately=False
                )
            # Add tool-specific logic
        elif isinstance(block, TextBlock):
            logger.info(f"TextBlock: {len(block.text)} chars")
            if thinking_manager:
                thinking_manager.add_thinking_step_by_key(
                    title_key="thinking.claude.text_response",
                    reasoning_key="thinking.claude.generating_text_response",
                    report_immediately=False
                )
            # Add text handling logic
        else:
            logger.debug(f"Unknown block type: {type(block)}")
            if thinking_manager:
                thinking_manager.add_thinking_step_by_key(
                    title_key="thinking.claude.unknown_block_type",
                    action_key=f"${{thinking.claude.processing_unknown_block}} {type(block).__name__}",
                    reasoning_key="thinking.claude.unknown_block_sent",
                    report_immediately=False
                )


def _handle_legacy_message(msg: Dict[str, Any], thinking_manager=None):
    msg_type = msg.get("type", "unknown")
    
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="Legacy Message",
            action=f"Processing legacy message of type: {msg_type}",
            reasoning="Handling legacy message format from Claude",
            report_immediately=False
        )

    if msg_type == "tool_use":
        tool_name = msg.get("tool", {}).get("name", "unknown")
        logger.info(f"Legacy ToolUse: tool = {tool_name}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="Legacy Tool Use",
                action=f"Using tool (legacy format): {tool_name}",
                reasoning=f"Claude is using the {tool_name} tool in legacy format",
                report_immediately=False
            )

    elif msg_type == "content":
        content = msg.get("content", "")
        logger.info(f"Legacy Content: length = {len(content)}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="Legacy Content",
                action=f"Processing content (legacy format) of length: {len(content)}",
                reasoning="Claude is sending content in legacy format",
                report_immediately=False
            )

    else:
        logger.warning(f"Unknown legacy message type: {msg_type}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="Unknown Legacy Message",
                action=f"Processing unknown legacy message type: {msg_type}",
                reasoning="Claude sent an unknown legacy message type",
                report_immediately=False
            )


def _process_result_message(msg: ResultMessage, report_progress_callback, thinking_manager=None) -> TaskStatus:
    """
    Process a ResultMessage from Claude

    Args:
        msg: The ResultMessage to process
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status (COMPLETED if successful, otherwise None)
    """
    logger.info(f"Result message received: subtype={msg.subtype}, is_error={msg.is_error}")
    
    # Add thinking step for result message
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.claude.process_result_message",
            action=f"Processing result message with subtype: {msg.subtype}",
            reasoning=f"Handling result message from Claude, is_error: {msg.is_error}",
            report_immediately=False
        )

    # If it's a successful result message, send the result back via callback
    if msg.subtype == "success" and not msg.is_error:
        # Ensure result is string type
        result_str = str(msg.result) if msg.result is not None else "No result"
        logger.info(f"Sending successful result via callback: {result_str}")
        
        # Add thinking step for successful result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.claude.result_processing_success",
                action="thinking.claude.successfully_processed_result",
                reasoning=f"Result processed successfully with content length: {len(result_str)}",
                result=result_str[:200] + "..." if len(result_str) > 200 else result_str,
                confidence=0.9,
                next_action="thinking.complete",
                report_immediately=False
            )

        # If there's a result, pass it as result parameter to report_progress
        if msg.result is not None:
            try:
                # Try to parse result as dict, wrap as dict if not
                if isinstance(msg.result, dict):
                    result_dict = msg.result
                else:
                    result_dict = {"value": msg.result}

                # Add thinking steps to result if available
                if thinking_manager:
                    result_dict["thinking"] = [step.dict() for step in thinking_manager.get_thinking_steps()]

                report_progress_callback(
                    progress=100,
                    status=TaskStatus.COMPLETED.value,
                    message=result_str,
                    result=result_dict,
                )
            except Exception as e:
                logger.error(f"Failed to parse result as dict: {e}")
                if thinking_manager:
                    thinking_manager.add_thinking_step(
                        title="thinking.claude.result_parsing_error",
                        action="thinking.claude.failed_parse_dict",
                        reasoning=f"Error occurred while parsing result: {str(e)}",
                        next_action="thinking.exit",
                        report_immediately=False
                    )
                
                result_dict = ExecutionResult(thinking=thinking_manager.get_thinking_steps() if thinking_manager else []).dict()
                report_progress_callback(
                    progress=100,
                    status=TaskStatus.FAILED.value,
                    message=result_str,
                    result=result_dict,
                )
        else:
            result_dict = ExecutionResult(thinking=thinking_manager.get_thinking_steps() if thinking_manager else []).dict()
            report_progress_callback(
                progress=100,
                status=TaskStatus.COMPLETED.value,
                message=result_str,
                result=result_dict,
            )
        return TaskStatus.COMPLETED

    if msg.is_error:
        logger.error("processor error")
        result_str = str(msg.result) if msg.result is not None else "No result"
        
        # Add thinking step for error result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.claude.result_processing_error",
                action="thinking.claude.received_error_result",
                reasoning=f"Claude returned an error result: {result_str}",
                next_action="thinking.exit",
                report_immediately=False
            )
        
        result_dict = ExecutionResult(thinking=thinking_manager.get_thinking_steps() if thinking_manager else []).dict()
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=result_str,
            result=result_dict,
        )

    # If it's not a successful result message, return None to let caller continue processing
    return None
