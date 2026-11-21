# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import closing

import pytest
from fastapi.testclient import TestClient
from starlette.routing import Match

from app.api.endpoints.health import health_check
from app.core.config import settings
from app.main import create_app


def test_probe_routes_match_early_and_preserve_responses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "API_PREFIX", "/api")
    test_app = create_app()
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

    with closing(TestClient(test_app)) as test_client:
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

        business_health = test_client.get("/api/health")
        assert business_health.status_code == 404


@pytest.mark.parametrize("prefix", ["", "/custom"])
def test_nondefault_api_prefix_keeps_python_database_health(
    monkeypatch: pytest.MonkeyPatch,
    prefix: str,
) -> None:
    monkeypatch.setattr(settings, "API_PREFIX", prefix)
    app = create_app()
    scope = {
        "type": "http",
        "path": f"{prefix}/health",
        "method": "GET",
        "root_path": "",
    }

    route = next(route for route in app.routes if route.matches(scope)[0] == Match.FULL)

    assert route.endpoint is health_check
