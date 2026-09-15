# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable Redis scopes for conversation-owned IM selections."""

import hashlib
import json

CHAT_PROFILE = "chat"
TASK_PROFILE = "task"


def build_conversation_selection_scope(
    *,
    channel_type: str,
    channel_id: int,
    conversation_id: str,
    actor_id: str,
    user_id: int,
) -> str:
    """Isolate selections by channel, conversation, external actor, and user."""

    identity = json.dumps(
        [str(conversation_id), str(actor_id)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    return f"{channel_type}:{channel_id}:{user_id}:{digest}"


def profile_selection_scope(scope: str | None, profile: str) -> str | None:
    """Add a Chat or Task profile without changing legacy unscoped callers."""

    return f"{scope}:{profile}" if scope else None
