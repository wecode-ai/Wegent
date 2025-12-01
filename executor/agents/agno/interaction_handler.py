#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Interaction Handler for Intelligent Coordinate Team

This module provides utilities for parsing bot output to identify interaction markers
and determine the appropriate workflow state transitions.

Interaction Markers:
- [INTERACTION_REQUIRED]: Bot needs user input, pause execution
- [TASK_COMPLETED]: Bot finished current task, return to Leader for next step
- [WORKFLOW_DONE]: Entire workflow completed, end task
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional
import re

from shared.logger import setup_logger

logger = setup_logger("interaction_handler")


class InteractionStatus(str, Enum):
    """Status indicators based on interaction markers"""
    INTERACTION_REQUIRED = "interaction_required"  # Bot needs user input
    TASK_COMPLETED = "task_completed"  # Bot finished task, Leader decides next
    WORKFLOW_DONE = "workflow_done"  # Entire workflow completed
    IN_PROGRESS = "in_progress"  # Task still running, no markers found


@dataclass
class InteractionResult:
    """Result of parsing bot output for interaction markers"""
    status: InteractionStatus
    content: str
    current_bot_name: Optional[str] = None  # Bot that produced this output
    metadata: Optional[dict] = None  # Additional metadata (e.g., iteration count)


# Marker patterns
INTERACTION_REQUIRED_MARKER = "[INTERACTION_REQUIRED]"
TASK_COMPLETED_MARKER = "[TASK_COMPLETED]"
WORKFLOW_DONE_MARKER = "[WORKFLOW_DONE]"


def parse_bot_output(output: str, bot_name: Optional[str] = None) -> InteractionResult:
    """
    Parse bot output to identify interaction markers

    Args:
        output: The bot's output text
        bot_name: Name of the bot that produced this output (optional)

    Returns:
        InteractionResult with status and cleaned content
    """
    if not output:
        return InteractionResult(
            status=InteractionStatus.IN_PROGRESS,
            content="",
            current_bot_name=bot_name
        )

    # Check for markers in order of priority
    if INTERACTION_REQUIRED_MARKER in output:
        logger.info(f"Bot {bot_name} requested user interaction")
        return InteractionResult(
            status=InteractionStatus.INTERACTION_REQUIRED,
            content=_clean_marker(output, INTERACTION_REQUIRED_MARKER),
            current_bot_name=bot_name
        )

    if WORKFLOW_DONE_MARKER in output:
        logger.info(f"Bot {bot_name} completed entire workflow")
        return InteractionResult(
            status=InteractionStatus.WORKFLOW_DONE,
            content=_clean_marker(output, WORKFLOW_DONE_MARKER),
            current_bot_name=bot_name
        )

    if TASK_COMPLETED_MARKER in output:
        logger.info(f"Bot {bot_name} completed current task")
        return InteractionResult(
            status=InteractionStatus.TASK_COMPLETED,
            content=_clean_marker(output, TASK_COMPLETED_MARKER),
            current_bot_name=bot_name
        )

    # No markers found, task is still in progress
    return InteractionResult(
        status=InteractionStatus.IN_PROGRESS,
        content=output,
        current_bot_name=bot_name
    )


def _clean_marker(text: str, marker: str) -> str:
    """
    Remove marker from text and clean up whitespace

    Args:
        text: Text containing the marker
        marker: Marker to remove

    Returns:
        Cleaned text without the marker
    """
    cleaned = text.replace(marker, "").strip()
    # Remove multiple consecutive newlines
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned


def should_wait_for_user_input(result: InteractionResult) -> bool:
    """
    Check if the system should wait for user input based on interaction result

    Args:
        result: InteractionResult from parse_bot_output

    Returns:
        True if user input is needed
    """
    return result.status == InteractionStatus.INTERACTION_REQUIRED


def is_workflow_complete(result: InteractionResult) -> bool:
    """
    Check if the entire workflow is complete

    Args:
        result: InteractionResult from parse_bot_output

    Returns:
        True if workflow is done
    """
    return result.status == InteractionStatus.WORKFLOW_DONE


def is_task_complete(result: InteractionResult) -> bool:
    """
    Check if the current task is complete (Leader should decide next step)

    Args:
        result: InteractionResult from parse_bot_output

    Returns:
        True if current task is done
    """
    return result.status == InteractionStatus.TASK_COMPLETED


def build_leader_context(
    original_request: str,
    completed_tasks: list,
    current_output: str,
    iteration_count: int = 0,
    max_iterations: int = 3
) -> str:
    """
    Build context for Leader to make scheduling decisions

    Args:
        original_request: The original user requirement
        completed_tasks: List of completed task summaries
        current_output: Output from the latest completed task
        iteration_count: Current test-fix iteration count
        max_iterations: Maximum allowed test-fix iterations

    Returns:
        Formatted context string for Leader
    """
    context_parts = [
        "## Current Workflow Status",
        "",
        "### Original Request",
        original_request,
        "",
        "### Completed Tasks",
    ]

    if completed_tasks:
        for i, task in enumerate(completed_tasks, 1):
            context_parts.append(f"{i}. {task}")
    else:
        context_parts.append("(No tasks completed yet)")

    context_parts.extend([
        "",
        "### Latest Output",
        current_output,
        "",
        f"### Iteration Info",
        f"- Test-Fix Iterations: {iteration_count}/{max_iterations}",
    ])

    if iteration_count >= max_iterations:
        context_parts.append("- ⚠️ Maximum iterations reached, please wrap up the workflow")

    context_parts.extend([
        "",
        "### Your Task",
        "Based on the above status, determine the next action:",
        "1. If requirements need clarification → Dispatch clarifier",
        "2. If development is needed → Dispatch developer",
        "3. If testing is needed → Dispatch tester",
        "4. If tests failed → Dispatch developer to fix",
        "5. If documentation is needed → Dispatch doc-writer",
        "6. If all work is done → Output [WORKFLOW_DONE] with summary",
    ])

    return "\n".join(context_parts)


def extract_waiting_bot_info(metadata: Optional[dict]) -> Optional[str]:
    """
    Extract the bot name that is waiting for user input from metadata

    Args:
        metadata: Subtask or task metadata dictionary

    Returns:
        Bot name if found, None otherwise
    """
    if not metadata:
        return None
    return metadata.get("waiting_bot_name")


def build_waiting_metadata(bot_name: str, additional_info: Optional[dict] = None) -> dict:
    """
    Build metadata for a subtask that is waiting for user input

    Args:
        bot_name: Name of the bot waiting for input
        additional_info: Additional metadata to include

    Returns:
        Metadata dictionary
    """
    metadata = {
        "waiting_bot_name": bot_name,
        "interaction_status": InteractionStatus.INTERACTION_REQUIRED.value
    }
    if additional_info:
        metadata.update(additional_info)
    return metadata
