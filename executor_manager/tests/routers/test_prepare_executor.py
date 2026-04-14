# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import routers
from shared.models.execution import ExecutionRequest


@pytest.mark.asyncio
async def test_prepare_executor_logs_failed_prepare_detail(mocker):
    request = ExecutionRequest(task_id=1385, subtask_id=2464808)
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    error_logger = mocker.patch.object(routers.logger, "error")

    mocker.patch.object(
        routers.task_processor,
        "process_tasks",
        return_value={
            1385: {
                "status": "failed",
                "executor_name": "wegent-task-yinlu-1270a052eb5c3d1",
                "error_msg": "Kubernetes API error: webhook refused",
            }
        },
    )

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.prepare_executor(request, http_request)

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Kubernetes API error: webhook refused"
    error_logger.assert_called_once()
    assert "task_id=%s" in error_logger.call_args.args[0]
    assert error_logger.call_args.args[1:] == (
        1385,
        2464808,
        "wegent-task-yinlu-1270a052eb5c3d1",
        "Kubernetes API error: webhook refused",
    )
