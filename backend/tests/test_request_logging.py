# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from dataclasses import replace
from unittest.mock import Mock

from fastapi.testclient import TestClient

from app import main
from app.core.config import settings
from app.main import _request_context_fields, _should_capture_http_body
from app.services.execution.package_runtime import IMAGE_EXECUTION_PATH
from shared.telemetry import config, core, instrumentation
from shared.telemetry.instrumentation import _should_capture_http_client_body


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


def test_site_environment_variable_bodies_are_excluded_from_telemetry() -> None:
    path = "/api/sites/prj_123/environment-variables"
    assert _should_capture_http_body(path) is False
    assert _should_capture_http_body(f"{path}/DATABASE_URL") is False
    assert _should_capture_http_body("/api/sites/prj_123") is True


def test_image_runtime_body_is_excluded_with_capture_enabled(monkeypatch) -> None:
    otel_config = replace(
        config.get_otel_config(), enabled=True, capture_request_body=True
    )
    monkeypatch.setattr(config, "get_otel_config", lambda *_: otel_config)
    monkeypatch.setattr(core, "init_telemetry", Mock())
    monkeypatch.setattr(core, "is_telemetry_enabled", lambda: True)
    monkeypatch.setattr(instrumentation, "setup_opentelemetry_instrumentation", Mock())
    monkeypatch.setattr(settings, "CHAT_SHELL_MODE", "http")
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-runtime-token")
    monkeypatch.setattr("opentelemetry.trace.get_current_span", lambda: Mock())
    log_body = Mock()
    monkeypatch.setattr(main, "log_json_body", log_body)
    headers = {"Authorization": "Bearer test-runtime-token"}

    client = TestClient(main.create_app())
    request = {"model_config": {"modelType": "image", "api_key": "test-provider-key"}}
    # Zero IDs produce an endpoint validation error without invoking a provider.
    response = client.post(IMAGE_EXECUTION_PATH, json=request, headers=headers)
    assert response.status_code == 422
    assert response.json() == {"detail": "Expected a persisted task turn"}
    log_body.assert_not_called()
    assert not _should_capture_http_body(f"{IMAGE_EXECUTION_PATH}/")

    client.post("/api/health", json={"probe": "visible"})
    log_body.assert_called_once()
    assert log_body.call_args.args[0] == "http.request.body"
    assert "visible" in log_body.call_args.args[1]


def test_platform_environment_variable_bodies_are_excluded_from_httpx_traces() -> None:
    class Request:
        class URL:
            path = "/api/v1/projects/prj_123/environment-variables/API_TOKEN"

        url = URL()

    assert _should_capture_http_client_body(Request()) is False


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
