# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Temporary HTTP contracts for chat history pending reference-replay parity.

The production application's routes are never changed. Each opt-in module gets
an independent FastAPI application with cloned production routes and explicitly
selected retained components. This preserves dependency-injected authentication,
validation, response serialization, and multi-request permission contracts while
production ownership is independently checked by test_rust_cutover.py.
"""

from contextlib import contextmanager
from importlib import import_module
from typing import Iterator

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

# Only components used by HTTP contracts that cannot be replaced by a direct
# function call without losing authentication or request/response assertions.
_COMPONENTS = {
    "chat_history": (
        "internal.chat_storage",
        "get_chat_history",
        "GET",
        "/api/internal/chat/history/{session_id}",
        "HistoryResponse",
    )
}


@contextmanager
def component_client(
    production_client: TestClient,
    components: tuple[str, ...],
    *,
    api_prefix: str = "/api",
) -> Iterator[TestClient]:
    """Build a separate client; never re-enable a retired production route."""
    production = production_client.app
    app = FastAPI(exception_handlers=dict(production.exception_handlers))
    app.include_router(production.router)
    app.dependency_overrides.update(production.dependency_overrides)
    app.user_middleware = list(production.user_middleware)
    app.state._state.update(production.state._state)
    for component in components:
        module_name, name, method, path, model_name = _COMPONENTS[component]
        path = api_prefix + path.removeprefix("/api")
        module = import_module(f"app.api.endpoints.{module_name}")
        assert not any(
            isinstance(route, APIRoute)
            and route.path == path
            and method in route.methods
            for route in production.routes
        ), f"{method} {path} must remain absent from the production application"
        source = module.router
        router = APIRouter(
            dependencies=list(source.dependencies),
            default_response_class=source.default_response_class,
            responses=source.responses,
        )
        options = {}
        if model_name is not None:
            options["response_model"] = (
                list[getattr(module, model_name[5:-1])]
                if model_name.startswith("list[")
                else getattr(module, model_name)
            )
        router.add_api_route(path, getattr(module, name), methods=[method], **options)
        start = len(app.routes)
        app.include_router(router)
        added = app.router.routes[start:]
        del app.router.routes[start:]
        app.router.routes[:0] = added
    client = TestClient(app, headers=dict(production_client.headers))
    try:
        yield client
    finally:
        client.close()
