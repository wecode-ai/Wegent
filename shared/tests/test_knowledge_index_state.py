# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Index state decisions are reusable without persistence or wall-clock reads."""

import pytest


def test_enqueue_rejects_an_active_attempt_until_it_expires():
    from shared.knowledge_module import IndexStateSnapshot, decide_index_transition

    snapshot = IndexStateSnapshot(status="indexing", generation=4)
    assert not decide_index_transition(snapshot, event="enqueue", stale=False).accepted
    recovered = decide_index_transition(snapshot, event="enqueue", stale=True)
    assert (
        recovered.accepted,
        recovered.generation,
        recovered.next_status,
        recovered.reason,
    ) == (True, 5, "queued", "scheduled_after_stale_recovery")


@pytest.mark.parametrize("event", ["start", "success", "failure"])
def test_old_generation_cannot_change_current_state(event):
    from shared.knowledge_module import IndexStateSnapshot, decide_index_transition

    decision = decide_index_transition(
        IndexStateSnapshot(status="indexing", generation=5), event=event, generation=4
    )
    assert not decision.accepted


def test_deleted_document_cannot_be_revived():
    from shared.knowledge_module import decide_index_transition

    assert not decide_index_transition(None, event="success", generation=3).accepted


def test_current_generation_start_and_finish():
    from shared.knowledge_module import IndexStateSnapshot, decide_index_transition

    start = decide_index_transition(
        IndexStateSnapshot(status="queued", generation=3), event="start", generation=3
    )
    assert (start.accepted, start.next_status) == (True, "indexing")
    success = decide_index_transition(
        IndexStateSnapshot(status=start.next_status, generation=3),
        event="success",
        generation=3,
    )
    assert (success.accepted, success.next_status) == (True, "success")
    assert not decide_index_transition(
        IndexStateSnapshot(status="success", generation=3),
        event="failure",
        generation=3,
    ).accepted
