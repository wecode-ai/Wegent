# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Turn-scoped execution context for authoritative-state persistence.

Holds state that must stay invariant across (recursive) truncation retries —
above all the root turn's ``original_input_ids``, so ``_new_messages_from_state``
keeps compaction clones / summary / suffix (fresh ids) and excludes only the
unchanged input history, identically on every exit path.

Thread ownership is *per recursion level*: each ``stream_tokens`` invocation owns
exactly its ``current_thread_id`` and deletes it in its own ``finally``. A
truncation retry derives a child context (``with_retry``) carrying a new thread;
the child tears down its own thread, the parent tears down its own — no shared
registry, no child deleting a parent's state.
"""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class TurnExecutionContext:
    """Immutable per-level execution context for a single turn."""

    original_input_ids: frozenset[str]
    current_thread_id: str
    truncation_retry_count: int = 0

    def with_retry(self, new_thread_id: str) -> "TurnExecutionContext":
        """Derive a child context for a truncation retry.

        Inherits ``original_input_ids`` unchanged, takes over the new thread as
        its own ``current_thread_id``, and increments the retry count.
        """
        return replace(
            self,
            current_thread_id=new_thread_id,
            truncation_retry_count=self.truncation_retry_count + 1,
        )
