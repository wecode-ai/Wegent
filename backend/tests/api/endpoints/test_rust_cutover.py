# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep Rust-owned routes out of the Python public API router."""

import tomllib
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

from app.api.api import api_router

ROUTES_FILE = Path(__file__).resolve().parents[4] / "backend-rs/config/routes.toml"


def _rust_owned_routes() -> list[tuple[str, str]]:
    with ROUTES_FILE.open("rb") as file:
        config = tomllib.load(file)

    return [
        (method, rule["path"])
        for rule in config["routes"]
        for method in rule["methods"]
        # Root and metrics are listener-level routes, not children of the
        # Python API router verified by this test.
        if rule["path"].startswith("/api")
    ]


def _canonical_route_path(path: str) -> str:
    """Normalize Rust and FastAPI path parameters for ownership checks."""

    return "/".join(_canonical_route_segment(segment) for segment in path.split("/"))


def _canonical_route_segment(segment: str) -> str:
    if segment.startswith(":"):
        return "{}"
    if segment.startswith("*"):
        return "{*:path}"
    if segment.startswith("{") and segment.endswith("}"):
        parameter = segment[1:-1]
        return "{*:path}" if parameter.endswith(":path") else "{}"
    return segment


PYTHON_ROUTES = {
    (method, _canonical_route_path(route.path))
    for route in api_router.routes
    if isinstance(route, APIRoute)
    for method in route.methods
}


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/tasks/:task_id", "/tasks/{}"),
        ("/tasks/{id}", "/tasks/{}"),
        ("/tasks/{id:int}", "/tasks/{}"),
        ("/quota/*path", "/quota/{*:path}"),
        ("/quota/{proxy_path:path}", "/quota/{*:path}"),
        ("/models/decisions", "/models/decisions"),
    ],
)
def test_route_path_canonicalization(path: str, expected: str) -> None:
    assert _canonical_route_path(path) == expected


def _python_path_for_rust_route(rust_path: str) -> str:
    assert rust_path.startswith("/api")
    return rust_path.removeprefix("/api") or "/"


@pytest.mark.parametrize(("method", "path"), _rust_owned_routes())
def test_rust_owned_route_is_not_registered_in_python(method: str, path: str) -> None:
    python_path = _python_path_for_rust_route(path)

    assert (
        method,
        _canonical_route_path(python_path),
    ) not in PYTHON_ROUTES, f"{method} {path} is still registered by Python"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/teams"),
        ("PUT", "/teams/{team_id}"),
        ("POST", "/v1/wework-notifications"),
        ("PUT", "/v1/wework-notifications/preferences"),
        ("GET", "/tasks/lite/group"),
        ("GET", "/tasks/{task_id}/remote-workspace/file"),
        ("GET", "/apps/list"),
        ("POST", "/plugins/installed/sync-device"),
        ("GET", "/v1/kinds/skills/public/{skill_id}/download"),
        ("DELETE", "/v1/runtime-tasks/cloud-context"),
        ("GET", "/models/names"),
        ("POST", "/v1/cloud-projects"),
        ("GET", "/v1/projects/{project_id}"),
        ("GET", "/wework-transcripts/{transcript_id}"),
        ("POST", "/v1/responses"),
        ("GET", "/connector-runtime/tools"),
        ("GET", "/sites/{siteid}/analytics"),
    ],
)
def test_unmigrated_sibling_remains_registered_in_python(
    method: str, path: str
) -> None:
    assert any(
        isinstance(route, APIRoute) and route.path == path and method in route.methods
        for route in api_router.routes
    )
