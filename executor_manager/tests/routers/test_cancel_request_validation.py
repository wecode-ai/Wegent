# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for Schemathesis fuzz discovered issues.

Issue: cancel request ID fields using regular int caused Pydantic to loosely
convert JSON boolean to int, allowing invalid requests into business logic
instead of returning 422.

Reproduction (executor_manager 8001):
```bash
# /executor-manager/tasks/cancel
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{"task_id": false}' \
  http://localhost:8001/executor-manager/tasks/cancel

# /executor-manager/v1/cancel
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{"task_id": 0, "subtask_id": false}' \
  http://localhost:8001/executor-manager/v1/cancel
```
Current behavior: boolean values enter business logic (false→0)
Expected behavior: returns 422
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

_app = None


@pytest.fixture
def client():
    """Create test client."""
    global _app
    if _app is None:
        with patch(
            "executor_manager.executors.docker.executor.subprocess.run",
            return_value=MagicMock(stdout="Docker version 27.0.0", returncode=0),
        ):
            from executor_manager.routers.routers import app

            _app = app
    return TestClient(_app)


class TestCancelTaskRequestStrictIntValidation:
    """Regression tests for /executor-manager/tasks/cancel strict int validation.

    Schemathesis fuzz discovered that boolean task_id was being coerced to
    integers (false→0, true→1), bypassing proper validation.
    """

    def test_task_id_boolean_false_returns_422_regression(self, client):
        """REGRESSION: task_id=false should return 422.

        Directly reproduces the Schemathesis fuzz finding where
        JSON boolean 'false' was coerced to integer 0, causing
        the request to reach business logic instead of being
        rejected at schema validation.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": False},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_boolean_true_returns_422(self, client):
        """REGRESSION: task_id=true should return 422.

        Ensures that boolean 'true' is also rejected (would be coerced to 1).
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": True},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_string_returns_422(self, client):
        """REGRESSION: task_id="1" should return 422.

        Ensures string representations of numbers are also rejected.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": "1"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_float_returns_422(self, client):
        """REGRESSION: task_id=1.0 should return 422.

        Ensures float values are rejected even if they represent integers.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": 1.0},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_integer_zero_passes_validation(self, client):
        """Verify that task_id=0 passes schema validation.

        Integer 0 should NOT be rejected with 422 by strict int validation.
        It may return other status codes from business logic, but
        the schema layer must accept it.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": 0},
            headers={"Content-Type": "application/json"},
        )

        # Critical: must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_task_id_positive_integer_passes_validation(self, client):
        """Verify that task_id=1 passes schema validation.

        Positive integers should NOT be rejected with 422.
        They may return other status codes from business logic.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": 1},
            headers={"Content-Type": "application/json"},
        )

        # Critical: must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_task_id_large_integer_passes_validation(self, client):
        """Verify that task_id=999999 passes schema validation.

        Large integers should also pass schema validation.
        """
        response = client.post(
            "/executor-manager/tasks/cancel",
            json={"task_id": 999999},
            headers={"Content-Type": "application/json"},
        )

        # Critical: must NOT be 422 (schema validation error)
        assert response.status_code != 422


class TestCancelRequestV1StrictIntValidation:
    """Regression tests for /executor-manager/v1/cancel strict int validation.

    Schemathesis fuzz discovered that boolean task_id/subtask_id were being
    coerced to integers (false→0, true→1), bypassing proper validation.
    """

    def test_task_id_boolean_false_returns_422_regression(self, client):
        """REGRESSION: task_id=false should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": False},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_boolean_true_returns_422(self, client):
        """REGRESSION: task_id=true should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": True},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_boolean_false_returns_422_regression(self, client):
        """REGRESSION: subtask_id=false should return 422.

        Directly reproduces the Schemathesis fuzz finding where
        JSON boolean 'false' in subtask_id was coerced to integer 0,
        causing the request to reach business logic instead of being
        rejected at schema validation.
        """
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": False},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_boolean_true_returns_422(self, client):
        """REGRESSION: subtask_id=true should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": True},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_string_returns_422(self, client):
        """REGRESSION: task_id="1" should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": "1"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_string_returns_422(self, client):
        """REGRESSION: subtask_id="1" should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": "1"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_task_id_float_returns_422(self, client):
        """REGRESSION: task_id=1.0 should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 1.0},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_float_returns_422(self, client):
        """REGRESSION: subtask_id=1.0 should return 422."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": 1.0},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_null_passes_validation(self, client):
        """Verify that subtask_id=null passes schema validation.

        Confirms subtask_id retains Optional semantics — null should be
        accepted without 422, only non-integer types should be rejected.
        """
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": None},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_task_id_integer_zero_passes_validation(self, client):
        """Verify that task_id=0 passes schema validation."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_task_id_positive_integer_passes_validation(self, client):
        """Verify that task_id=1 passes schema validation."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 1},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_subtask_id_positive_integer_passes_validation(self, client):
        """Verify that subtask_id=1 passes schema validation."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": 1},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_task_id_large_integer_passes_validation(self, client):
        """Verify that task_id=999999 passes schema validation."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 999999},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_subtask_id_large_integer_passes_validation(self, client):
        """Verify that subtask_id=999999 passes schema validation."""
        response = client.post(
            "/executor-manager/v1/cancel",
            json={"task_id": 0, "subtask_id": 999999},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422
