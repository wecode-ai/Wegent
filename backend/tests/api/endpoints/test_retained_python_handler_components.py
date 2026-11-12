# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retained-handler component coverage cannot change production ownership."""

from fastapi import Depends, FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.api.api import api_router
from tests.retained_python_handlers import component_client


def test_component_client_keeps_both_production_routers_unchanged(test_client):
    production_routes = tuple(test_client.app.routes)
    api_routes = tuple(api_router.routes)
    path = "/api/internal/chat/history/{session_id}"

    def registered(app):
        return any(
            isinstance(route, APIRoute)
            and route.path == path
            and "GET" in route.methods
            for route in app.routes
        )

    assert not registered(test_client.app)
    with component_client(test_client, ("chat_history",)) as contract:
        assert contract.app is not test_client.app
        assert registered(contract.app)
        assert not registered(test_client.app)
        assert tuple(test_client.app.routes) == production_routes
        assert tuple(api_router.routes) == api_routes
    assert tuple(test_client.app.routes) == production_routes
    assert tuple(api_router.routes) == api_routes


def test_component_routes_reuse_compiled_fields_with_isolated_dependencies():
    def identity():
        raise HTTPException(status_code=401)

    production = FastAPI()

    @production.get("/isolation", response_model=dict[str, int])
    def read_identity(value: int = Depends(identity)):
        return {"value": value}

    route = next(route for route in production.routes if route.path == "/isolation")
    with TestClient(production) as source:
        source.app.dependency_overrides[identity] = lambda: 11
        with component_client(source, ()) as first:
            first_route = next(
                route for route in first.app.routes if route.path == "/isolation"
            )
            assert first_route is not route
            assert first_route.dependant is route.dependant
            assert first_route.response_field is route.response_field
            assert first.get("/isolation").json() == {"value": 11}
            first.app.dependency_overrides[identity] = lambda: 22
            with component_client(source, ()) as second:
                assert second.get("/isolation").json() == {"value": 11}
                assert first.get("/isolation").json() == {"value": 22}
                assert source.get("/isolation").json() == {"value": 11}
                second.app.dependency_overrides.clear()
                assert second.get("/isolation").status_code == 401
                assert first.get("/isolation").json() == {"value": 22}
        source.app.dependency_overrides.clear()
        assert source.get("/isolation").status_code == 401
