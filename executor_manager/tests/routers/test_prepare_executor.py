# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for /executors/prepare skip_git_clone strict bool validation.

Issue: skip_git_clone using regular bool allowed JSON integer 0 to be coerced
to False, allowing the request to enter Docker executor creation and produce
real side effects instead of returning 422.

Reproduction (executor_manager 8001):
```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{"skip_git_clone": 0}' \
  http://localhost:8001/executor-manager/executors/prepare

# Current: 200 OK, creates container
# Expected: 422 Unprocessable Entity
```
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

_app = None


@pytest.fixture
def client():
    global _app
    if _app is None:
        with patch(
            "executor_manager.executors.docker.executor.subprocess.run",
            return_value=MagicMock(stdout="Docker version 27.0.0", returncode=0),
        ):
            from executor_manager.routers.routers import app

            _app = app
    return TestClient(_app)


class TestPrepareSkipGitCloneStrictBool:
    def test_skip_git_clone_int_zero_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": 0},
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_skip_git_clone_int_one_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": 1},
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_skip_git_clone_string_false_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": "false"},
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_skip_git_clone_string_true_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": "true"},
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_skip_git_clone_bool_false_passes_validation(self, client):
        with patch.object(
            __import__(
                "executor_manager.routers.routers", fromlist=["task_processor"]
            ).task_processor,
            "process_tasks",
            return_value={
                1: {
                    "status": "success",
                    "executor_name": "test",
                    "executor_namespace": "default",
                }
            },
        ):
            response = client.post(
                "/executor-manager/executors/prepare",
                json={"task_id": 1, "skip_git_clone": False},
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code != 422

    def test_skip_git_clone_bool_true_passes_validation(self, client):
        with patch.object(
            __import__(
                "executor_manager.routers.routers", fromlist=["task_processor"]
            ).task_processor,
            "process_tasks",
            return_value={
                1: {
                    "status": "success",
                    "executor_name": "test",
                    "executor_namespace": "default",
                }
            },
        ):
            response = client.post(
                "/executor-manager/executors/prepare",
                json={"task_id": 1, "skip_git_clone": True},
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code != 422

    def test_skip_git_clone_omitted_passes_validation(self, client):
        with patch.object(
            __import__(
                "executor_manager.routers.routers", fromlist=["task_processor"]
            ).task_processor,
            "process_tasks",
            return_value={
                1: {
                    "status": "success",
                    "executor_name": "test",
                    "executor_namespace": "default",
                }
            },
        ):
            response = client.post(
                "/executor-manager/executors/prepare",
                json={"task_id": 1},
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code != 422

    def test_prepare_executor_logs_failed_prepare_detail(self, client):
        with patch.object(
            __import__(
                "executor_manager.routers.routers", fromlist=["task_processor"]
            ).task_processor,
            "process_tasks",
            return_value={
                1385: {
                    "status": "failed",
                    "executor_name": "wegent-task-yinlu-1270a052eb5c3d1",
                    "error_msg": "Kubernetes API error: webhook refused",
                }
            },
        ):
            response = client.post(
                "/executor-manager/executors/prepare",
                json={"task_id": 1385, "subtask_id": 2464808},
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 500
            assert response.json()["detail"] == "Kubernetes API error: webhook refused"
