# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retained-handler component coverage cannot change production ownership."""

from fastapi.routing import APIRoute

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
