# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Opt-in HTTP harness for retained Python handlers after a Rust cutover."""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, FastAPI


@contextmanager
def legacy_python_handlers(app: FastAPI) -> Iterator[Callable[..., None]]:
    """Keep handler contracts testable without changing production registration."""

    original_routes = list(app.router.routes)
    original_schema = app.openapi_schema

    def register(
        path: str,
        endpoint: Callable[..., Any],
        source_router: APIRouter,
        *,
        methods: list[str],
        **options: Any,
    ) -> None:
        router = APIRouter(
            dependencies=list(source_router.dependencies),
            default_response_class=source_router.default_response_class,
            responses=source_router.responses,
        )
        router.add_api_route(path, endpoint, methods=methods, **options)
        start = len(app.router.routes)
        app.include_router(router)
        added_routes = app.router.routes[start:]
        del app.router.routes[start:]
        # Literal handler paths must precede unrelated parameter routes.
        app.router.routes[:0] = added_routes

    try:
        yield register
    finally:
        app.router.routes[:] = original_routes
        app.openapi_schema = original_schema
