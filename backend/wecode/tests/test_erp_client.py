# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from wecode.service.erp_client import EmployeeInfo, ErpClient


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

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {"access_token": "new_token", "expires_in": 1800}
        }

        with patch("httpx.Client.post", return_value=mock_response):
            token = client._ensure_token()
            assert token == "new_token"
            assert client._access_token == "new_token"

    def test_search_departments_empty_when_no_base_url(self):
        client = ErpClient()
        client.base_url = ""
        assert client.search_departments("test") == []

    def test_search_hidden_department_ids_uses_t2_keyword(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {
                "departments": [
                    {"department_id": 1001},
                    {"department_id": "1002"},
                    {"department_id": 1001},
                    {"name": "missing id"},
                ]
            }
        }

        with patch("httpx.Client.get", return_value=mock_response) as mock_get:
            result = client.search_hidden_department_ids()

        assert result == {"1001", "1002"}
        assert mock_get.call_args.kwargs["params"] == {"keyword": "T2"}

    def test_search_hidden_department_ids_returns_none_on_request_failure(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"

        with patch("httpx.Client.get", side_effect=httpx.RequestError("failed")):
            assert client.search_hidden_department_ids() is None

    def test_search_employee_prefers_exact_match(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {
                "employees": [
                    {"ssn": "12345", "name": "Other Person"},
                    {"ssn": "67890", "name": "Target User"},
                ]
            }
        }

        with patch("httpx.Client.get", return_value=mock_response):
            result = client.search_employee("Target User")
            assert result is not None
            assert result.name == "Target User"

    def test_batch_check_membership_records_failed_chunks(self):
        client = ErpClient()
        client.base_url = "https://erp.example.com"
        client._access_token = "token"
        client._token_expires_at = time.time() + 3600

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"results": []}}

        with patch("httpx.Client.post", return_value=mock_response):
            result = client.batch_check_membership("ssn", ["d1"] * 60)
            assert isinstance(result, dict)

    def test_batch_check_membership_empty_when_no_input(self):
        client = ErpClient()
        assert client.batch_check_membership("", []) == {}
        assert client.batch_check_membership("ssn", []) == {}
