# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.routing import Match

from app.api.endpoints.health import health_check
from app.core.config import settings
from app.main import create_app


def test_probe_routes_match_early_and_preserve_responses(
    test_app: FastAPI, test_client: TestClient
) -> None:
    expected = {
        "/": {
            "name": settings.PROJECT_NAME,
            "version": settings.VERSION,
            "api_prefix": settings.API_PREFIX,
            "docs_url": f"{settings.API_PREFIX}/docs",
            "socketio_path": "/socket.io",
        },
        "/health": {"status": "healthy"},
    }

    for path, body in expected.items():
        scope = {"type": "http", "path": path, "method": "GET", "root_path": ""}
        matches = [
            index
            for index, route in enumerate(test_app.routes)
            if route.matches(scope)[0] == Match.FULL
        ]
        assert len(matches) == 1
        # Only FastAPI's four documentation routes may precede the probes.
        assert matches[0] < 6
        response = test_client.get(
            path, headers={"Origin": "https://wework.example.com"}
        )
        assert response.status_code == 200
        assert response.json() == body
        assert response.headers["access-control-allow-origin"] == "*"

    business_health = test_client.get(f"{settings.API_PREFIX}/health")
    assert business_health.status_code == 200
    assert "shutting_down" in business_health.json()


def test_empty_api_prefix_keeps_database_health_route_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "API_PREFIX", "")
    app = create_app()
    scope = {"type": "http", "path": "/health", "method": "GET", "root_path": ""}

    route = next(route for route in app.routes if route.matches(scope)[0] == Match.FULL)

    assert route.endpoint is health_check
