# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Integration coverage for terminal task queue failure reporting.

These tests use the real Redis-backed queue and the real task processor. The
executor dispatcher is replaced with a deterministic in-process executor
because this environment cannot start a Kubernetes cluster. The production
TaskProcessor, TaskQueueConsumer, TaskQueueService, Redis state, and HTTP
callback client are all exercised together.

The dispatcher configuration test intentionally leaves the process without a
Docker fallback so the real dispatcher raises a stable `executor_config`
failure instead of using an injected executor instance.
"""

import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import pytest

from executor_manager.clients import callback_client as callback_client_module
from executor_manager.common.config import reset_config
from executor_manager.common.errors import ExecutorErrorCode
from executor_manager.common.redis_factory import RedisClientFactory
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.services.task_queue_consumer import TaskQueueConsumer
from executor_manager.services.task_queue_service import (
    PENDING_INDEX_KEY,
    PENDING_KEY_TEMPLATE,
    TaskQueueService,
)
from shared.models.responses_api import ResponsesAPIStreamEvents


class _CallbackServer(ThreadingHTTPServer):
    """Local HTTP server that captures backend callback requests."""

    daemon_threads = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.requests: list[dict[str, Any]] = []
        self.request_received = threading.Event()


@pytest.fixture
def real_queue(monkeypatch: pytest.MonkeyPatch) -> Iterator[TaskQueueService]:
    """Provide a real Redis queue and reset the process-wide executor cache."""
    redis_url = os.getenv("E2E_REDIS_URL")
    if not redis_url:
        pytest.fail("E2E_REDIS_URL must point to a dedicated real Redis database")
    monkeypatch.setenv("REDIS_URL", redis_url)
    reset_config()
    RedisClientFactory.reset()
    original_executors = ExecutorDispatcher._executors
    service = TaskQueueService("e2e-terminal", "online")
    try:
        yield service
    finally:
        client = service.redis_client
        if client is not None:
            client.delete(service.queue_key)
            task_id = 101
            client.delete(PENDING_KEY_TEMPLATE.format(task_id=task_id))
            client.zrem(PENDING_INDEX_KEY, str(task_id))
            client.delete(PENDING_INDEX_KEY)
        RedisClientFactory.reset()
        reset_config()
        ExecutorDispatcher._executors = original_executors


@pytest.fixture
def callback_server(monkeypatch: pytest.MonkeyPatch) -> Iterator[_CallbackServer]:
    """Run a local backend callback endpoint and point the real client at it."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            assert isinstance(self.server, _CallbackServer)
            self.server.requests.append(payload)
            self.server.request_received.set()

            response = b'{"status": "ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = _CallbackServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    monkeypatch.setenv(
        "TASK_API_DOMAIN", f"http://127.0.0.1:{server.server_address[1]}"
    )
    monkeypatch.setattr(callback_client_module, "_callback_client", None)
    try:
        yield server
    finally:
        server.shutdown()
        server_thread.join(timeout=5)
        server.server_close()


@pytest.mark.integration
def test_dispatcher_config_failure_reports_stable_error_code(
    real_queue: TaskQueueService,
    callback_server: _CallbackServer,
) -> None:
    """A real dispatcher configuration error reports its original code."""
    consumer = TaskQueueConsumer(
        service_pool=real_queue.service_pool,
        queue_type=real_queue.queue_type,
    )
    ExecutorDispatcher._executors = {"custom": object()}

    task = {"metadata": {"task_id": 101, "subtask_id": 102, "executor_type": "docker"}}
    assert real_queue.enqueue_task(task)
    consumer._process_task_with_retry(real_queue.dequeue_task(timeout=1))

    assert callback_server.request_received.wait(timeout=5)
    assert callback_server.requests == [
        {
            "event_type": ResponsesAPIStreamEvents.ERROR.value,
            "task_id": 101,
            "subtask_id": 102,
            "data": {
                "code": ExecutorErrorCode.EXECUTOR_CONFIG,
                "message": "Default 'docker' executor not found",
            },
        }
    ]
    redis_client = real_queue.redis_client
    assert redis_client.llen(real_queue.queue_key) == 0
    assert redis_client.exists(PENDING_KEY_TEMPLATE.format(task_id=101)) == 0
    assert redis_client.zscore(PENDING_INDEX_KEY, "101") is None


@pytest.mark.integration
def test_non_retryable_failure_reports_and_clears_redis_state(
    real_queue: TaskQueueService,
    callback_server: _CallbackServer,
) -> None:
    """Terminal submissions report their original code and never requeue."""

    class TerminalExecutor:
        error: ClassVar[dict[str, str]] = {
            "status": "failed",
            "error_msg": "quota reached",
            "error_code": ExecutorErrorCode.USER_TASK_LIMIT,
        }

        def submit_executor(self, task, callback=None):
            return self.error

    consumer = TaskQueueConsumer(
        service_pool=real_queue.service_pool,
        queue_type=real_queue.queue_type,
    )
    ExecutorDispatcher._executors = {"docker": TerminalExecutor()}

    task = {"metadata": {"task_id": 101, "subtask_id": 102, "executor_type": "docker"}}
    assert real_queue.enqueue_task(task)
    consumer._process_task_with_retry(real_queue.dequeue_task(timeout=1))

    assert callback_server.request_received.wait(timeout=5)
    assert callback_server.requests == [
        {
            "event_type": ResponsesAPIStreamEvents.ERROR.value,
            "task_id": 101,
            "subtask_id": 102,
            "data": {
                "code": ExecutorErrorCode.USER_TASK_LIMIT,
                "message": "quota reached",
            },
        }
    ]
    redis_client = real_queue.redis_client
    assert redis_client.llen(real_queue.queue_key) == 0
    assert redis_client.exists(PENDING_KEY_TEMPLATE.format(task_id=101)) == 0
    assert redis_client.zscore(PENDING_INDEX_KEY, "101") is None


@pytest.mark.integration
def test_retryable_failure_requeues_through_real_redis(
    real_queue: TaskQueueService,
) -> None:
    """Failures without a terminal code retain the historical retry path."""

    class RetryableExecutor:
        error: ClassVar[dict[str, str]] = {
            "status": "failed",
            "error_msg": "connection reset",
            "error_code": "",
        }

        def submit_executor(self, task, callback=None):
            return self.error

    consumer = TaskQueueConsumer(
        service_pool=real_queue.service_pool,
        queue_type=real_queue.queue_type,
    )
    ExecutorDispatcher._executors = {"docker": RetryableExecutor()}

    task = {"metadata": {"task_id": 101, "subtask_id": 102, "executor_type": "docker"}}
    assert real_queue.enqueue_task(task)
    consumer._process_task_with_retry(real_queue.dequeue_task(timeout=1))

    redis_client = real_queue.redis_client
    assert redis_client.llen(real_queue.queue_key) == 1
    assert real_queue.peek_tasks(1) == [
        {
            **task,
            "_retry_count": 1,
        }
    ]
    assert redis_client.exists(PENDING_KEY_TEMPLATE.format(task_id=101)) == 1
    assert redis_client.zscore(PENDING_INDEX_KEY, "101") is not None
