# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared utility functions for message processing."""

from typing import Any


def group_tool_call_messages(
    messages: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Group messages into atomic units for safe truncation/removal.

    A tool-call group consists of an assistant message with ``tool_calls``
    followed by its corresponding ``tool`` response messages.  Splitting
    such a group would produce orphaned ``function_call_output`` items
    (without matching ``function_call``) when converted to the OpenAI
    Responses API format, causing API errors.

    Args:
        messages: Flat list of message dicts.

    Returns:
        A list of groups where each group is a list of message dicts
        that must be kept or removed together.
    """
    groups: list[list[dict[str, Any]]] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            group = [msg]
            i += 1
            while i < len(messages) and messages[i].get("role") == "tool":
                group.append(messages[i])
                i += 1
            groups.append(group)
        else:
            groups.append([msg])
            i += 1
    return groups
