#!/usr/bin/env python
import json
from dataclasses import asdict
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, List, Union, Optional
from datetime import datetime

from claude_agent_sdk import ClaudeSDKClient
from shared.status import TaskStatus
from shared.logger import setup_logger
from shared.models.task import ExecutionResult
from shared.utils.sensitive_data_masker import mask_sensitive_data
from claude_agent_sdk.types import (
    Message,
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ResultMessage,
    ToolUseBlock,
    TextBlock,
    ToolResultBlock,
)

logger = setup_logger("claude_response_processor")


# Maximum retry count for API errors per session
MAX_API_ERROR_RETRIES = 3

# Error patterns to detect API errors that need retry
API_ERROR_PATTERNS = [
    "API Error: Cannot read properties of undefined",
    "API Error: undefined is not an object",
]


def contains_api_error(text: str) -> bool:
    return any(pattern in text for pattern in API_ERROR_PATTERNS)


async def process_response(
    client: ClaudeSDKClient, state_manager, thinking_manager=None, task_state_manager=None,
    session_id: str = None
) -> TaskStatus:
    """
    Process the response messages from Claude

    Args:
        client: Claude SDK client
        state_manager: ProgressStateManager instance for managing state and reporting progress
        thinking_manager: Optional ThinkingStepManager instance for adding thinking steps
        task_state_manager: Optional TaskStateManager instance for checking cancellation
        session_id: Optional session ID for retry operations

    Returns:
        TaskStatus: Processing status
    """
    index = 0
    api_error_retry_count = 0  # Track retry count for this session
    try:
        while True:
            retry_requested = False

            async for msg in client.receive_response():
                index += 1
                
                # Check for cancellation before processing each message
                if task_state_manager:
                    task_id = state_manager.task_data.get("task_id") if state_manager else None
                    if task_id and task_state_manager.is_cancelled(task_id):
                        logger.info(f"Task {task_id} cancelled during response processing")
                        if state_manager:
                            state_manager.update_workbench_status("completed")
                        return TaskStatus.COMPLETED
                
                # Log the number of messages received
                logger.info(f"claude message index: {index}, received: {msg}")

                if isinstance(msg, SystemMessage):
                    # Handle SystemMessage
                    _handle_system_message(msg, state_manager, thinking_manager)

                elif isinstance(msg, UserMessage):
                    # Handle UserMessage
                    _handle_user_message(msg, thinking_manager)

                elif isinstance(msg, AssistantMessage):
                    # Handle assistant message and detect API errors
                    # Note: Retry logic is handled in ResultMessage processing to avoid duplicate retries
                    _handle_assistant_message(msg, state_manager, thinking_manager)

                elif isinstance(msg, ResultMessage):
                    # Use specialized function to handle ResultMessage
                    current_session_id = msg.session_id or session_id
                    if msg.session_id:
                        session_id = msg.session_id

                    result_status = await _process_result_message(
                        msg,
                        state_manager,
                        thinking_manager,
                        client,
                        current_session_id,
                        api_error_retry_count,
                        MAX_API_ERROR_RETRIES,
                    )
                    if result_status == "RETRY":
                        # Increment retry count and restart response stream for retry
                        api_error_retry_count += 1
                        retry_requested = True
                        logger.info(
                            f"Retry initiated, restarting response stream for session {session_id}"
                        )
                        break
                    elif result_status:
                        return result_status

                elif isinstance(msg, dict):
                    _handle_legacy_message(msg, thinking_manager)

            if retry_requested:
                # Continue outer loop to start listening for the retry response stream
                continue

            return TaskStatus.RUNNING
    except Exception as e:
        logger.exception(f"Error processing response: {str(e)}")
        
        # Add thinking step for error
        if thinking_manager:
            thinking_manager.add_thinking_step_by_key(
                title_key="thinking.response_processing_error",
                report_immediately=False
            )
        
        # Update workbench status to failed
        if state_manager:
            state_manager.update_workbench_status("failed")
            
            # Report error using state manager
            state_manager.report_progress(
                progress=100,
                status=TaskStatus.FAILED.value,
                message=f"Error processing response: {str(e)}",
                extra_result={"error": str(e)}
            )
        return TaskStatus.FAILED


def _handle_system_message(msg: SystemMessage, state_manager, thinking_manager=None):
    """处理系统消息，提取详细信息"""

    # 构建系统消息的详细信息，符合目标格式
    system_detail = {
        "type": "system",
        "subtype": msg.subtype,
        **msg.data  # 包含原有的系统消息数据
    }

    # Mask sensitive data in system details before sending
    masked_system_detail = mask_sensitive_data(system_detail)

    # Log with masked data
    msg_dict = asdict(msg)
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(f"SystemMessage: subtype = {msg.subtype}. msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}")

    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.system_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_system_detail
        )


def _handle_user_message(msg: UserMessage, thinking_manager=None):
    """处理用户消息，提取详细信息"""
    
    # 构建用户消息的详细信息，符合目标格式
    message_details = {
        "type": "user",
        "message": {
            "type": "message",
            "role": "user",
            "content": [],
            "parent_tool_use_id": msg.parent_tool_use_id
        }
    }
    
    # 处理内容（可能是字符串或内容块列表）
    if isinstance(msg.content, str):
        # 如果是字符串，直接作为文本内容
        text_detail = {
            "type": "text",
            "text": msg.content
        }
        message_details["message"]["content"].append(text_detail)
        logger.info(f"UserMessage: text content, length = {len(msg.content)}")
    else:
        # 如果是内容块列表，处理每个块
        logger.info(f"UserMessage: {len(msg.content)} content blocks")
        
        for block in msg.content:
            # 添加调试日志：打印 block 的类型和内容
            logger.info(f"Processing UserMessage block type: {type(block).__name__}, isinstance checks: "
                       f"ToolUseBlock={isinstance(block, ToolUseBlock)}, "
                       f"TextBlock={isinstance(block, TextBlock)}, "
                       f"ToolResultBlock={isinstance(block, ToolResultBlock)}")

            # Mask sensitive data in block content for logging
            block_dict = asdict(block) if hasattr(block, '__dataclass_fields__') else block
            masked_block_dict = mask_sensitive_data(block_dict)
            logger.info(f"UserMessage Block content: {masked_block_dict}")
            
            if isinstance(block, ToolUseBlock):
                # 工具使用详情，符合目标格式
                tool_detail = {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input
                }
                message_details["message"]["content"].append(tool_detail)
                
                logger.info(f"UserMessage ToolUseBlock: tool = {block.name}")
                    
            elif isinstance(block, TextBlock):
                # 文本内容详情，符合目标格式
                text_detail = {
                    "type": "text",
                    "text": block.text
                }
                message_details["message"]["content"].append(text_detail)
                
                logger.info(f"UserMessage TextBlock: {len(block.text)} chars")
            
            elif isinstance(block, ToolResultBlock):
                # 工具结果详情，符合目标格式
                result_detail = {
                    "type": "tool_result",
                    "tool_use_id": block.tool_use_id,
                    "content": block.content,
                    "is_error": block.is_error
                }
                message_details["message"]["content"].append(result_detail)
                
                logger.info(f"UserMessage ToolResultBlock: tool_use_id = {block.tool_use_id}, is_error = {block.is_error}")
            
            else:
                # 未知块类型，符合目标格式
                unknown_detail = {
                    "type": "unknown",
                    "block_type": type(block).__name__,
                    "block_data": asdict(block) if hasattr(block, '__dict__') else str(block)
                }
                message_details["message"]["content"].append(unknown_detail)

                logger.debug(f"UserMessage Unknown block type: {type(block)}")

    # Mask sensitive data in message details before sending
    masked_message_details = mask_sensitive_data(message_details)

    # 记录整体消息
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.user_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_message_details
        )


def _handle_assistant_message(msg: AssistantMessage, state_manager, thinking_manager=None) -> bool:
    """处理助手消息，提取详细信息
    
    Args:
        msg: AssistantMessage to process
        state_manager: ProgressStateManager instance
        thinking_manager: Optional ThinkingStepManager instance
        
    Returns:
        bool: True if API error detected and retry is needed, False otherwise
    """
    
    # 收集所有内容块的详细信息，符合目标格式
    message_details = {
        "type": "assistant",
        "message": {
            "id": getattr(msg, 'id', ''),
            "type": "message",
            "role": "assistant",
            "model": msg.model,
            "content": [],
            "parent_tool_use_id": msg.parent_tool_use_id
        }
    }
    
    # Convert content blocks to dict format for JSON serialization
    content_dicts = []
    for block in msg.content:
        content_dicts.append(asdict(block))
    msg_dict = {"content": content_dicts, "model": msg.model, "parent_tool_use_id": msg.parent_tool_use_id}
    
    # Check if the message contains API error that needs retry
    msg_json_str = json.dumps(msg_dict, ensure_ascii=False)
    needs_retry = contains_api_error(msg_json_str)
    if needs_retry:
        logger.warning(f"Detected API error in AssistantMessage: {msg_json_str}")

    # Mask sensitive data in message for logging
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(f"AssistantMessage: {len(msg.content)} content blocks, msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}")

    # 处理每个内容块
    for block in msg.content:
        # Mask sensitive data in block for logging
        block_dict = asdict(block) if hasattr(block, '__dataclass_fields__') else block
        masked_block_dict = mask_sensitive_data(block_dict)
        logger.info(f"Block content: {masked_block_dict}")
        
        if isinstance(block, ToolUseBlock):
            # 工具使用详情，符合目标格式
            tool_detail = {
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input
            }
            message_details["message"]["content"].append(tool_detail)
            
            logger.info(f"ToolUseBlock: tool = {block.name}")
                
        elif isinstance(block, TextBlock):
            # 文本内容详情，符合目标格式
            text_detail = {
                "type": "text",
                "text": block.text
            }
            message_details["message"]["content"].append(text_detail)

            state_manager.update_workbench_status("running", block.text)
            
            logger.info(f"TextBlock: {len(block.text)} chars")
        
        elif isinstance(block, ToolResultBlock):
            # 工具结果详情，符合目标格式
            result_detail = {
                "type": "tool_result",
                "tool_use_id": block.tool_use_id,
                "content": block.content,
                "is_error": block.is_error
            }
            message_details["message"]["content"].append(result_detail)
            
            logger.info(f"ToolResultBlock: tool_use_id = {block.tool_use_id}, is_error = {block.is_error}")
        
        else:
            # 未知块类型，符合目标格式
            unknown_detail = {
                "type": "unknown",
                "block_type": type(block).__name__,
                "block_data": asdict(block) if hasattr(block, '__dict__') else str(block)
            }
            message_details["message"]["content"].append(unknown_detail)

            logger.debug(f"Unknown block type: {type(block)}")

    # Mask sensitive data in message details before sending
    masked_message_details = mask_sensitive_data(message_details)

    # 记录整体消息
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.assistant_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_message_details
        )
    
    return needs_retry


def _handle_legacy_message(msg: Dict[str, Any], thinking_manager=None):
    msg_type = msg.get("type", "unknown")

    # Mask sensitive data in legacy message for logging
    masked_msg = mask_sensitive_data(msg)
    logger.info(f"Legacy Message: type = {msg_type}. msg = {json.dumps(masked_msg, ensure_ascii=False)}")

    if msg_type == "tool_use":
        tool_name = msg.get("tool", {}).get("name", "unknown")
        logger.info(f"Legacy ToolUse: tool = {tool_name}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.legacy_tool_use",
                report_immediately=False,
                use_i18n_keys=True
            )

    elif msg_type == "content":
        content = msg.get("content", "")
        logger.info(f"Legacy Content: length = {len(content)}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.legacy_content",
                report_immediately=False,
                use_i18n_keys=True
            )

    else:
        logger.warning(f"Unknown legacy message type: {msg_type}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.unknown_legacy_message",
                report_immediately=False,
                use_i18n_keys=True
            )


async def _process_result_message(
    msg: ResultMessage, state_manager, thinking_manager=None, client=None,
    session_id: str = None, api_error_retry_count: int = 0, max_retries: int = 3
) -> Union[TaskStatus, str, None]:
    """
    Process a ResultMessage from Claude

    Args:
        msg: The ResultMessage to process
        state_manager: ProgressStateManager instance for managing state and reporting progress
        thinking_manager: Optional ThinkingStepManager instance
        client: ClaudeSDKClient for sending retry messages
        session_id: Session ID for retry operations
        api_error_retry_count: Current retry count
        max_retries: Maximum retry attempts

    Returns:
        TaskStatus: Processing status (COMPLETED if successful, otherwise None)
        str: "RETRY" if retry was initiated
    """
    
    # 构建详细的结果信息，符合目标格式
    result_details = {
        "type": "result",
        "subtype": msg.subtype,
        "is_error": msg.is_error,
        "session_id": msg.session_id,
        "num_turns": msg.num_turns,
        "duration_ms": msg.duration_ms,
        "duration_api_ms": msg.duration_api_ms,
        "total_cost_usd": msg.total_cost_usd,
        "usage": msg.usage,
        "result": msg.result
    }

    # Mask sensitive data in result details
    masked_result_details = mask_sensitive_data(result_details)

    # Mask sensitive data in message for logging
    msg_dict = asdict(msg)
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(f"Result message received: subtype={msg.subtype}, is_error={msg.is_error}, msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}")

    # If it's a successful result message, send the result back via callback
    if msg.subtype == "success" and not msg.is_error:
        # Ensure result is string type
        result_str = str(msg.result) if msg.result is not None else "No result"
        logger.info(f"Sending successful result via callback: {result_str}")
        
        # Add thinking step for successful result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.task_execution_success",
                report_immediately=False,
                use_i18n_keys=True,
                details=masked_result_details
            )

        # If there's a result, pass it as result parameter to report_progress
        if msg.result is not None:
            try:
                # Try to parse result as dict, wrap as dict if not
                if isinstance(msg.result, dict):
                    result_dict = msg.result
                    result_value = result_dict.get("value")
                else:
                    result_dict = {"value": msg.result}
                    result_value = msg.result

                # Update workbench status to completed
                state_manager.update_workbench_status("completed")

                # Report progress using state manager
                state_manager.report_progress(
                    progress=100,
                    status=TaskStatus.COMPLETED.value,
                    message=result_str,
                    extra_result=result_dict
                )
            except Exception as e:
                logger.error(f"Failed to parse result as dict: {e}")
                if thinking_manager:
                    thinking_manager.add_thinking_step(
                        title="thinking.result_parsing_error",
                        report_immediately=False,
                        use_i18n_keys=True
                    )
                
                # Update workbench status to failed
                state_manager.update_workbench_status("failed")
                
                # Report error using state manager
                state_manager.report_progress(
                    progress=100,
                    status=TaskStatus.FAILED.value,
                    message=result_str
                )
        else:
            # Update workbench status to completed
            state_manager.update_workbench_status("completed")
            
            # Report progress using state manager
            state_manager.report_progress(
                progress=100,
                status=TaskStatus.COMPLETED.value,
                message=result_str
            )
        return TaskStatus.COMPLETED

    if msg.is_error:
        logger.error(f"Received error from Claude SDK: {msg.result}")
        result_str = str(msg.result) if msg.result is not None else "No result"
        
        # Check if this is an API error that can be retried
        if contains_api_error(result_str) and client and session_id and api_error_retry_count < max_retries:
            logger.warning(
                f"Detected retryable API error in ResultMessage for session {session_id}, "
                f"retry {api_error_retry_count + 1}/{max_retries}"
            )
            
            if thinking_manager:
                thinking_manager.add_thinking_step(
                    title="thinking.api_error_retry",
                    report_immediately=True,
                    use_i18n_keys=True,
                    details={
                        "retry_count": api_error_retry_count + 1,
                        "max_retries": max_retries,
                        "session_id": session_id,
                        "error": result_str
                    }
                )
            
            # Send retry message to continue the session
            try:
                await client.query("Retry to proceed", session_id=session_id)
                logger.info(f"Sent retry message for session {session_id} from ResultMessage handler")
                return "RETRY"  # Signal to continue processing
            except Exception as retry_error:
                logger.error(f"Failed to send retry message: {retry_error}")
                # Fall through to fail the task
        
        elif contains_api_error(result_str) and api_error_retry_count >= max_retries:
            logger.error(
                f"Max API error retries ({max_retries}) reached for session {session_id}"
            )
            if thinking_manager:
                thinking_manager.add_thinking_step(
                    title="thinking.api_error_max_retries",
                    report_immediately=True,
                    use_i18n_keys=True,
                    details={
                        "retry_count": api_error_retry_count,
                        "max_retries": max_retries,
                        "session_id": session_id
                    }
                )
        
        # Add thinking step for error result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.task_execution_failed",
                report_immediately=False,
                use_i18n_keys=True,
                details=masked_result_details
            )
        
        # Update workbench status to failed
        state_manager.update_workbench_status("failed")
        
        # Report error using state manager
        state_manager.report_progress(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=result_str
        )
        return TaskStatus.FAILED  # CRITICAL FIX: Return FAILED status to stop task execution

    # If it's not a successful result message, return None to let caller continue processing
    return None
