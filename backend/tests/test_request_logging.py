# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from app.main import _request_context_fields, _should_capture_http_body


def test_request_context_fields_ignore_non_object_json() -> None:
    assert _request_context_fields('[{"task_id": 1}]') == (None, None, None)


def test_request_context_fields_extract_object_identifiers() -> None:
    assert _request_context_fields(
        '{"task_id": 1, "subtask_id": "two", "user_id": 3}'
    ) == (1, "two", 3)


def test_oauth_token_endpoint_body_is_excluded_from_telemetry() -> None:
    assert _should_capture_http_body("/api/external/oauth/token") is False
    assert _should_capture_http_body("/api/external/oauth/revoke") is False
    assert _should_capture_http_body("/api/external/oauth/userinfo") is True


def test_access_logs_include_forwarded_headers(test_client, caplog):
    headers = {
        "X-Request-ID": "req-forwarded",
        "X-Forwarded-For": "203.0.113.9, 10.0.0.2",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "api.example.com",
        "X-Real-IP": "203.0.113.9",
        "Forwarded": "for=203.0.113.9;proto=https;host=api.example.com",
    }

    with caplog.at_level(logging.INFO, logger="app.main"):
        response = test_client.get("/api/health", headers=headers)

    assert response.status_code == 200

    request_logs = [
        record.message
        for record in caplog.records
        if record.message.startswith("request : GET /api/health")
    ]
    response_logs = [
        record.message
        for record in caplog.records
        if record.message.startswith("response: GET /api/health")
    ]

    assert request_logs
    assert response_logs
    for log_message in (request_logs[-1], response_logs[-1]):
        assert (
            "headers={x-forwarded-for=203.0.113.9, 10.0.0.2, "
            "x-forwarded-proto=https, x-forwarded-host=api.example.com, "
            "x-real-ip=203.0.113.9, "
            "forwarded=for=203.0.113.9;proto=https;host=api.example.com}"
        ) in log_message


def test_cors_exposes_request_id_header(test_client):
    response = test_client.get(
        "/api/health",
        headers={"Origin": "https://wework.example.com"},
    )

    assert response.status_code == 200
    exposed_headers = response.headers["access-control-expose-headers"]
    assert "X-Request-ID" in exposed_headers
    assert response.headers["X-Request-ID"]


def test_access_logs_redact_sensitive_query_parameters(test_client, caplog):
    with caplog.at_level(logging.INFO, logger="app.main"):
        response = test_client.get("/api/health?token=opencut-secret&probe=visible")

    assert response.status_code == 200
    access_logs = [
        record.message
        for record in caplog.records
        if "/api/health" in record.message
        and record.message.startswith(("request :", "response:"))
    ]
    assert len(access_logs) == 2
    for log_message in access_logs:
        assert "opencut-secret" not in log_message
        assert "token=%5BREDACTED%5D" in log_message
        assert "probe=visible" in log_message
