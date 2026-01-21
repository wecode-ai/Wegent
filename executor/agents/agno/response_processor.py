#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Any, Dict, List, Union

from shared.logger import setup_logger
from shared.status import TaskStatus

logger = setup_logger("agno_response_processor")


async def process_response(team, report_progress_callback) -> TaskStatus:
    """
    Process the response from Agno team execution

    Args:
        team: The Agno team instance
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status
    """
    try:
        # This function is called after the team execution is completed
        # The actual processing is done in the agno_agent.py file
        # This function serves as a placeholder for any additional response processing

        logger.info("Processing Agno team response")

        # Since the actual response processing is handled in the agent's _run_team_async method,
        # we just return SUCCESS here
        return TaskStatus.COMPLETED

    except Exception as e:
        logger.exception(f"Error processing Agno response: {str(e)}")
        # Send error information as result on failure
        error_result = {"error": str(e)}
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Error processing response: {str(e)}",
            result=error_result,
        )
        return TaskStatus.FAILED


def process_team_chunk(chunk, report_progress_callback) -> TaskStatus:
    """
    Process individual chunks from Agno team streaming response

    Args:
        chunk: The chunk from team execution
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status (None to continue, COMPLETED/FAILED to stop)
    """
    try:
        from agno.run.agent import RunEvent
        from agno.run.base import RunStatus
        from agno.run.team import TeamRunEvent

        # Handle different event types
        if hasattr(chunk, "event"):
            if chunk.event in [TeamRunEvent.run_content, RunEvent.run_content]:
                content = getattr(chunk, "content", "")
                if content:
                    logger.info(f"Team content: {content}")
                    # Report progress with content
                    report_progress_callback(
                        progress=70,
                        status=TaskStatus.RUNNING.value,
                        message=f"Processing: {content[:100]}...",
                        result={"partial_content": content},
                    )

            elif hasattr(chunk, "status") and chunk.status == RunStatus.completed:
                logger.info("Team run completed successfully")
                # Return None to continue processing
                return None

            elif chunk.event in [TeamRunEvent.run_cancelled, RunEvent.run_cancelled]:
                logger.warning("Team run was cancelled")
                report_progress_callback(
                    progress=100,
                    status=TaskStatus.CANCELLED.value,
                    message="Team run was cancelled",
                    result={"cancelled": True},
                )
                return TaskStatus.CANCELLED

        # Handle chunk content directly
        if hasattr(chunk, "content") and chunk.content:
            content = str(chunk.content)
            logger.info(f"Direct content: {content}")
            report_progress_callback(
                progress=75,
                status=TaskStatus.RUNNING.value,
                message=f"Content received: {content[:100]}...",
                result={"partial_content": content},
            )

        # Return None to continue processing
        return None

    except Exception as e:
        logger.exception(f"Error processing team chunk: {str(e)}")
        error_result = {"error": str(e)}
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Error processing chunk: {str(e)}",
            result=error_result,
        )
        return TaskStatus.FAILED


def process_final_result(
    content_pieces: List[str], report_progress_callback
) -> TaskStatus:
    """
    Process the final result from Agno team execution

    Args:
        content_pieces: List of content pieces collected during execution
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status
    """
    try:
        if not content_pieces:
            logger.warning("No content pieces to process")
            report_progress_callback(
                progress=100,
                status=TaskStatus.FAILED.value,
                message="No content received from team execution",
                result={"content": ""},
            )
            return TaskStatus.FAILED

        # Combine all content pieces
        result_content = "".join(content_pieces)
        logger.info(
            f"Processing final result with content length: {len(result_content)}"
        )

        # Report completion with result
        report_progress_callback(
            progress=100,
            status=TaskStatus.COMPLETED.value,
            message="Agno team execution completed",
            result={"content": result_content},
        )

        return TaskStatus.COMPLETED

    except Exception as e:
        logger.exception(f"Error processing final result: {str(e)}")
        error_result = {"error": str(e)}
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Error processing final result: {str(e)}",
            result=error_result,
        )
        return TaskStatus.FAILED


def handle_team_error(error: Exception, report_progress_callback) -> TaskStatus:
    """
    Handle errors from Agno team execution

    Args:
        error: The exception that occurred
        report_progress_callback: Callback function to report progress

    Returns:
        TaskStatus: Processing status
    """
    try:
        error_message = str(error)
        logger.error(f"Team execution error: {error_message}")

        # Send error information as result
        error_result = {"error": error_message, "exception_type": type(error).__name__}
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message=f"Team execution failed: {error_message}",
            result=error_result,
        )

        return TaskStatus.FAILED

    except Exception as e:
        logger.exception(f"Error handling team error: {str(e)}")
        # Fallback error reporting
        report_progress_callback(
            progress=100,
            status=TaskStatus.FAILED.value,
            message="Critical error during error handling",
            result={"error": "Critical error during error handling"},
        )
        return TaskStatus.FAILED
