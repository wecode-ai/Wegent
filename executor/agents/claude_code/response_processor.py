#!/usr/bin/env python
import json
import os
from dataclasses import asdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from claude_agent_sdk import ClaudeSDKClient
from claude_agent_sdk.types import (
    AssistantMessage,
    Message,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter
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

# Error patterns to detect API errors that need retry
API_ERROR_PATTERNS = [
    "API Error: Cannot read properties of undefined",
    "API Error: undefined is not an object",
]


def contains_api_error(text: str) -> bool:
    return any(pattern in text for pattern in API_ERROR_PATTERNS)


async def process_response(
    client: ClaudeSDKClient,
    state_manager,
    emitter: ResponsesAPIEmitter,
    thinking_manager=None,
    task_state_manager=None,
    session_id: str = None,
) -> Union[TaskStatus, str]:
    """
    Process the response messages from Claude

    Args:
        client: Claude SDK client
        state_manager: ProgressStateManager instance for managing state and reporting progress
        emitter: ResponsesAPIEmitter instance for sending events via unified transport
        thinking_manager: Optional ThinkingStepManager instance for adding thinking steps
        task_state_manager: Optional TaskStateManager instance for checking cancellation
        session_id: Optional session ID for retry operations

    Returns:
        TaskStatus: Processing status
    """
    index = 0
    api_error_retry_count = 0  # Track retry count for this session
    # Track silent exit detection from UserMessage tool results
    silent_exit_detected = False
    silent_exit_reason = ""
    # Track cancellation to continue processing SDK interrupt messages
    cancellation_in_progress = False
    # Track if we've seen SDK interrupt messages (for resume detection)
    saw_sdk_interrupt_messages = False
    # Track if StreamEvent has sent any content
    # If True, AssistantMessage will skip sending events to avoid duplicates
    stream_event_sent = False
    try:
        while True:
            retry_requested = False

            async for msg in client.receive_response():
                index += 1

                # Check for cancellation before processing each message
                # Also detect SDK interrupt messages (user cancelled via SDK)
                if task_state_manager:
                    task_id = (
                        state_manager.task_data.get("task_id")
                        if state_manager
                        else None
                    )
                    if task_id and task_state_manager.is_cancelled(task_id):
                        if not cancellation_in_progress:
                            logger.info(
                                f"Task {task_id} cancelled during response processing - will continue processing SDK interrupt messages"
                            )
                            cancellation_in_progress = True
                            if state_manager:
                                # Mark as cancelling to block further RUNNING status reports
                                state_manager.mark_cancelling()

                        # Don't send progress callback here - wait until all SDK interrupt messages are processed
                        # SDK will send: ToolResultBlock -> TextBlock -> ResultMessage (error_during_execution)
                        # We'll send CANCELLED status in ResultMessage handler after all messages are processed

                # Also detect SDK interrupt message (UserMessage with "[Request interrupted by user]")
                if isinstance(msg, UserMessage):
                    for block in msg.content:
                        if (
                            isinstance(block, TextBlock)
                            and "[Request interrupted by user]" in block.text
                        ):
                            if not cancellation_in_progress:
                                logger.info(
                                    f"Detected SDK interrupt message - marking cancellation_in_progress=True"
                                )
                                cancellation_in_progress = True
                                if state_manager:
                                    state_manager.mark_cancelling()
                            break

                # Log the number of messages received
                logger.info(f"claude message index: {index}, received: {msg}")

                if isinstance(msg, SystemMessage):
                    # Handle SystemMessage
                    _handle_system_message(msg, state_manager, thinking_manager)

                elif isinstance(msg, UserMessage):
                    # Handle UserMessage and check for silent_exit in tool results
                    is_silent, reason = await _handle_user_message(
                        msg, emitter, thinking_manager, state_manager
                    )
                    if is_silent:
                        silent_exit_detected = True
                        silent_exit_reason = reason
                        logger.info(
                            f"🔇 Silent exit detected in UserMessage, will propagate to result: reason={reason}"
                        )

                elif isinstance(msg, StreamEvent):
                    # Handle streaming events for real-time text updates
                    # Returns True if any content was sent via streaming
                    sent = await _handle_stream_event(msg, emitter, state_manager)
                    if sent:
                        stream_event_sent = True

                elif isinstance(msg, AssistantMessage):
                    # Handle assistant message and detect API errors
                    # Note: Retry logic is handled in ResultMessage processing to avoid duplicate retries
                    # Pass stream_event_sent to skip emitting events if streaming already sent them
                    await _handle_assistant_message(
                        msg, emitter, state_manager, thinking_manager, stream_event_sent
                    )

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
                        emitter,
                        state_manager,
                        thinking_manager,
                        client,
                        current_session_id,
                        api_error_retry_count,
                        MAX_API_ERROR_RETRIES,
                        silent_exit_detected,
                        silent_exit_reason,
                        task_state_manager,
                        cancellation_in_progress,
                        saw_sdk_interrupt_messages,
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

        # Check if this exception is due to user cancellation
        # When client is interrupted/terminated, it raises an exception
        # We should check task state before treating it as a failure
        if task_state_manager and state_manager:
            task_id = state_manager.task_data.get("task_id")
            if task_id and task_state_manager.is_cancelled(task_id):
                logger.info(
                    f"Exception due to user cancellation for task {task_id}, "
                    f"treating as CANCELLED not FAILED"
                )
                if state_manager:
                    state_manager.set_task_status(TaskStatus.CANCELLED.value)

                # Clean up task state
                task_state_manager.cleanup(task_id)
                return TaskStatus.CANCELLED

        # Real error, not cancellation
        # Add thinking step for error
        if thinking_manager:
            thinking_manager.add_thinking_step_by_key(
                title_key="thinking.response_processing_error", report_immediately=False
            )

        # Update workbench status to failed
        if state_manager:
            state_manager.set_task_status(TaskStatus.FAILED.value)

            # Report error using state manager
            state_manager.report_progress(
                progress=100,
                status=TaskStatus.FAILED.value,
                message=f"Error processing response: {str(e)}",
                extra_result={"error": str(e)},
            )
        return TaskStatus.FAILED


def _handle_system_message(msg: SystemMessage, state_manager, thinking_manager=None):
    """Handle system messages and extract detailed information."""

    # Build system message details in target format
    system_detail = {
        "type": "system",
        "subtype": msg.subtype,
        **msg.data,  # Include original system message data
    }

    # Mask sensitive data in system details before sending
    masked_system_detail = mask_sensitive_data(system_detail)

    # Log with masked data
    msg_dict = asdict(msg)
    masked_msg_dict = mask_sensitive_data(msg_dict)
    logger.info(
        f"SystemMessage: subtype = {msg.subtype}. msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}"
    )

    # Save Claude session ID from init message for future resume
    # This ensures session can be resumed even if task is cancelled early
    if msg.subtype == "init" and "session_id" in msg.data:
        task_id = state_manager.task_data.get("task_id") if state_manager else None
        if task_id:
            try:
                from executor.agents.claude_code.session_manager import SessionManager

                claude_session_id = msg.data["session_id"]
                SessionManager.save_session_id(task_id, claude_session_id)
                logger.info(
                    f"Saved Claude session_id {claude_session_id} from init message for task {task_id}"
                )
            except Exception as save_error:
                logger.warning(
                    f"Failed to save session ID from init message: {save_error}"
                )

    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.system_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_system_detail,
        )


async def _handle_user_message(
    msg: UserMessage,
    emitter: ResponsesAPIEmitter,
    thinking_manager=None,
    state_manager=None,
) -> tuple[bool, str]:
    """
    Args:
        msg: UserMessage to process
        emitter: ResponsesAPIEmitter instance for sending events
        thinking_manager: Optional ThinkingStepManager instance
        state_manager: Optional ProgressStateManager instance

    Returns:
        Tuple of (silent_exit_detected, silent_exit_reason)
    """
    from executor.tools.silent_exit import detect_silent_exit

    # Track silent exit detection
    silent_exit_detected = False
    silent_exit_reason = ""

    # Build user message details in target format
    message_details = {
        "type": "user",
        "message": {
            "type": "message",
            "role": "user",
            "content": [],
            "parent_tool_use_id": msg.parent_tool_use_id,
        },
    }

    # Process content (can be string or list of content blocks)
    if isinstance(msg.content, str):
        # If string, use directly as text content
        text_detail = {"type": "text", "text": msg.content}
        message_details["message"]["content"].append(text_detail)
        logger.info(f"UserMessage: text content, length = {len(msg.content)}")
    else:
        # If list of content blocks, process each block
        logger.info(f"UserMessage: {len(msg.content)} content blocks")

        for block in msg.content:
            # Mask sensitive data in block content for logging
            block_dict = (
                asdict(block) if hasattr(block, "__dataclass_fields__") else block
            )
            masked_block_dict = mask_sensitive_data(block_dict)
            logger.info(f"UserMessage Block content: {masked_block_dict}")

            if isinstance(block, ToolUseBlock):
                # Tool use details in target format
                tool_detail = {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                }
                message_details["message"]["content"].append(tool_detail)

                logger.info(f"UserMessage ToolUseBlock: tool = {block.name}")

            elif isinstance(block, TextBlock):
                # Check if this is SDK interruption text block
                if "[Request interrupted by user for tool use]" in block.text:
                    logger.info(
                        f"Skipping SDK interruption text block for task {state_manager.task_data.get('task_id') if state_manager else 'unknown'}"
                    )
                    saw_sdk_interrupt_messages = (
                        True  # Mark that we saw interrupt messages
                    )
                    continue  # Skip this interruption message

                # Text content details in target format
                text_detail = {"type": "text", "text": block.text}
                message_details["message"]["content"].append(text_detail)

                logger.info(f"UserMessage TextBlock: {len(block.text)} chars")

            elif isinstance(block, ToolResultBlock):
                # Check if this is SDK interrupt error from previous cancellation
                if block.is_error and "Request interrupted" in str(block.content):
                    # This is expected on resume - skip this error block
                    logger.info(
                        f"Skipping SDK interrupt error on resume for task {state_manager.task_data.get('task_id') if state_manager else 'unknown'}"
                    )
                    saw_sdk_interrupt_messages = (
                        True  # Mark that we saw interrupt messages
                    )
                    continue  # Skip processing this error block

                # Tool result details in target format
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

                # Send tool_result event (response.output_item.done) via emitter
                try:
                    # Convert content to string for output
                    tool_output = (
                        json.dumps(block.content, ensure_ascii=False)
                        if isinstance(block.content, (dict, list))
                        else str(block.content)
                    )
                    await emitter.tool_done(
                        call_id=block.tool_use_id,
                        name="",  # Tool name not available in ToolResultBlock
                        output=tool_output,
                    )
                    logger.info(
                        f"Sent tool_result event for tool_use_id {block.tool_use_id}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to send tool_result event: {e}")

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
                # Unknown block type in target format
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

    # Log the overall message
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.user_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_message_details,
        )

    return silent_exit_detected, silent_exit_reason


async def _handle_assistant_message(
    msg: AssistantMessage,
    emitter: ResponsesAPIEmitter,
    state_manager,
    thinking_manager=None,
    stream_event_sent: bool = False,
) -> bool:
    """
    Handle AssistantMessage from Claude SDK.

    If stream_event_sent is True, skip sending events via emitter because
    StreamEvent has already sent them. This avoids duplicate tool blocks.

    Args:
        msg: AssistantMessage to process
        emitter: ResponsesAPIEmitter instance for sending events
        state_manager: ProgressStateManager instance
        thinking_manager: Optional ThinkingStepManager instance
        stream_event_sent: If True, skip emitting events (streaming already sent them)

    Returns:
        bool: True if API error detected and retry is needed, False otherwise
    """

    # Collect all content block details in target format
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
        f"AssistantMessage: {len(msg.content)} content blocks, stream_event_sent={stream_event_sent}, msg = {json.dumps(masked_msg_dict, ensure_ascii=False)}"
    )

    # Process each content block
    for block in msg.content:
        # Mask sensitive data in block for logging
        block_dict = asdict(block) if hasattr(block, "__dataclass_fields__") else block
        masked_block_dict = mask_sensitive_data(block_dict)
        logger.info(f"Block content: {masked_block_dict}")

        if isinstance(block, ToolUseBlock):
            # Tool use details in target format
            tool_detail = {
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            }
            message_details["message"]["content"].append(tool_detail)

            logger.info(f"ToolUseBlock: tool = {block.name}")

            # Skip sending tool_start if streaming already sent it
            if not stream_event_sent:
                # Send tool_start event (response.output_item.added) via emitter
                try:
                    # Flush any buffered text_delta events before sending tool_start
                    # This ensures text content is sent before tool events
                    await emitter.flush()

                    # Convert tool input to JSON string for arguments
                    arguments = (
                        json.dumps(block.input, ensure_ascii=False)
                        if isinstance(block.input, (dict, list))
                        else str(block.input) if block.input else "{}"
                    )
                    await emitter.tool_start(
                        call_id=block.id,
                        name=block.name,
                        arguments=arguments,
                    )
                    logger.info(f"Sent tool_start event for tool {block.name}")
                except Exception as e:
                    logger.warning(f"Failed to send tool_start event: {e}")

        elif isinstance(block, TextBlock):
            # Text content details in target format
            text_detail = {"type": "text", "text": block.text}
            message_details["message"]["content"].append(text_detail)

            state_manager.update_workbench_summary(block.text)

            logger.info(f"TextBlock: {len(block.text)} chars")

            # Skip sending text_delta if streaming already sent it
            if not stream_event_sent:
                # Send chunk event (response.output_text.delta) via emitter
                try:
                    await emitter.text_delta(block.text)
                    logger.info(f"Sent chunk event with {len(block.text)} chars")
                except Exception as e:
                    logger.warning(f"Failed to send chunk event: {e}")

        elif isinstance(block, ToolResultBlock):
            # Tool result details in target format
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
            # Unknown block type in target format
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

    # Log the overall message
    if thinking_manager:
        thinking_manager.add_thinking_step(
            title="thinking.assistant_message_received",
            report_immediately=True,
            use_i18n_keys=True,
            details=masked_message_details,
        )

    return needs_retry


async def _handle_stream_event(
    msg: StreamEvent,
    emitter: ResponsesAPIEmitter,
    state_manager,
) -> bool:
    """
    Handle streaming events for real-time text updates.

    StreamEvent contains raw Anthropic API stream events that provide
    incremental text updates during response generation.

    Args:
        msg: StreamEvent containing the raw stream event data
        emitter: ResponsesAPIEmitter instance for sending events
        state_manager: ProgressStateManager instance for updating workbench

    Returns:
        bool: True if any content was sent via streaming, False otherwise.
              When True, AssistantMessage should skip sending duplicate events.
    """
    event = msg.event
    event_type = event.get("type", "")
    sent_content = False

    # Handle content_block_delta events which contain text deltas
    if event_type == "content_block_delta":
        delta = event.get("delta", {})
        delta_type = delta.get("type", "")

        if delta_type == "text_delta":
            text = delta.get("text", "")
            if text:
                # Send text delta to frontend immediately
                try:
                    await emitter.text_delta(text)
                    logger.debug(f"StreamEvent: sent text_delta with {len(text)} chars")
                    sent_content = True
                except Exception as e:
                    logger.warning(f"Failed to send stream text_delta: {e}")

                # Update workbench summary with streaming text
                if state_manager:
                    state_manager.update_workbench_summary(text, append=True)

        elif delta_type == "input_json_delta":
            # Tool input streaming - could be used for showing tool arguments being built
            partial_json = delta.get("partial_json", "")
            logger.debug(
                f"StreamEvent: input_json_delta with {len(partial_json)} chars"
            )

    elif event_type == "content_block_start":
        # A new content block is starting
        content_block = event.get("content_block", {})
        block_type = content_block.get("type", "")
        logger.debug(f"StreamEvent: content_block_start, type={block_type}")

        if block_type == "tool_use":
            # Tool use is starting - send tool_start event
            tool_id = content_block.get("id", "")
            tool_name = content_block.get("name", "")
            if tool_id and tool_name:
                try:
                    # Flush any buffered text_delta events before sending tool_start
                    # This ensures text content is sent before tool events
                    await emitter.flush()

                    await emitter.tool_start(
                        call_id=tool_id,
                        name=tool_name,
                        arguments="{}",  # Arguments will be streamed via input_json_delta
                    )
                    logger.debug(f"StreamEvent: sent tool_start for {tool_name}")
                    sent_content = True
                except Exception as e:
                    logger.warning(f"Failed to send stream tool_start: {e}")

        elif block_type == "text":
            # Text block is starting - mark as sent to avoid duplicate in AssistantMessage
            sent_content = True

    elif event_type == "content_block_stop":
        # A content block has finished
        logger.debug(f"StreamEvent: content_block_stop, index={event.get('index', -1)}")

    elif event_type == "message_start":
        # Message is starting
        logger.debug(f"StreamEvent: message_start")

    elif event_type == "message_delta":
        # Message metadata update (e.g., stop_reason)
        delta = event.get("delta", {})
        stop_reason = delta.get("stop_reason")
        if stop_reason:
            logger.debug(f"StreamEvent: message_delta, stop_reason={stop_reason}")

    elif event_type == "message_stop":
        # Message has finished
        logger.debug(f"StreamEvent: message_stop")

    else:
        # Log unknown event types for debugging
        logger.debug(f"StreamEvent: unknown type={event_type}, event={event}")

    return sent_content


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
    emitter: ResponsesAPIEmitter,
    state_manager,
    thinking_manager=None,
    client=None,
    session_id: str = None,
    api_error_retry_count: int = 0,
    max_retries: int = 3,
    propagated_silent_exit: bool = False,
    propagated_silent_exit_reason: str = "",
    task_state_manager=None,
    cancellation_in_progress: bool = False,
    saw_sdk_interrupt_messages: bool = False,
) -> Union[TaskStatus, str, None]:
    """
    Process a ResultMessage from Claude

    Args:
        msg: The ResultMessage to process
        emitter: ResponsesAPIEmitter instance for sending events
        state_manager: ProgressStateManager instance for managing state and reporting progress
        thinking_manager: Optional ThinkingStepManager instance
        client: ClaudeSDKClient for sending retry messages
        session_id: Session ID for retry operations
        api_error_retry_count: Current retry count
        max_retries: Maximum retry attempts
        propagated_silent_exit: Silent exit flag propagated from UserMessage tool results
        propagated_silent_exit_reason: Silent exit reason propagated from UserMessage tool results
        task_state_manager: Optional TaskStateManager for checking cancellation state

    Returns:
        TaskStatus: Processing status (COMPLETED if successful, CANCELLED, FAILED, or None)
        str: "RETRY" if API error retry was initiated
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

    # If it's a successful result message, send the result back via emitter
    if msg.subtype == "success" and not msg.is_error:
        # Get task info from state_manager
        task_id = state_manager.task_data.get("task_id", -1) if state_manager else -1

        # Ensure result is string type
        result_str = str(msg.result) if msg.result is not None else "No result"
        logger.info(f"Sending successful result via emitter: {result_str}")

        # Add thinking step for successful result
        if thinking_manager:
            thinking_manager.add_thinking_step(
                title="thinking.task_execution_success",
                report_immediately=False,
                use_i18n_keys=True,
                details=masked_result_details,
            )

        # If there's a result, pass it as result parameter to emitter.done
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

                # Update task status to completed
                state_manager.set_task_status(TaskStatus.COMPLETED.value)

                # Get content string from result
                content = (
                    result_value
                    if isinstance(result_value, str)
                    else (
                        json.dumps(result_value, ensure_ascii=False)
                        if result_value
                        else result_str
                    )
                )

                # Send done event (response.completed) via emitter
                await emitter.done(
                    content=content,
                    usage=msg.usage,
                    silent_exit=silent_exit_detected if silent_exit_detected else None,
                    silent_exit_reason=(
                        silent_exit_reason if silent_exit_reason else None
                    ),
                )
                logger.info(f"Sent done event for task {task_id}")
            except Exception as e:
                logger.error(f"Failed to send done event: {e}")
                if thinking_manager:
                    thinking_manager.add_thinking_step(
                        title="thinking.result_parsing_error",
                        report_immediately=False,
                        use_i18n_keys=True,
                    )

                # Update task status to failed
                state_manager.set_task_status(TaskStatus.FAILED.value)

                # Send error event via emitter
                await emitter.error(str(e))
        else:
            # Update task status to completed
            state_manager.set_task_status(TaskStatus.COMPLETED.value)

            # Send done event (response.completed) via emitter
            await emitter.done(
                content=result_str,
                usage=msg.usage,
            )
            logger.info(f"Sent done event for task {task_id}")
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

        # Update task status to failed
        state_manager.set_task_status(TaskStatus.FAILED.value)

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

        # Check if this is resuming from an interrupted task
        # When resuming from interruption, SDK may legitimately return error_during_execution
        # Check both: 1) if we saw SDK interrupt messages in this cycle, OR 2) task state is INTERRUPTED
        is_resuming_from_interruption = saw_sdk_interrupt_messages

        if not is_resuming_from_interruption and task_state_manager and state_manager:
            task_id = state_manager.task_data.get("task_id")
            if task_id:
                from executor.tasks.task_state_manager import TaskState

                task_state = task_state_manager.get_state(task_id)
                if task_state == TaskState.INTERRUPTED:
                    is_resuming_from_interruption = True
                    logger.info(
                        f"Task {task_id} resumed from interruption based on task state"
                    )
                    # Clear interrupted state and set to RUNNING
                    task_state_manager.set_state(task_id, TaskState.RUNNING)

        if is_resuming_from_interruption:
            # This is expected - SDK is reporting the previous interruption
            # Return SUCCESS to indicate initialization can continue
            # The actual new message will be processed in execute phase
            if state_manager:
                task_id = state_manager.task_data.get("task_id")
            logger.info(
                f"Ignoring error_during_execution on resume for task {task_id}, returning SUCCESS"
            )
            return TaskStatus.SUCCESS

        # Check if this is due to current cancellation (cancellation_in_progress flag)
        # When user cancels during execution, SDK sends error_during_execution
        # This is the final message in the interrupt sequence - we can now return CANCELLED
        logger.info(
            f"Checking cancellation status: cancellation_in_progress={cancellation_in_progress}, "
            f"is_resuming={is_resuming_from_interruption}"
        )
        if cancellation_in_progress:
            logger.info(
                f"Task {task_id} error_during_execution due to current cancellation - marking as INTERRUPTED internally"
            )
            # Mark task as INTERRUPTED internally (preserve session for resumption)
            if task_state_manager and task_id:
                task_state_manager.set_interrupted(task_id)
                logger.info(
                    f"Task {task_id} marked as INTERRUPTED internally (session preserved for resumption)"
                )

            # Return CANCELLED to frontend (INTERRUPTED is internal state only)
            return TaskStatus.CANCELLED

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

        # Update task status to failed
        state_manager.set_task_status(TaskStatus.FAILED.value)

        # Report error using state manager
        state_manager.report_progress(
            progress=100, status=TaskStatus.FAILED.value, message=result_str
        )
        return TaskStatus.FAILED

    # If it's not a successful result message, return None to let caller continue processing
    return None
