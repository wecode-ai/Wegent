#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, List, Union

from claude_agent_sdk import ClaudeSDKClient
from shared.status import TaskStatus
from shared.logger import setup_logger
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
    client: ClaudeSDKClient, report_progress_callback
) -> TaskStatus:
    """
    Process the response messages from Claude

    Args:
        response_messages: List of response messages from Claude
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status
    """
    index = 0
    try:
        async for msg in client.receive_response():
            index += 1
            # Log the number of messages received
            logger.info(f"claude message index: {index}, received: {msg}")
            # Handle different message types based on their class

            if isinstance(msg, SystemMessage):
                # Handle SystemMessage
                _handle_system_message(msg)

            elif isinstance(msg, AssistantMessage):
                _handle_assistant_message(msg)

            elif isinstance(msg, ResultMessage):
                # Use specialized function to handle ResultMessage
                result_status = _process_result_message(msg, report_progress_callback)
                if result_status:
                    return result_status

            elif isinstance(msg, dict):
                _handle_legacy_message(msg)

        return TaskStatus.RUNNING
    except Exception as e:
        logger.exception(f"Error processing response: {str(e)}")
        # Also try to send error information as result on failure
        error_result = {"error": str(e)}
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Error processing response: {str(e)}",
            result=error_result,
        )
        return TaskStatus.FAILED


def _handle_system_message(msg: SystemMessage):
    logger.info(f"SystemMessage: subtype = {msg.subtype}")


def _handle_assistant_message(msg: AssistantMessage):
    logger.info(f"AssistantMessage: {len(msg.content)} content blocks")

    for block in msg.content:
        if isinstance(block, ToolUseBlock):
            logger.info(f"ToolUseBlock: tool = {block.name}")
            # Add tool-specific logic
        elif isinstance(block, TextBlock):
            logger.info(f"TextBlock: {len(block.text)} chars")
            # Add text handling logic
        else:
            logger.debug(f"Unknown block type: {type(block)}")


def _handle_legacy_message(msg: Dict[str, Any]):
    msg_type = msg.get("type", "unknown")

    if msg_type == "tool_use":
        tool_name = msg.get("tool", {}).get("name", "unknown")
        logger.info(f"Legacy ToolUse: tool = {tool_name}")

    elif msg_type == "content":
        content = msg.get("content", "")
        logger.info(f"Legacy Content: length = {len(content)}")

    else:
        logger.warning(f"Unknown legacy message type: {msg_type}")


def _process_result_message(msg: ResultMessage, report_progress_callback) -> TaskStatus:
    """
    Process a ResultMessage from Claude

    Args:
        msg: The ResultMessage to process
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status (COMPLETED if successful, otherwise None)
    """
    logger.info(f"Result message received: subtype={msg.subtype}, is_error={msg.is_error}")

    # If it's a successful result message, send the result back via callback
    if msg.subtype == "success":
        # Ensure result is string type
        result_str = str(msg.result) if msg.result is not None else "No result"
        logger.info(f"Sending successful result via callback: {result_str}")

        # If there's a result, pass it as result parameter to report_progress
        if msg.result is not None:
            try:
                # Try to parse result as dict, wrap as dict if not
                if isinstance(msg.result, dict):
                    result_dict = msg.result
                else:
                    result_dict = {"value": msg.result}

                report_progress_callback(
                    progress=100,
                    status=TaskStatus.COMPLETED.value,
                    message=result_str,
                    result=result_dict,
                )
            except Exception as e:
                logger.error(f"Failed to parse result as dict: {e}")
                report_progress_callback(
                    progress=100,
                    status=TaskStatus.FAILED.value,
                    message=result_str,
                )
        else:
            report_progress_callback(
                progress=100,
                status=TaskStatus.COMPLETED.value,
                message=result_str,
            )
        return TaskStatus.COMPLETED

    # If it's not a successful result message, return None to let caller continue processing
    return None
