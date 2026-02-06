#!/usr/bin/env python
import json
from dataclasses import asdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from claude_agent_sdk import ClaudeSDKClient
from claude_agent_sdk.types import (
    AssistantMessage,
    Message,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from shared.logger import setup_logger
from shared.models.task import ExecutionResult
from shared.status import TaskStatus
from shared.utils.sensitive_data_masker import mask_sensitive_data

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-


logger = setup_logger("claude_response_processor")


# Maximum retry count for API errors per session
MAX_API_ERROR_RETRIES = 3

# Maximum retry count for error subtypes (error_during_execution, etc.)
MAX_ERROR_SUBTYPE_RETRIES = 3

# Retry message for resuming session - provide clear instruction for Claude to continue
RETRY_CONTINUE_MESSAGE = "An error occurred during execution. Please continue from where you left off and complete the task."

# Error patterns to detect API errors that need retry
API_ERROR_PATTERNS = [
    "API Error: Cannot read properties of undefined",
    "API Error: undefined is not an object",
]

# Error subtypes that can be retried by resuming session
# These errors may be transient and can often be recovered by resuming
RETRYABLE_ERROR_SUBTYPES = [
    "error_during_execution",  # Transient errors during execution
    # Note: error_max_turns is NOT included because it indicates the task
    # is too complex and will likely hit the limit again after resume
]


def contains_api_error(text: str) -> bool:
    return any(pattern in text for pattern in API_ERROR_PATTERNS)


def is_retryable_error_subtype(subtype: str) -> bool:
    """Check if the error subtype is retryable by resuming session.

    Args:
        subtype: The error subtype from ResultMessage

    Returns:
        True if the error subtype can be retried
    """
    return subtype in RETRYABLE_ERROR_SUBTYPES


async def process_response(
    client: ClaudeSDKClient,
    state_manager,
    thinking_manager=None,
    task_state_manager=None,
    session_id: str = None,
    error_subtype_retry_count: int = 0,
) -> Union[TaskStatus, str]:
    """
    Process the response messages from Claude

    Args:
        client: Claude SDK client
        state_manager: ProgressStateManager instance for managing state and reporting progress
        thinking_manager: Optional ThinkingStepManager instance for adding thinking steps
        task_state_manager: Optional TaskStateManager instance for checking cancellation
        session_id: Optional session ID for retry operations
        error_subtype_retry_count: Current retry count for error subtypes (error_during_execution, etc.)

    Returns:
        TaskStatus: Processing status
        str: "RETRY_WITH_RESUME" if session should be resumed for retry
    """
    index = 0
    api_error_retry_count = 0  # Track retry count for this session
    # Track silent exit detection from UserMessage tool results
    silent_exit_detected = False
    silent_exit_reason = ""
    try:
        while True:
            retry_requested = False

            async for msg in client.receive_response():
                index += 1

                # Check for cancellation before processing each message
                if task_state_manager:
                    task_id = (
                        state_manager.task_data.get("task_id")
                        if state_manager
                        else None
                    )
                    if task_id and task_state_manager.is_cancelled(task_id):
                        logger.info(
                            f"Task {task_id} cancelled during response processing"
                        )
                        if state_manager:
                            state_manager.update_workbench_status("cancelled")
                        return TaskStatus.CANCELLED

                # Log the number of messages received
                logger.info(f"claude message index: {index}, received: {msg}")

                if isinstance(msg, SystemMessage):
                    # Handle SystemMessage
                    _handle_system_message(msg, state_manager, thinking_manager)

                elif isinstance(msg, UserMessage):
                    # Handle UserMessage and check for silent_exit in tool results
                    is_silent, reason = _handle_user_message(msg, thinking_manager)
                    if is_silent:
                        silent_exit_detected = True
                        silent_exit_reason = reason
                        logger.info(
                            f"🔇 Silent exit detected in UserMessage, will propagate to result: reason={reason}"
                        )

                elif isinstance(msg, AssistantMessage):
                    # Handle assistant message and detect API errors
                    # Note: Retry logic is handled in ResultMessage processing to avoid duplicate retries
                    _handle_assistant_message(msg, state_manager, thinking_manager)

                elif isinstance(msg, ResultMessage):
                    # Use specialized function to handle ResultMessage
                    current_session_id = msg.session_id or session_id
                    if msg.session_id:
                        session_id = msg.session_id

                        # Save the Claude session ID for future resume
                        task_id = (
                            state_manager.task_data.get("task_id")
                            if state_manager
                            else None
                        )
                        if task_id:
                            try:
                                from executor.agents.claude_code.session_manager import (
                                    SessionManager,
                                )

                                SessionManager.save_session_id(task_id, msg.session_id)
                            except Exception as save_error:
                                logger.warning(
                                    f"Failed to save session ID: {save_error}"
                                )

                    result_status = await _process_result_message(
                        msg,
                        state_manager,
                        thinking_manager,
                        client,
                        current_session_id,
                        api_error_retry_count,
                        MAX_API_ERROR_RETRIES,
                        silent_exit_detected,
                        silent_exit_reason,
                        task_state_manager,
                        error_subtype_retry_count,
                    )
                    if result_status == "RETRY":
                        # Increment retry count and restart response stream for retry
                        api_error_retry_count += 1
                        retry_requested = True
                        logger.info(
                            f"Retry initiated, restarting response stream for session {session_id}"
                        )
                        break
                    elif result_status == "RETRY_WITH_RESUME":
                        # Return to caller to handle session resume retry
                        logger.info(
                            f"RETRY_WITH_RESUME requested for session {session_id}, "
                            f"retry count {error_subtype_retry_count + 1}/{MAX_ERROR_SUBTYPE_RETRIES}"
                        )
                        return "RETRY_WITH_RESUME"
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
                title_key="thinking.response_processing_error", report_immediately=False
            )

        # Update workbench status to failed
        if state_manager:
            state_manager.update_workbench_status("failed")

            # Report error using state manager
            state_manager.report_progress(
                progress=100,
                status=TaskStatus.FAILED.value,
                message=f"Error processing response: {str(e)}",
                extra_result={"error": str(e)},
            )
        return TaskStatus.FAILED


def _handle_system_message(msg: SystemMessage, state_manager, thinking_manager=None):
    """处理系统消息，提取详细信息"""

    # 构建系统消息的详细信息，符合目标格式
    system_detail = {
        "type": "system",
        "subtype": msg.subtype,
        **msg.data,  # 包含原有的系统消息数据
    }

    # Mask sensitive data in system details before sending
    masked_system_detail = mask_sensitive_data(system_detail)

    # Log with masked data
    msg_dict = asdict(msg)
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(
        f"SystemMessage: subtype = {msg.subtype}. msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}"
    )

    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.system_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_system_detail,
        )


def _handle_user_message(msg: UserMessage, thinking_manager=None) -> tuple[bool, str]:
    """处理用户消息，提取详细信息

    Args:
        msg: UserMessage to process
        thinking_manager: Optional ThinkingStepManager instance

    Returns:
        Tuple of (silent_exit_detected, silent_exit_reason)
    """
    from executor.tools.silent_exit import detect_silent_exit

    # Track silent exit detection
    silent_exit_detected = False
    silent_exit_reason = ""

    # 构建用户消息的详细信息，符合目标格式
    message_details = {
        "type": "user",
        "message": {
            "type": "message",
            "role": "user",
            "content": [],
            "parent_tool_use_id": msg.parent_tool_use_id,
        },
    }

    # 处理内容（可能是字符串或内容块列表）
    if isinstance(msg.content, str):
        # 如果是字符串，直接作为文本内容
        text_detail = {"type": "text", "text": msg.content}
        message_details["message"]["content"].append(text_detail)
        logger.info(f"UserMessage: text content, length = {len(msg.content)}")
    else:
        # 如果是内容块列表，处理每个块
        logger.info(f"UserMessage: {len(msg.content)} content blocks")

        for block in msg.content:
            # 添加调试日志：打印 block 的类型和内容
            logger.info(
                f"Processing UserMessage block type: {type(block).__name__}, isinstance checks: "
                f"ToolUseBlock={isinstance(block, ToolUseBlock)}, "
                f"TextBlock={isinstance(block, TextBlock)}, "
                f"ToolResultBlock={isinstance(block, ToolResultBlock)}"
            )

            # Mask sensitive data in block content for logging
            block_dict = (
                asdict(block) if hasattr(block, "__dataclass_fields__") else block
            )
            masked_block_dict = mask_sensitive_data(block_dict)
            logger.info(f"UserMessage Block content: {masked_block_dict}")

            if isinstance(block, ToolUseBlock):
                # 工具使用详情，符合目标格式
                tool_detail = {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                }
                message_details["message"]["content"].append(tool_detail)

                logger.info(f"UserMessage ToolUseBlock: tool = {block.name}")

            elif isinstance(block, TextBlock):
                # 文本内容详情，符合目标格式
                text_detail = {"type": "text", "text": block.text}
                message_details["message"]["content"].append(text_detail)

                logger.info(f"UserMessage TextBlock: {len(block.text)} chars")

            elif isinstance(block, ToolResultBlock):
                # 工具结果详情，符合目标格式
                result_detail = {
                    "type": "tool_result",
                    "tool_use_id": block.tool_use_id,
                    "content": block.content,
                    "is_error": block.is_error,
                }
                message_details["message"]["content"].append(result_detail)

                logger.info(
                    f"UserMessage ToolResultBlock: tool_use_id = {block.tool_use_id}, is_error = {block.is_error}"
                )

                # Check for silent_exit marker in tool result content
                # The content can be a string or a list of content blocks
                content_to_check = block.content
                if isinstance(content_to_check, list):
                    # If it's a list, extract text from each block
                    for item in content_to_check:
                        if isinstance(item, dict) and item.get("type") == "text":
                            text_content = item.get("text", "")
                            is_silent, reason = detect_silent_exit(text_content)
                            if is_silent:
                                silent_exit_detected = True
                                silent_exit_reason = reason
                                logger.info(
                                    f"🔇 Silent exit detected in ToolResultBlock: reason={reason}"
                                )
                                break
                elif isinstance(content_to_check, str):
                    is_silent, reason = detect_silent_exit(content_to_check)
                    if is_silent:
                        silent_exit_detected = True
                        silent_exit_reason = reason
                        logger.info(
                            f"🔇 Silent exit detected in ToolResultBlock: reason={reason}"
                        )

            else:
                # 未知块类型，符合目标格式
                unknown_detail = {
                    "type": "unknown",
                    "block_type": type(block).__name__,
                    "block_data": (
                        asdict(block) if hasattr(block, "__dict__") else str(block)
                    ),
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
            details=masked_message_details,
        )

    return silent_exit_detected, silent_exit_reason


def _handle_assistant_message(
    msg: AssistantMessage, state_manager, thinking_manager=None
) -> bool:
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
            "id": getattr(msg, "id", ""),
            "type": "message",
            "role": "assistant",
            "model": msg.model,
            "content": [],
            "parent_tool_use_id": msg.parent_tool_use_id,
        },
    }

    # Convert content blocks to dict format for JSON serialization
    content_dicts = []
    for block in msg.content:
        content_dicts.append(asdict(block))
    msg_dict = {
        "content": content_dicts,
        "model": msg.model,
        "parent_tool_use_id": msg.parent_tool_use_id,
    }

    # Check if the message contains API error that needs retry
    msg_json_str = json.dumps(msg_dict, ensure_ascii=False)
    needs_retry = contains_api_error(msg_json_str)
    if needs_retry:
        logger.warning(f"Detected API error in AssistantMessage: {msg_json_str}")

    # Mask sensitive data in message for logging
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(
        f"AssistantMessage: {len(msg.content)} content blocks, msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}"
    )

    # 处理每个内容块
    for block in msg.content:
        # Mask sensitive data in block for logging
        block_dict = asdict(block) if hasattr(block, "__dataclass_fields__") else block
        masked_block_dict = mask_sensitive_data(block_dict)
        logger.info(f"Block content: {masked_block_dict}")

        if isinstance(block, ToolUseBlock):
            # 工具使用详情，符合目标格式
            tool_detail = {
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            }
            message_details["message"]["content"].append(tool_detail)

            logger.info(f"ToolUseBlock: tool = {block.name}")

        elif isinstance(block, TextBlock):
            # 文本内容详情，符合目标格式
            text_detail = {"type": "text", "text": block.text}
            message_details["message"]["content"].append(text_detail)

            state_manager.update_workbench_status("running", block.text)

            logger.info(f"TextBlock: {len(block.text)} chars")

        elif isinstance(block, ToolResultBlock):
            # 工具结果详情，符合目标格式
            result_detail = {
                "type": "tool_result",
                "tool_use_id": block.tool_use_id,
                "content": block.content,
                "is_error": block.is_error,
            }
            message_details["message"]["content"].append(result_detail)

            logger.info(
                f"ToolResultBlock: tool_use_id = {block.tool_use_id}, is_error = {block.is_error}"
            )

        else:
            # 未知块类型，符合目标格式
            unknown_detail = {
                "type": "unknown",
                "block_type": type(block).__name__,
                "block_data": (
                    asdict(block) if hasattr(block, "__dict__") else str(block)
                ),
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
            details=masked_message_details,
        )

    return needs_retry


def _handle_legacy_message(msg: Dict[str, Any], thinking_manager=None):
    msg_type = msg.get("type", "unknown")

    # Mask sensitive data in legacy message for logging
    masked_msg = mask_sensitive_data(msg)
    logger.info(
        f"Legacy Message: type = {msg_type}. msg = {json.dumps(masked_msg, ensure_ascii=False)}"
    )

    if msg_type == "tool_use":
        tool_name = msg.get("tool", {}).get("name", "unknown")
        logger.info(f"Legacy ToolUse: tool = {tool_name}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.legacy_tool_use",
                report_immediately=False,
                use_i18n_keys=True,
            )

    elif msg_type == "content":
        content = msg.get("content", "")
        logger.info(f"Legacy Content: length = {len(content)}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.legacy_content",
                report_immediately=False,
                use_i18n_keys=True,
            )

    else:
        logger.warning(f"Unknown legacy message type: {msg_type}")
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.unknown_legacy_message",
                report_immediately=False,
                use_i18n_keys=True,
            )


async def _process_result_message(
    msg: ResultMessage,
    state_manager,
    thinking_manager=None,
    client=None,
    session_id: str = None,
    api_error_retry_count: int = 0,
    max_retries: int = 3,
    propagated_silent_exit: bool = False,
    propagated_silent_exit_reason: str = "",
    task_state_manager=None,
    error_subtype_retry_count: int = 0,
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
        propagated_silent_exit: Silent exit flag propagated from UserMessage tool results
        propagated_silent_exit_reason: Silent exit reason propagated from UserMessage tool results
        task_state_manager: Optional TaskStateManager for checking cancellation state
        error_subtype_retry_count: Current retry count for error subtypes

    Returns:
        TaskStatus: Processing status (COMPLETED if successful, otherwise None)
        str: "RETRY" if API error retry was initiated
        str: "RETRY_WITH_RESUME" if error subtype retry is needed (session resume required)
    """

    # Get stop_reason safely (may not exist in older SDK versions)
    stop_reason = getattr(msg, "stop_reason", None)

    # Construct detailed result info, matching target format
    result_details = {
        "type": "result",
        "subtype": msg.subtype,
        "stop_reason": stop_reason,
        "is_error": msg.is_error,
        "session_id": msg.session_id,
        "num_turns": msg.num_turns,
        "duration_ms": msg.duration_ms,
        "duration_api_ms": msg.duration_api_ms,
        "total_cost_usd": msg.total_cost_usd,
        "usage": msg.usage,
        "result": msg.result,
    }

    # Mask sensitive data in result details
    masked_result_details = mask_sensitive_data(result_details)

    # Mask sensitive data in message for logging
    msg_dict = asdict(msg)
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(
        f"Result message received: subtype={msg.subtype}, stop_reason={stop_reason}, is_error={msg.is_error}, msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}"
    )

    # Check for silent exit marker in result
    # First use propagated values from UserMessage tool results (more reliable)
    silent_exit_detected = propagated_silent_exit
    silent_exit_reason = propagated_silent_exit_reason

    # Also check in msg.result as fallback (for backward compatibility)
    if not silent_exit_detected and msg.result:
        from executor.tools.silent_exit import detect_silent_exit

        # Handle dict/list results by converting to JSON string
        if isinstance(msg.result, (dict, list)):
            result_str = json.dumps(msg.result, ensure_ascii=False)
        else:
            result_str = str(msg.result) if msg.result is not None else ""
        silent_exit_detected, silent_exit_reason = detect_silent_exit(result_str)
        if silent_exit_detected:
            logger.info(
                f"🔇 Silent exit detected in Claude Code result: reason={silent_exit_reason}"
            )

    if silent_exit_detected:
        logger.info(
            f"🔇 Silent exit will be added to result: reason={silent_exit_reason}"
        )

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
                details=masked_result_details,
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

                # Add silent_exit flag if detected
                if silent_exit_detected:
                    result_dict["silent_exit"] = True
                    if silent_exit_reason:
                        result_dict["silent_exit_reason"] = silent_exit_reason
                    logger.info(
                        f"🔇 Adding silent_exit flag to result: reason={silent_exit_reason}"
                    )

                # Update workbench status to completed
                state_manager.update_workbench_status("completed")

                # Report progress using state manager
                state_manager.report_progress(
                    progress=100,
                    status=TaskStatus.COMPLETED.value,
                    message=result_str,
                    extra_result=result_dict,
                )
            except Exception as e:
                logger.error(f"Failed to parse result as dict: {e}")
                if thinking_manager:
                    thinking_manager.add_thinking_step(
                        title="thinking.result_parsing_error",
                        report_immediately=False,
                        use_i18n_keys=True,
                    )

                # Update workbench status to failed
                state_manager.update_workbench_status("failed")

                # Report error using state manager
                state_manager.report_progress(
                    progress=100, status=TaskStatus.FAILED.value, message=result_str
                )
        else:
            # Update workbench status to completed
            state_manager.update_workbench_status("completed")

            # Report progress using state manager
            state_manager.report_progress(
                progress=100, status=TaskStatus.COMPLETED.value, message=result_str
            )
        return TaskStatus.COMPLETED

    if msg.is_error:
        logger.error(f"Received error from Claude SDK: {msg.result}")
        result_str = str(msg.result) if msg.result is not None else "No result"

        # Check if this is an API error that can be retried
        if (
            contains_api_error(result_str)
            and client
            and session_id
            and api_error_retry_count < max_retries
        ):
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
                        "error": result_str,
                    },
                )

            # Send retry message to continue the session
            try:
                await client.query("Retry to proceed", session_id=session_id)
                logger.info(
                    f"Sent retry message for session {session_id} from ResultMessage handler"
                )
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
                        "session_id": session_id,
                    },
                )

        # Add thinking step for error result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.task_execution_failed",
                report_immediately=False,
                use_i18n_keys=True,
                details=masked_result_details,
            )

        # Update workbench status to failed
        state_manager.update_workbench_status("failed")

        # Report error using state manager
        state_manager.report_progress(
            progress=100, status=TaskStatus.FAILED.value, message=result_str
        )
        return (
            TaskStatus.FAILED
        )  # CRITICAL FIX: Return FAILED status to stop task execution

    # Handle error subtypes (is_error=False but execution ended with error condition)
    # Official subtypes per https://platform.claude.com/docs/agent-sdk/stop-reasons:
    # - error_during_execution: Error occurred during execution
    # - error_max_turns: Reached turn limit
    # - error_max_budget_usd: Exceeded budget limit
    # - error_max_structured_output_retries: Reached structured output retry limit
    if msg.subtype and msg.subtype.startswith("error_"):
        result_str = (
            str(msg.result) if msg.result is not None else f"Task ended: {msg.subtype}"
        )

        # Check if this is a residual message from a previous interrupted session
        # When a session is interrupted and then reused, the first response may be
        # the result of the previous interrupt, not a real error for the current request.
        # Indicators of a residual interrupt message:
        # - subtype is error_during_execution
        # - result is None
        # - usage tokens are all 0 (no actual API call was made for this)
        is_residual_interrupt = False
        if msg.subtype == "error_during_execution" and msg.result is None:
            usage = msg.usage or {}
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            if input_tokens == 0 and output_tokens == 0:
                is_residual_interrupt = True
                logger.info(
                    f"Detected residual interrupt message (usage tokens all 0), "
                    f"this is likely from a previous cancelled session. "
                    f"Returning None to continue processing."
                )

        if is_residual_interrupt:
            # Residual interrupt message detected, need to resend query
            logger.info(
                "Returning RETRY_RESIDUAL to resend query after residual interrupt"
            )
            return "RETRY_RESIDUAL"

        # Check if this is a user-initiated cancellation
        # When user cancels, we get error_during_execution but it's not a real failure
        is_user_cancellation = False
        if task_state_manager and state_manager:
            task_id = state_manager.task_data.get("task_id")
            if task_id and task_state_manager.is_cancelled(task_id):
                is_user_cancellation = True
                logger.info(
                    f"Task {task_id} error_during_execution is due to user cancellation, treating as CANCELLED"
                )

        if is_user_cancellation:
            # User cancelled the task, treat as CANCELLED not FAILED
            if thinking_manager:
                thinking_manager.add_thinking_step(
                    title="thinking.task_cancelled",
                    report_immediately=False,
                    use_i18n_keys=True,
                    details=masked_result_details,
                )

            # Update workbench status to cancelled
            state_manager.update_workbench_status("cancelled")

            # Report cancelled status
            state_manager.report_progress(
                progress=100,
                status=TaskStatus.CANCELLED.value,
                message="Task cancelled by user",
            )
            return TaskStatus.CANCELLED

        # Check if this error subtype can be retried by resuming session
        if (
            is_retryable_error_subtype(msg.subtype)
            and session_id
            and error_subtype_retry_count < MAX_ERROR_SUBTYPE_RETRIES
        ):
            logger.warning(
                f"Retryable error subtype detected: {msg.subtype}, "
                f"retry {error_subtype_retry_count + 1}/{MAX_ERROR_SUBTYPE_RETRIES}, "
                f"session_id={session_id}"
            )

            if thinking_manager:
                thinking_manager.add_thinking_step(
                    title="thinking.error_subtype_retry",
                    report_immediately=True,
                    use_i18n_keys=True,
                    details={
                        "error_subtype": msg.subtype,
                        "retry_count": error_subtype_retry_count + 1,
                        "max_retries": MAX_ERROR_SUBTYPE_RETRIES,
                        "session_id": session_id,
                    },
                )

            # Signal to caller that session should be resumed for retry
            return "RETRY_WITH_RESUME"

        elif (
            is_retryable_error_subtype(msg.subtype)
            and error_subtype_retry_count >= MAX_ERROR_SUBTYPE_RETRIES
        ):
            logger.error(
                f"Max error subtype retries ({MAX_ERROR_SUBTYPE_RETRIES}) reached "
                f"for session {session_id}, error_subtype={msg.subtype}"
            )
            if thinking_manager:
                thinking_manager.add_thinking_step(
                    title="thinking.error_subtype_max_retries",
                    report_immediately=True,
                    use_i18n_keys=True,
                    details={
                        "error_subtype": msg.subtype,
                        "retry_count": error_subtype_retry_count,
                        "max_retries": MAX_ERROR_SUBTYPE_RETRIES,
                        "session_id": session_id,
                    },
                )

        # Real error, treat as FAILED
        logger.error(
            f"Task ended with subtype={msg.subtype} (is_error={msg.is_error}): {result_str}"
        )

        # Add thinking step for error result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.task_execution_failed",
                report_immediately=False,
                use_i18n_keys=True,
                details=masked_result_details,
            )

        # Update workbench status to failed
        state_manager.update_workbench_status("failed")

        # Report error using state manager
        state_manager.report_progress(
            progress=100, status=TaskStatus.FAILED.value, message=result_str
        )
        return TaskStatus.FAILED

    # If it's not a successful result message, return None to let caller continue processing
    return None
