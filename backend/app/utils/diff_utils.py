# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Diff utilities for artifact version management.

This module provides functions to create and apply unified diffs,
enabling efficient storage of artifact version history.

Instead of storing complete content for each version, we store:
- Current content (full)
- History as diffs (compact)

This approach typically reduces storage by 50-80% for text content,
depending on the nature of changes. For large rewrites, diff storage
may be less efficient than full content storage.

Configuration:
- MAX_DIFF_RATIO: If diff size exceeds this ratio of content size,
  consider storing full content instead (not implemented yet).
"""

import difflib
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Configuration constants
MAX_CONTENT_SIZE = 1024 * 1024  # 1MB max content size
MAX_VERSION_HISTORY = 100  # Maximum number of versions to keep


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

    This function correctly handles unified diff hunks by:
    1. Tracking the correct line positions for each hunk
    2. Properly handling context lines (unchanged lines)
    3. Maintaining correct offset as hunks modify line counts

    Args:
        lines: Original content lines.
        hunks: Parsed hunks from diff.
        reverse: If True, apply the diff in reverse (new -> old).

    Returns:
        Modified lines after applying all hunks.
    """
    result = lines.copy()
    offset = 0  # Track cumulative line offset as hunks modify line counts

    for hunk in hunks:
        # Determine start position based on direction
        if reverse:
            # When reversing: we have "new" content, want to get "old" content
            # So we use new_start as our reference
            start_line = hunk["new_start"] - 1 + offset
        else:
            # Normal: we have "old" content, want to get "new" content
            # So we use old_start as our reference
            start_line = hunk["old_start"] - 1 + offset

        # Count lines to remove from current content
        # In normal mode: remove '-' lines and context ' ' lines from old
        # In reverse mode: remove '+' lines and context ' ' lines from new
        lines_to_remove = 0
        new_section = []

        for change_type, content in hunk["changes"]:
            if reverse:
                # Reverse: '+' becomes removal, '-' becomes addition
                if change_type == "+":
                    # This was added in the diff, so it exists in current (new) content
                    # We need to remove it to get back to old
                    lines_to_remove += 1
                elif change_type == "-":
                    # This was removed in the diff, so it doesn't exist in current
                    # We need to add it back to get to old
                    new_section.append(content)
                else:  # context line ' '
                    # Context lines exist in both, count as removal and add back
                    lines_to_remove += 1
                    new_section.append(content)
            else:
                # Normal: '-' is removal, '+' is addition
                if change_type == "-":
                    # Remove this line from old content
                    lines_to_remove += 1
                elif change_type == "+":
                    # Add this line to new content
                    new_section.append(content)
                else:  # context line ' '
                    # Context lines exist in both, count as removal and add back
                    lines_to_remove += 1
                    new_section.append(content)

        # Calculate end position
        end_line = start_line + lines_to_remove

        # Validate bounds
        if start_line < 0:
            logger.warning(
                "[DIFF] Invalid start_line %d, adjusting to 0", start_line
            )
            start_line = 0
        if end_line > len(result):
            logger.warning(
                "[DIFF] end_line %d exceeds result length %d, adjusting",
                end_line, len(result)
            )
            end_line = len(result)

        # Replace section
        result = result[:start_line] + new_section + result[end_line:]

        # Update offset for next hunk
        # offset = (lines added) - (lines removed)
        lines_added = len(new_section)
        offset += lines_added - lines_to_remove

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

    if target_version < 1:
        logger.warning("[DIFF] Invalid target version: %d", target_version)
        return None

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
            result = apply_diff(content, diff, reverse=True)
            if result is None:
                logger.error("[DIFF] Failed to reverse diff for version %d", version)
                return None
            content = result

    return content


def validate_content_size(content: str) -> bool:
    """Validate that content size is within limits.

    Args:
        content: The content to validate.

    Returns:
        True if content is within size limits, False otherwise.
    """
    return len(content.encode('utf-8')) <= MAX_CONTENT_SIZE


def should_trim_history(history: list[dict]) -> bool:
    """Check if version history should be trimmed.

    Args:
        history: List of version history entries.

    Returns:
        True if history exceeds MAX_VERSION_HISTORY, False otherwise.
    """
    return len(history) > MAX_VERSION_HISTORY


def trim_history(history: list[dict]) -> list[dict]:
    """Trim version history to keep only recent versions.

    Keeps the most recent MAX_VERSION_HISTORY versions.
    Note: This means older versions will no longer be recoverable.

    Args:
        history: List of version history entries.

    Returns:
        Trimmed history list.
    """
    if len(history) <= MAX_VERSION_HISTORY:
        return history

    # Keep most recent versions
    sorted_history = sorted(history, key=lambda x: x["version"], reverse=True)
    trimmed = sorted_history[:MAX_VERSION_HISTORY]

    # Sort back to ascending order
    return sorted(trimmed, key=lambda x: x["version"])


def get_diff_stats(diff: str) -> dict:
    """Get statistics about a diff.

    Args:
        diff: The unified diff string.

    Returns:
        Dictionary with 'additions', 'deletions', 'size_bytes' keys.
    """
    if not diff:
        return {"additions": 0, "deletions": 0, "size_bytes": 0}

    additions = 0
    deletions = 0

    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            additions += 1
        elif line.startswith("-") and not line.startswith("---"):
            deletions += 1

    return {
        "additions": additions,
        "deletions": deletions,
        "size_bytes": len(diff.encode('utf-8')),
    }
