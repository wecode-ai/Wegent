# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging


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
