# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for Schemathesis fuzz discovered issues.

Issue: cancel request ID fields using regular int caused Pydantic to loosely
convert JSON boolean to int, allowing invalid requests into business logic
instead of returning 422.

Reproduction (chat_shell 8100):
```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{"subtask_id": false}' \
  http://localhost:8100/v1/responses/cancel
```
Current behavior: returns 404
Expected behavior: returns 422
"""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create test client."""
    from chat_shell.main import app

    return TestClient(app)


class TestCancelRequestStrictIntValidation:
    """Regression tests for /v1/responses/cancel strict int validation.

    Schemathesis fuzz discovered that boolean values were being coerced to
    integers (false→0, true→1), bypassing proper validation.
    """

    def test_subtask_id_boolean_false_returns_422_regression(self, client):
        """REGRESSION: subtask_id=false should return 422, not 404.

        Directly reproduces the Schemathesis fuzz finding where
        JSON boolean 'false' was coerced to integer 0, causing
        the request to reach business logic instead of being
        rejected at schema validation.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": False},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_boolean_true_returns_422(self, client):
        """REGRESSION: subtask_id=true should return 422.

        Ensures that boolean 'true' is also rejected (would be coerced to 1).
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": True},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_string_returns_422(self, client):
        """REGRESSION: subtask_id="1" should return 422.

        Ensures string representations of numbers are also rejected.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": "1"},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_float_returns_422(self, client):
        """REGRESSION: subtask_id=1.0 should return 422.

        Ensures float values are rejected even if they represent integers.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": 1.0},
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422
        error_detail = response.json()
        assert "detail" in error_detail

    def test_subtask_id_integer_zero_passes_validation(self, client):
        """Verify that subtask_id=0 passes schema validation.

        Integer 0 should NOT be rejected with 422 by strict int validation.
        It may return 404 or other status codes from business logic, but
        the schema layer must accept it.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": 0},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_subtask_id_positive_integer_passes_validation(self, client):
        """Verify that subtask_id=1 passes schema validation.

        Positive integers should NOT be rejected with 422.
        They may return 404 or other status codes from business logic.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": 1},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422

    def test_subtask_id_large_integer_passes_validation(self, client):
        """Verify that subtask_id=999999 passes schema validation.

        Large integers should also pass schema validation.
        """
        response = client.post(
            "/v1/responses/cancel",
            json={"subtask_id": 999999},
            headers={"Content-Type": "application/json"},
        )

        # Must NOT be 422 (schema validation error)
        assert response.status_code != 422
