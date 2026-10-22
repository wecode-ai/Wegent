# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable notification identities must distinguish new turns from replays."""

import pytest

from app.services.im.runtime_notification_delivery import runtime_notification_id


@pytest.mark.parametrize(
    "payload",
    [
        {"data": {"turnId": "turn-1"}, "subtaskId": "execution-1"},
        {"data": {"turn_id": "turn-1"}},
        {"turnId": "turn-1"},
        {"turn_id": "turn-1"},
        {"subtaskId": "turn-1"},
        {"subtask_id": "turn-1"},
        {"data": {"response": {"id": "turn-1"}}},
    ],
)
def test_turn_identity_is_stable_across_event_formats(payload):
    assert runtime_notification_id(payload, "COMPLETED") == "turn:turn-1:completed"


def test_update_timestamp_is_used_for_legacy_watcher():
    assert (
        runtime_notification_id({"updatedAt": "2026-10-12T08:00:00Z"}, "done")
        == "updated:2026-10-12T08:00:00Z:completed"
    )


def test_content_and_event_sequence_are_not_delivery_identities():
    assert (
        runtime_notification_id(
            {"eventSeq": 1, "data": {"value": "Task finished"}}, "COMPLETED"
        )
        is None
    )


def test_waiting_and_completed_states_can_notify_within_one_turn():
    payload = {"subtaskId": "turn-1"}
    assert runtime_notification_id(
        payload, "waiting_user_input"
    ) != runtime_notification_id(payload, "COMPLETED")
