# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Diff utilities for artifact version management.

This module provides functions to create and apply unified diffs,
enabling efficient storage of artifact version history.

Instead of storing complete content for each version, we store:
- Current content (full)
- History as diffs (compact)

This approach typically reduces storage by 75%+ for text content.
"""

import difflib
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def create_diff(old_content: str, new_content: str) -> str:
    """Generate a unified diff between two versions of content.

    Args:
        old_content: The previous version content.
        new_content: The new version content.

    Returns:
        A unified diff string. Empty string if contents are identical.

    Example:
        >>> old = "line1\\nline2\\nline3"
        >>> new = "line1\\nmodified\\nline3"
        >>> diff = create_diff(old, new)
        >>> print(diff)
        --- a
        +++ b
        @@ -1,3 +1,3 @@
         line1
        -line2
        +modified
         line3
    """
    if old_content == new_content:
        return ""

    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    # Ensure last line has newline for consistent diff output
    if old_lines and not old_lines[-1].endswith("\n"):
        old_lines[-1] += "\n"
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] += "\n"

    diff_lines = list(
        difflib.unified_diff(old_lines, new_lines, fromfile="a", tofile="b")
    )

    return "".join(diff_lines)


def apply_diff(content: str, diff: str, reverse: bool = False) -> Optional[str]:
    """Apply a unified diff to content.

    Args:
        content: The base content to apply the diff to.
        diff: The unified diff string.
        reverse: If True, apply the diff in reverse (to get older version).

    Returns:
        The resulting content after applying the diff, or None if failed.

    Note:
        When reverse=False: old_content + diff -> new_content
        When reverse=True:  new_content + diff -> old_content
    """
    if not diff:
        return content

    try:
        content_lines = content.splitlines(keepends=True)
        if content_lines and not content_lines[-1].endswith("\n"):
            content_lines[-1] += "\n"

        # Parse the diff
        diff_lines = diff.splitlines(keepends=True)

        # Extract hunks from diff
        hunks = _parse_unified_diff(diff_lines)

        if not hunks:
            logger.warning("[DIFF] No hunks found in diff")
            return content

        # Apply hunks
        result_lines = _apply_hunks(content_lines, hunks, reverse)

        # Remove trailing newline if original didn't have one
        result = "".join(result_lines)
        if result.endswith("\n") and not content.endswith("\n"):
            result = result[:-1]

        return result

    except Exception as e:
        logger.exception("[DIFF] Failed to apply diff: %s", e)
        return None


def _parse_unified_diff(diff_lines: list[str]) -> list[dict]:
    """Parse unified diff into list of hunks.

    Each hunk contains:
        - old_start: Starting line in old file (1-based)
        - old_count: Number of lines in old file
        - new_start: Starting line in new file (1-based)
        - new_count: Number of lines in new file
        - changes: List of (type, line) tuples where type is ' ', '-', or '+'
    """
    hunks = []
    current_hunk = None
    i = 0

    while i < len(diff_lines):
        line = diff_lines[i]

        # Skip file headers
        if line.startswith("---") or line.startswith("+++"):
            i += 1
            continue

        # Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
        if line.startswith("@@"):
            if current_hunk:
                hunks.append(current_hunk)

            parts = line.split()
            old_range = parts[1][1:]  # Remove leading '-'
            new_range = parts[2][1:]  # Remove leading '+'

            old_parts = old_range.split(",")
            new_parts = new_range.split(",")

            current_hunk = {
                "old_start": int(old_parts[0]),
                "old_count": int(old_parts[1]) if len(old_parts) > 1 else 1,
                "new_start": int(new_parts[0]),
                "new_count": int(new_parts[1]) if len(new_parts) > 1 else 1,
                "changes": [],
            }
            i += 1
            continue

        # Parse change lines
        if current_hunk is not None and line:
            change_type = line[0] if line[0] in " -+" else " "
            change_content = line[1:] if len(line) > 1 else "\n"
            current_hunk["changes"].append((change_type, change_content))

        i += 1

    if current_hunk:
        hunks.append(current_hunk)

    return hunks


def _apply_hunks(lines: list[str], hunks: list[dict], reverse: bool) -> list[str]:
    """Apply hunks to lines.

    Args:
        lines: Original content lines.
        hunks: Parsed hunks from diff.
        reverse: If True, swap + and - operations.

    Returns:
        Modified lines after applying all hunks.
    """
    result = lines.copy()
    offset = 0  # Track line offset as hunks modify line counts

    for hunk in hunks:
        if reverse:
            # When reversing, we're going from new to old
            start_line = hunk["new_start"] - 1 + offset
        else:
            # Normal: going from old to new
            start_line = hunk["old_start"] - 1 + offset

        # Calculate what to remove and what to add
        to_remove = []
        to_add = []

        for change_type, content in hunk["changes"]:
            if reverse:
                # Reverse the operation
                if change_type == "-":
                    to_add.append(content)
                elif change_type == "+":
                    to_remove.append(content)
                else:
                    to_add.append(content)
                    to_remove.append(content)
            else:
                # Normal operation
                if change_type == "-":
                    to_remove.append(content)
                elif change_type == "+":
                    to_add.append(content)
                else:
                    to_remove.append(content)
                    to_add.append(content)

        # Apply the changes
        # Remove old lines
        end_line = start_line + len([c for c in hunk["changes"] if c[0] != "+"])
        if reverse:
            end_line = start_line + len([c for c in hunk["changes"] if c[0] != "-"])

        # Build new section
        new_section = []
        for change_type, content in hunk["changes"]:
            if reverse:
                if change_type != "+":
                    new_section.append(content)
            else:
                if change_type != "-":
                    new_section.append(content)

        # Replace section
        result = result[:start_line] + new_section + result[end_line:]

        # Update offset for next hunk
        if reverse:
            offset += hunk["old_count"] - hunk["new_count"]
        else:
            offset += hunk["new_count"] - hunk["old_count"]

    return result


def get_version_content(
    current_content: str, history: list[dict], target_version: int
) -> Optional[str]:
    """Reconstruct content for a specific version from history.

    Args:
        current_content: The current (latest) version content.
        history: List of version history entries, each with 'version' and 'diff'.
        target_version: The version number to reconstruct.

    Returns:
        The content at the target version, or None if failed.

    Example:
        history = [
            {"version": 1, "diff": None},  # Initial version (no diff)
            {"version": 2, "diff": "..."},  # v1 -> v2 diff
            {"version": 3, "diff": "..."},  # v2 -> v3 diff
        ]
        # To get v1: apply v3 diff reverse, then v2 diff reverse
    """
    if not history:
        return current_content

    # Sort history by version descending
    sorted_history = sorted(history, key=lambda x: x["version"], reverse=True)
    current_version = sorted_history[0]["version"]

    if target_version == current_version:
        return current_content

    if target_version > current_version:
        logger.warning(
            "[DIFF] Target version %d > current version %d",
            target_version,
            current_version,
        )
        return None

    # Apply diffs in reverse order to reconstruct older version
    content = current_content
    for entry in sorted_history:
        version = entry["version"]
        diff = entry.get("diff")

        if version <= target_version:
            break

        if diff:
            content = apply_diff(content, diff, reverse=True)
            if content is None:
                logger.error("[DIFF] Failed to reverse diff for version %d", version)
                return None

    return content
