# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task queue pending-dispatch tracking."""

import json
from unittest.mock import MagicMock

from executor_manager.services.task_queue_service import TaskQueueService


def _service(mocker) -> tuple[TaskQueueService, MagicMock]:
    redis_client = MagicMock()
    redis_client.llen.return_value = 0
    mocker.patch(
        "executor_manager.services.task_queue_service."
        "RedisClientFactory.get_sync_client",
        return_value=redis_client,
    )
    return TaskQueueService(service_pool="online", queue_type="online"), redis_client


def _task() -> dict:
    return {
        "model": "test",
        "metadata": {"task_id": 13869, "subtask_id": 13890, "type": "online"},
    }


def test_enqueue_task_records_pending(mocker):
    """Enqueuing writes a pending record used by the stall monitor."""
    service, redis_client = _service(mocker)

    assert service.enqueue_task(_task()) is True

    key = "wegent:task_queue:pending:13869"
    payload = json.loads(redis_client.setex.call_args.args[2])
    assert redis_client.setex.call_args.args[0] == key
    assert payload["task_id"] == "13869"
    assert payload["subtask_id"] == "13890"
    assert payload["queue_key"] == "wegent:task_queue:online:online"
    assert payload["dequeued_at"] is None


def test_dequeue_task_marks_pending_dequeued(mocker):
    """A consumer records when it picked the task up."""
    service, redis_client = _service(mocker)
    redis_client.brpop.return_value = (
        b"wegent:task_queue:online:online",
        json.dumps(_task()).encode(),
    )
    redis_client.get.return_value = json.dumps(
        {
            "task_id": "13869",
            "subtask_id": "13890",
            "queue_key": "wegent:task_queue:online:online",
            "enqueued_at": 1.0,
            "dequeued_at": None,
        }
    )

    assert service.dequeue_task(timeout=1)["model"] == "test"

    payload = json.loads(redis_client.setex.call_args.args[2])
    assert payload["dequeued_at"] is not None


def test_clear_pending_deletes_record(mocker):
    """Successful or terminal dispatches forget the pending record."""
    service, redis_client = _service(mocker)

    service.clear_pending(13869)

    redis_client.delete.assert_called_once_with("wegent:task_queue:pending:13869")
