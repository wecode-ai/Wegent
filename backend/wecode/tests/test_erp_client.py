# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from unittest.mock import patch

import httpx
import pytest

from wecode.service.erp_client import (
    EmployeeInfo,
    EmployeeSearchOutcome,
    ErpClient,
)


class TestErpClient:
    def test_ensure_token_returns_cached_when_valid(self):
        client = ErpClient()
        client._access_token = "valid_token"
        client._token_expires_at = time.time() + 3600
        client.client_id = "test_id"
        client.client_secret = "test_secret"

        assert client._ensure_token() == "valid_token"

    def test_ensure_token_refreshes_when_expired(self):
        client = ErpClient()
        client._access_token = "expired_token"
        client._token_expires_at = time.time() - 10
        client.client_id = "test_id"
        client.client_secret = "test_secret"
        client.base_url = "https://erp.example.com"

        mock_response = httpx.Response(
            200,
            json={"data": {"access_token": "new_token", "expires_in": 1800}},
        )

        with patch("httpx.Client.request", return_value=mock_response) as request:
            token = client._ensure_token()
            assert token == "new_token"
            assert client._access_token == "new_token"
            assert request.call_args.kwargs["timeout"] == 1.0

    def test_search_departments_empty_when_no_base_url(self):
        client = ErpClient()
        client.base_url = ""
        assert client.search_departments("test") == []

    def test_search_hidden_department_ids_uses_t2_keyword(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        mock_response = httpx.Response(
            200,
            json={
                "data": {
                    "departments": [
                        {"department_id": 1001},
                        {"department_id": "1002"},
                        {"department_id": 1001},
                        {"name": "missing id"},
                    ]
                }
            },
        )

        with patch("httpx.Client.request", return_value=mock_response) as request:
            result = client.search_hidden_department_ids()

        assert result == {"1001", "1002"}
        assert request.call_args.kwargs["params"] == {"keyword": "T2"}
        assert request.call_args.kwargs["timeout"] == 1.0

    def test_search_hidden_department_ids_returns_none_on_request_failure(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"

        with patch("httpx.Client.request", side_effect=httpx.RequestError("failed")):
            assert client.search_hidden_department_ids() is None

    def test_search_employee_prefers_exact_match(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        mock_response = httpx.Response(
            200,
            json={
                "data": {
                    "employees": [
                        {"ssn": "12345", "name": "Other Person"},
                        {"ssn": "67890", "name": "Target User"},
                    ]
                }
            },
        )

        with patch("httpx.Client.request", return_value=mock_response):
            result = client.search_employee("Target User")
            assert result is not None
            assert result.name == "Target User"

    def test_batch_check_membership_records_failed_chunks(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        responses = [
            httpx.RequestError("chunk 1 failed"),
            httpx.Response(200, json={"data": {"results": []}}),
        ]

        with (
            caplog.at_level("INFO", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", side_effect=responses),
        ):
            result = client.batch_check_membership("ssn", ["d1"] * 60)

        assert result is None
        assert "outcome=partial_failure" in caplog.text

    def test_batch_check_membership_empty_when_no_input(self):
        client = ErpClient()
        assert client.batch_check_membership("", []) == {}
        assert client.batch_check_membership("ssn", []) == {}

    def test_all_request_logs_include_duration_and_masked_query_params(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        response = httpx.Response(200, json={"data": {"employees": []}})

        with (
            caplog.at_level("INFO", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", return_value=response) as request,
        ):
            result = client.search_employee_result("user@example.com")

        assert result.outcome is EmployeeSearchOutcome.NOT_FOUND
        assert request.call_args.kwargs["timeout"] == 1.0
        message = caplog.text
        assert "elapsed_ms=" in message
        assert "query_params=" in message
        assert "us****@example.com" in message
        assert "user@example.com" not in message

    def test_timeout_is_logged_and_preserved_as_request_failure(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        request = httpx.Request("GET", "https://erp.example.com/api/open/search")

        with (
            caplog.at_level("WARNING", logger="wecode.service.erp_client"),
            patch(
                "httpx.Client.request",
                side_effect=httpx.ReadTimeout("slow", request=request),
            ),
        ):
            result = client.search_employee_result("12345678")

        assert result.outcome is EmployeeSearchOutcome.REQUEST_FAILED
        assert "outcome=timeout" in caplog.text
        assert "12****78" in caplog.text

    def test_token_log_never_contains_secret(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client.client_id = "client-identifier"
        client.client_secret = "super-secret-value"
        response = httpx.Response(
            200,
            json={"data": {"access_token": "new-token", "expires_in": 1800}},
        )

        with (
            caplog.at_level("INFO", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", return_value=response),
        ):
            assert client._ensure_token() == "new-token"

        assert "[REDACTED]" in caplog.text
        assert "super-secret-value" not in caplog.text
        assert "new-token" not in caplog.text

    def test_token_rejects_non_object_json_without_raising(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client.client_id = "client-id"
        client.client_secret = "client-secret"
        response = httpx.Response(200, json=["unexpected"])

        with (
            caplog.at_level("WARNING", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", return_value=response),
        ):
            assert client._ensure_token() is None

        assert "operation=oauth_token" in caplog.text
        assert "outcome=invalid_response" in caplog.text
        assert "payload_type=list" in caplog.text

    def test_employee_search_distinguishes_invalid_response_from_not_found(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        response = httpx.Response(200, json={"data": ["unexpected"]})

        with patch("httpx.Client.request", return_value=response):
            result = client.search_employee_result("user@example.com")

        assert result.outcome is EmployeeSearchOutcome.INVALID_RESPONSE

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"data": None},
            {"data": {"employees": None}},
        ],
    )
    def test_employee_search_rejects_ambiguous_empty_responses(self, payload):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        with patch(
            "httpx.Client.request",
            return_value=httpx.Response(200, json=payload),
        ):
            result = client.search_employee_result("user@example.com")

        assert result.outcome is EmployeeSearchOutcome.INVALID_RESPONSE

    def test_membership_invalid_chunk_returns_none(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        responses = [
            httpx.Response(
                200,
                json={
                    "data": {"results": [{"department_id": "d1", "is_member": True}]}
                },
            ),
            httpx.Response(200, json=["unexpected"]),
        ]

        with patch("httpx.Client.request", side_effect=responses):
            result = client.batch_check_membership(
                "12345678", ["d1", *[f"d{i}" for i in range(2, 52)]]
            )

        assert result is None

    def test_membership_logs_masked_truncated_params_without_response_body(
        self, caplog
    ):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        response = httpx.Response(503, text="sensitive ERP response")
        department_ids = [f"department-{index}" for index in range(11)]

        with (
            caplog.at_level("WARNING", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", return_value=response) as request,
        ):
            client.batch_check_membership("12345678", department_ids)

        assert request.call_args.kwargs["timeout"] == 1.0
        assert "12****78" in caplog.text
        assert "'department_ids_truncated': True" in caplog.text
        assert "department-10" not in caplog.text
        assert "sensitive ERP response" not in caplog.text

    def test_department_search_logs_operation(self, caplog):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600
        response = httpx.Response(200, json={"data": {"departments": []}})

        with (
            caplog.at_level("INFO", logger="wecode.service.erp_client"),
            patch("httpx.Client.request", return_value=response),
        ):
            assert client.search_departments("Engineering") == []

        assert "operation=department_search" in caplog.text
