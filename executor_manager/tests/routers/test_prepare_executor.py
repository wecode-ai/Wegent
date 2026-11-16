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

from unittest.mock import MagicMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

_app = None


@pytest.fixture(autouse=True)
def internal_service_token(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "service-token")


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
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer service-token",
            },
        )
        assert response.status_code == 422

    def test_skip_git_clone_int_one_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": 1},
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer service-token",
            },
        )
        assert response.status_code == 422

    def test_skip_git_clone_string_false_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": "false"},
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer service-token",
            },
        )
        assert response.status_code == 422

    def test_skip_git_clone_string_true_returns_422(self, client):
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 1, "skip_git_clone": "true"},
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer service-token",
            },
        )
        assert response.status_code == 422

    def _post_prepare(self, client, payload):
        repository = Mock(
            load_executor_callback_token=Mock(return_value=None),
            save_executor_binding=Mock(return_value=True),
        )
        with (
            patch(
                "executor_manager.services.sandbox.repository.get_sandbox_repository",
                return_value=repository,
            ),
            patch(
                "executor_manager.routers.routers.task_processor.process_tasks",
                return_value={
                    1: {
                        "status": "success",
                        "executor_name": "test",
                        "executor_namespace": "default",
                    }
                },
            ),
        ):
            return client.post(
                "/executor-manager/executors/prepare",
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer service-token",
                },
            )

    def test_skip_git_clone_bool_false_passes_validation(self, client):
        response = self._post_prepare(client, {"task_id": 1, "skip_git_clone": False})
        assert response.status_code == 200

    def test_skip_git_clone_bool_true_passes_validation(self, client):
        response = self._post_prepare(client, {"task_id": 1, "skip_git_clone": True})
        assert response.status_code == 200

    def test_skip_git_clone_omitted_passes_validation(self, client):
        response = self._post_prepare(client, {"task_id": 1})
        assert response.status_code == 200

    def test_prepare_executor_logs_failed_prepare_detail(self, client, mocker):
        repository = Mock(
            load_executor_callback_token=Mock(return_value="callback-token"),
            save_executor_binding=Mock(),
        )
        mocker.patch(
            "executor_manager.services.sandbox.repository.get_sandbox_repository",
            return_value=repository,
        )
        with patch(
            "executor_manager.routers.routers.task_processor.process_tasks",
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
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer service-token",
                },
            )
            assert response.status_code == 500
            assert response.json()["detail"] == "Kubernetes API error: webhook refused"


def test_prepare_executor_issues_callback_credential(client, mocker):
    repository = mocker.Mock(
        load_executor_callback_token=Mock(return_value=None),
        save_executor_binding=Mock(return_value=True),
    )
    mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    )
    with patch(
        "executor_manager.routers.routers.task_processor.process_tasks",
        return_value={
            42: {
                "status": "success",
                "executor_name": "executor-42",
                "executor_namespace": "default",
            }
        },
    ) as process_tasks:
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 42, "subtask_id": 43, "executor_name": "executor-42"},
            headers={"Authorization": "Bearer service-token"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["executor_name"] == "executor-42"
    assert "callback_token" not in payload
    task = process_tasks.call_args.args[0][0]
    assert task["prepare_only"] is True
    assert task["metadata"]["executor_callback_token"]
    repository.save_executor_binding.assert_called_once_with(
        task_id=42,
        executor_name="executor-42",
        callback_token=task["metadata"]["executor_callback_token"],
    )


def test_prepare_executor_reuses_prepared_callback_credential(client, mocker):
    repository = mocker.Mock(
        load_executor_callback_token=Mock(return_value="existing-token"),
        save_executor_binding=Mock(),
    )
    mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    )
    with patch(
        "executor_manager.routers.routers.task_processor.process_tasks",
        return_value={
            42: {
                "status": "success",
                "executor_name": "executor-42",
                "executor_namespace": "default",
            }
        },
    ) as process_tasks:
        response = client.post(
            "/executor-manager/executors/prepare",
            json={"task_id": 42, "subtask_id": 43, "executor_name": "executor-42"},
            headers={"Authorization": "Bearer service-token"},
        )

    assert response.status_code == 200
    assert "callback_token" not in response.json()
    task = process_tasks.call_args.args[0][0]
    assert task["metadata"]["executor_callback_token"] == "existing-token"
    repository.save_executor_binding.assert_not_called()


def test_prepare_executor_rejects_missing_internal_service_token(
    client, mocker, monkeypatch
):
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    repository = mocker.Mock(
        load_executor_callback_token=Mock(return_value="callback-token"),
        save_executor_binding=Mock(),
    )
    mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    )

    response = client.post(
        "/executor-manager/executors/prepare",
        json={"task_id": 42, "subtask_id": 43},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Internal service token is not configured"}


def test_prepare_executor_rejects_wrong_internal_service_token(client, mocker):
    repository = mocker.Mock(
        load_executor_callback_token=Mock(return_value="callback-token"),
        save_executor_binding=Mock(),
    )
    mocker.patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    )

    response = client.post(
        "/executor-manager/executors/prepare",
        json={"task_id": 42, "subtask_id": 43},
        headers={"Authorization": "Bearer wrong-token"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication token"}
