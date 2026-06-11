# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for /executor-manager/v1/responses request validation.

Issue: empty body and empty JSON {} were not rejected at the schema layer.
- Empty body returned 500 (JSONDecodeError caught by bare except).
- Empty JSON {} returned 200 and entered business logic (enqueued to Redis).

Expected: both must return 422 (Pydantic validation error) before any
business logic executes.

Reproduction (executor_manager 8001):
```bash
# Empty body -> was 500
curl -i -X POST http://localhost:8001/executor-manager/v1/responses

# Empty JSON -> was 200
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://localhost:8001/executor-manager/v1/responses
```
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

ENQUEUE_PATCH_TARGET = (
    "executor_manager.services.task_queue_service.TaskQueueService.enqueue_task"
)


@pytest.fixture
def client():
    """Create test client."""
    from executor_manager.routers.routers import app

    return TestClient(app, raise_server_exceptions=False)


class TestOpenAIResponsesEmptyBodyValidation:
    """Regression: empty body must return 422, not 500."""

    def test_no_body_returns_422(self, client):
        """REGRESSION: POST with no body must return 422."""
        response = client.post(
            "/executor-manager/v1/responses",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422

    def test_empty_body_returns_422(self, client):
        """REGRESSION: POST with empty body must return 422."""
        response = client.post(
            "/executor-manager/v1/responses",
            content=b"",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422

    def test_invalid_json_returns_422(self, client):
        """REGRESSION: POST with non-JSON body must return 422."""
        response = client.post(
            "/executor-manager/v1/responses",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422


class TestOpenAIResponsesEmptyObjectValidation:
    """Regression: empty JSON {} must return 422, not 200."""

    def test_empty_object_returns_422(self, client):
        """REGRESSION: {} must be rejected - model and input are required."""
        response = client.post(
            "/executor-manager/v1/responses",
            json={},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422

    def test_empty_object_does_not_enqueue(self, client):
        """REGRESSION: {} must not trigger task enqueue."""
        with patch(ENQUEUE_PATCH_TARGET) as mock_enqueue:
            client.post(
                "/executor-manager/v1/responses",
                json={},
                headers={"Content-Type": "application/json"},
            )

            mock_enqueue.assert_not_called()

    def test_missing_model_returns_422(self, client):
        """input present but model missing must return 422."""
        response = client.post(
            "/executor-manager/v1/responses",
            json={"input": "hello"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422

    def test_missing_input_returns_422(self, client):
        """model present but input missing must return 422."""
        response = client.post(
            "/executor-manager/v1/responses",
            json={"model": "gpt-4"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422


class TestOpenAIResponsesValidRequest:
    """Valid requests must still return 200 and enqueue."""

    def test_minimal_valid_request_returns_200(self, client):
        """model + input are the only required fields."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True):
            response = client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "gpt-4",
                    "input": "hello",
                },
                headers={"Content-Type": "application/json"},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "queued"

    def test_full_valid_request_returns_200(self, client):
        """All fields provided - standard internal caller format."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True):
            response = client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "claude-sonnet-4-20250514",
                    "input": "Execute the task",
                    "instructions": "You are a helpful assistant",
                    "stream": False,
                    "background": True,
                    "metadata": {
                        "task_id": 123,
                        "subtask_id": 456,
                        "type": "online",
                    },
                    "model_config": {"temperature": 0.7},
                },
                headers={"Content-Type": "application/json"},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "queued"
            assert data["id"] == "resp_456"

    def test_valid_request_enqueues(self, client):
        """Valid request must call enqueue_task."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True) as mock_enqueue:
            response = client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "gpt-4",
                    "input": [{"role": "user", "content": "hello"}],
                },
                headers={"Content-Type": "application/json"},
            )

            assert response.status_code == 200
            mock_enqueue.assert_called_once()

    def test_model_config_alias_aligns_with_downstream(self, client):
        """Input JSON 'model_config' must populate model_config_data via alias."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True) as mock_enqueue:
            response = client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "gpt-4",
                    "input": "hello",
                    "model_config": {"temperature": 0.5},
                },
                headers={"Content-Type": "application/json"},
            )

            assert response.status_code == 200
            mock_enqueue.assert_called_once()
            task_payload = mock_enqueue.call_args[0][0]
            assert "model_config" in task_payload
            assert task_payload["model_config"] == {"temperature": 0.5}

    def test_downstream_payload_uses_model_config_key_not_field_name(self, client):
        """Enqueue payload must use downstream key 'model_config', not field name."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True) as mock_enqueue:
            client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "gpt-4",
                    "input": "hello",
                    "model_config": {"top_p": 0.9},
                },
                headers={"Content-Type": "application/json"},
            )

            task_payload = mock_enqueue.call_args[0][0]
            assert "model_config_data" not in task_payload
            assert task_payload["model_config"] == {"top_p": 0.9}

    def test_no_model_config_omits_key_in_payload(self, client):
        """When model_config is absent, payload must not contain model_config key."""
        with patch(ENQUEUE_PATCH_TARGET, return_value=True) as mock_enqueue:
            client.post(
                "/executor-manager/v1/responses",
                json={
                    "model": "gpt-4",
                    "input": "hello",
                },
                headers={"Content-Type": "application/json"},
            )

            task_payload = mock_enqueue.call_args[0][0]
            assert "model_config_data" not in task_payload
            assert "model_config" not in task_payload
