# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from shared.telemetry.metrics.business import (
    record_message_sent,
    record_session_opened,
    record_task_completed,
    record_task_created,
    record_task_failed,
)


@patch("shared.telemetry.metrics.business.is_telemetry_enabled", return_value=True)
@patch("shared.telemetry.metrics.business.get_wegent_metrics")
def test_identifiers_are_not_metric_attributes(mock_get_metrics, _mock_enabled):
    metrics = MagicMock()
    mock_get_metrics.return_value = metrics

    record_session_opened(user_id="user-1", team_id="team-1")
    record_message_sent(
        user_id="user-1",
        team_id="team-1",
        bot_id="bot-1",
        message_type="text",
    )
    record_task_created(user_id="user-1", team_id="team-1")
    record_task_completed(
        user_id="user-1",
        team_id="team-1",
        agent_type="ClaudeCode",
        duration_ms=25,
    )
    record_task_failed(
        user_id="user-1",
        team_id="team-1",
        agent_type="ClaudeCode",
    )

    metrics.session_opened.add.assert_called_once_with(1)
    metrics.message_sent.add.assert_called_once_with(1)
    metrics.message_by_type.add.assert_called_once_with(1, {"message_type": "text"})
    metrics.task_created.add.assert_called_once_with(1)
    metrics.task_completed.add.assert_called_once_with(1, {"agent_type": "ClaudeCode"})
    metrics.task_duration.record.assert_called_once_with(
        25, {"agent_type": "ClaudeCode"}
    )
    metrics.task_failed.add.assert_called_once_with(1, {"agent_type": "ClaudeCode"})
