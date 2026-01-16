# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Artifact utility functions.

This module provides common functions for artifact handling,
used by both backend API and chat_shell history loader.
"""

from typing import Any


def format_artifact_for_history(artifact: dict[str, Any]) -> str:
    """Format artifact content for chat history display.

    This function converts an artifact object into a formatted string
    suitable for display in chat history. The format includes metadata
    that allows the AI to identify and modify the artifact.

    Args:
        artifact: Artifact dictionary containing:
            - id: Unique artifact identifier
            - artifact_type: "code" or "text"
            - title: Display title
            - content: Actual content
            - language: Programming language (for code type)

    Returns:
        Formatted string with artifact metadata and content.

    Example output for code:
        [Created Artifact: main.py (artifact_id: abc-123)]
        ```python
        def hello():
            print("Hello")
        ```

    Example output for text:
        [Created Artifact: README (artifact_id: abc-123)]
        This is the readme content...
    """
    artifact_type = artifact.get("artifact_type", "text")
    title = artifact.get("title", "Untitled")
    content = artifact.get("content", "")
    language = artifact.get("language", "")
    artifact_id = artifact.get("id", "")

    if artifact_type == "code" and language:
        return (
            f"[Created Artifact: {title} (artifact_id: {artifact_id})]\n"
            f"```{language}\n{content}\n```"
        )
    return f"[Created Artifact: {title} (artifact_id: {artifact_id})]\n{content}"


def extract_artifact_from_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    """Extract artifact data from a subtask result or task canvas data.

    Args:
        result: Result dictionary that may contain artifact data.

    Returns:
        Artifact dictionary if found, None otherwise.
    """
    if not result:
        return None

    # Check for artifact type result
    if result.get("type") == "artifact":
        return result.get("artifact")

    # Check for canvas data structure
    if "canvas" in result:
        canvas = result["canvas"]
        if isinstance(canvas, dict):
            return canvas.get("artifact")

    return None


def is_artifact_result(result: Any) -> bool:
    """Check if a result contains artifact data.

    Args:
        result: Any result value to check.

    Returns:
        True if the result contains artifact data.
    """
    if not isinstance(result, dict):
        return False

    return result.get("type") == "artifact" and "artifact" in result
