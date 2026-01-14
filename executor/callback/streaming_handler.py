#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Streaming callback handler module for executor streaming events.

This module provides helper functions to send streaming events
(stream_start, stream_chunk, tool_start, tool_done, stream_done, stream_error)
to the executor manager for real-time streaming output.
"""

import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from shared.logger import setup_logger
from shared.status import TaskStatus

from executor.callback.callback_client import CallbackClient

logger = setup_logger("streaming_callback_handler")

# Create a singleton callback client instance
callback_client = CallbackClient()


class StreamingEventType:
    """Streaming event types for executor streaming"""

    STREAM_START = "stream_start"
    STREAM_CHUNK = "stream_chunk"
    TOOL_START = "tool_start"
    TOOL_DONE = "tool_done"
    STREAM_DONE = "stream_done"
    STREAM_ERROR = "stream_error"


class StreamingCallbackState:
    """
    Track streaming state for throttled callbacks.

    This class maintains state for streaming content and implements
    throttling to avoid sending too many HTTP requests.
    """

    def __init__(self, emit_interval: float = 0.5):
        """
        Initialize streaming state.

        Args:
            emit_interval: Minimum interval between chunk emissions in seconds (default 0.5s)
        """
        self.accumulated_content: str = ""
        self.last_emit_time: float = 0.0
        self.emit_interval: float = emit_interval
        self.offset: int = 0
        self.thinking_steps: List[Dict[str, Any]] = []
        self.workbench: Optional[Dict[str, Any]] = None
        self.stream_started: bool = False
        self.pending_chunk: str = ""

    def should_emit(self) -> bool:
        """Check if enough time has passed for next emit."""
        current_time = time.time()
        return (current_time - self.last_emit_time) >= self.emit_interval

    def mark_emitted(self) -> None:
        """Mark that a chunk was just emitted."""
        self.last_emit_time = time.time()
        self.pending_chunk = ""

    def add_content(self, new_content: str) -> tuple:
        """
        Add content and return (should_emit, chunk, offset).

        Args:
            new_content: New content to add

        Returns:
            Tuple of (should_emit, chunk, offset)
        """
        previous_length = len(self.accumulated_content)
        self.accumulated_content += new_content
        self.pending_chunk += new_content

        if self.should_emit():
            chunk = self.pending_chunk
            offset = previous_length
            return True, chunk, offset
        return False, "", previous_length

    def get_final_chunk(self) -> tuple:
        """
        Get remaining pending content for final emission.

        Returns:
            Tuple of (chunk, offset)
        """
        chunk = self.pending_chunk
        offset = len(self.accumulated_content) - len(chunk)
        return chunk, offset


def send_stream_start_callback(
    task_id: int,
    subtask_id: int,
    shell_type: str,
    task_title: str = "",
    subtask_title: str = "",
) -> Dict[str, Any]:
    """
    Send stream_start event to indicate streaming has begun.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        shell_type: Shell type (e.g., "ClaudeCode", "Agno")
        task_title: Task title
        subtask_title: Subtask title

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.STREAM_START,
            "shell_type": shell_type,
            "timestamp": datetime.now().isoformat(),
        }

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=10,
            status=TaskStatus.RUNNING.value,
            result={"streaming_event": streaming_event},
        )

        logger.info(
            f"Sent stream_start callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, shell_type={shell_type}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send stream_start callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}


def send_stream_chunk_callback(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int,
    task_title: str = "",
    subtask_title: str = "",
    result_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Send stream_chunk event with incremental content.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        content: Incremental content chunk
        offset: Offset in the full response
        task_title: Task title
        subtask_title: Subtask title
        result_data: Optional additional result data (thinking, workbench, etc.)

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.STREAM_CHUNK,
            "content": content,
            "offset": offset,
            "timestamp": datetime.now().isoformat(),
        }

        # Include additional result data if provided
        if result_data:
            streaming_event["result"] = result_data

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=50,
            status=TaskStatus.RUNNING.value,
            result={"streaming_event": streaming_event},
        )

        logger.debug(
            f"Sent stream_chunk callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, offset={offset}, content_len={len(content)}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send stream_chunk callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}


def send_tool_start_callback(
    task_id: int,
    subtask_id: int,
    tool_id: str,
    tool_name: str,
    tool_input: Optional[Dict[str, Any]] = None,
    task_title: str = "",
    subtask_title: str = "",
) -> Dict[str, Any]:
    """
    Send tool_start event when a tool execution begins.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        tool_id: Unique tool execution ID
        tool_name: Name of the tool being executed
        tool_input: Input parameters for the tool
        task_title: Task title
        subtask_title: Subtask title

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.TOOL_START,
            "tool_id": tool_id,
            "tool_name": tool_name,
            "tool_input": tool_input or {},
            "timestamp": datetime.now().isoformat(),
        }

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=60,
            status=TaskStatus.RUNNING.value,
            result={"streaming_event": streaming_event},
        )

        logger.debug(
            f"Sent tool_start callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, tool_name={tool_name}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send tool_start callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}


def send_tool_done_callback(
    task_id: int,
    subtask_id: int,
    tool_id: str,
    tool_output: Optional[str] = None,
    tool_error: Optional[str] = None,
    task_title: str = "",
    subtask_title: str = "",
) -> Dict[str, Any]:
    """
    Send tool_done event when a tool execution completes.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        tool_id: Unique tool execution ID (matches tool_start)
        tool_output: Output from the tool execution
        tool_error: Error message if tool failed
        task_title: Task title
        subtask_title: Subtask title

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.TOOL_DONE,
            "tool_id": tool_id,
            "tool_output": tool_output,
            "tool_error": tool_error,
            "timestamp": datetime.now().isoformat(),
        }

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=70,
            status=TaskStatus.RUNNING.value,
            result={"streaming_event": streaming_event},
        )

        logger.debug(
            f"Sent tool_done callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, tool_id={tool_id}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send tool_done callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}


def send_stream_done_callback(
    task_id: int,
    subtask_id: int,
    offset: int,
    result_data: Dict[str, Any],
    task_title: str = "",
    subtask_title: str = "",
) -> Dict[str, Any]:
    """
    Send stream_done event when streaming completes successfully.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        offset: Final offset (total content length)
        result_data: Complete result data (value, thinking, workbench, etc.)
        task_title: Task title
        subtask_title: Subtask title

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.STREAM_DONE,
            "offset": offset,
            "result": result_data,
            "timestamp": datetime.now().isoformat(),
        }

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=100,
            status=TaskStatus.COMPLETED.value,
            result={"streaming_event": streaming_event},
        )

        logger.info(
            f"Sent stream_done callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, offset={offset}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send stream_done callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}


def send_stream_error_callback(
    task_id: int,
    subtask_id: int,
    error: str,
    task_title: str = "",
    subtask_title: str = "",
) -> Dict[str, Any]:
    """
    Send stream_error event when streaming encounters an error.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        error: Error message
        task_title: Task title
        subtask_title: Subtask title

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        streaming_event = {
            "event_type": StreamingEventType.STREAM_ERROR,
            "error": error,
            "timestamp": datetime.now().isoformat(),
        }

        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=100,
            status=TaskStatus.FAILED.value,
            message=error,
            result={"streaming_event": streaming_event},
        )

        logger.error(
            f"Sent stream_error callback: task_id={task_id}, "
            f"subtask_id={subtask_id}, error={error}"
        )
        return result

    except Exception as e:
        logger.error(f"Failed to send stream_error callback: {e}")
        return {"status": TaskStatus.FAILED.value, "error_msg": str(e)}
