# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.execution.agents.video.recovery import _do_recover_video_jobs


@pytest.mark.asyncio
async def test_recovery_requeues_external_workflow_with_existing_video_poller() -> None:
    subtask = SimpleNamespace(
        id=2,
        task_id=1,
        message_id=3,
        result={
            "video_job": {
                "job_id": "workflow-1",
                "workflow_type": "example_workflow",
                "query_url": "https://workflow.example.com/task/1",
                "status": "polling",
                "video_block_id": "card-1",
                "poll_count": 4,
                "progress": 42,
                "last_poll_at": "2020-01-01T00:00:00+00:00",
            }
        },
    )
    db = MagicMock()

    with (
        patch("app.db.session.SessionLocal", return_value=db),
        patch(
            "app.services.execution.agents.video.recovery."
            "subtask_store.list_running_since",
            return_value=[subtask],
        ),
        patch(
            "app.services.execution.agents.video.recovery._get_user_id_for_task",
            return_value=9,
        ),
        patch(
            "app.services.execution.agents.video.recovery."
            "_get_model_config_for_subtask",
            return_value={},
        ),
        patch("app.tasks.video_tasks.dispatch_video_polling_task") as dispatch,
    ):
        recovered = await _do_recover_video_jobs()

    assert recovered == 1
    assert dispatch.call_args.kwargs["workflow_type"] == "example_workflow"
    assert dispatch.call_args.kwargs["workflow_context"] == {
        "query_url": "https://workflow.example.com/task/1"
    }
    assert dispatch.call_args.kwargs["poll_count"] == 4
