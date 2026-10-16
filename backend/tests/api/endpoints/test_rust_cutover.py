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
        # Python keeps its loopback root probe for process diagnostics. The
        # public listener still owns GET / through the Rust route table.
        if rule["path"] != "/"
    ]


def _python_path_template(rust_path: str) -> str:
    assert rust_path.startswith("/api")
    path = rust_path.removeprefix("/api") or "/"
    return "/".join(
        (
            f"{{{segment[1:]}}}"
            if segment.startswith(":")
            else f"{{{segment[1:]}:path}}" if segment.startswith("*") else segment
        )
        for segment in path.split("/")
    )


@pytest.mark.parametrize(("method", "path"), _rust_owned_routes())
def test_rust_owned_route_is_not_registered_in_python(method: str, path: str) -> None:
    python_path = _python_path_template(path)

    assert not any(
        isinstance(route, APIRoute)
        and route.path == python_path
        and method in route.methods
        for route in api_router.routes
    ), f"{method} {path} is still registered by Python"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/teams"),
        ("GET", "/teams/default"),
        ("POST", "/v1/wework-notifications"),
        ("GET", "/v1/wework-notifications/preferences"),
        ("GET", "/tasks/lite/group"),
        ("GET", "/tasks/{task_id}/remote-workspace/file"),
        ("GET", "/apps/list"),
        ("POST", "/plugins/installed/sync-device"),
        ("GET", "/v1/kinds/skills/public/{skill_id}/download"),
        ("DELETE", "/v1/runtime-tasks/cloud-context"),
        ("GET", "/models/names"),
        ("POST", "/v1/cloud-projects"),
        ("GET", "/wework-transcripts/{transcript_id}"),
        ("POST", "/v1/responses"),
        ("GET", "/connector-runtime/tools"),
    ],
)
def test_unmigrated_sibling_remains_registered_in_python(
    method: str, path: str
) -> None:
    assert any(
        isinstance(route, APIRoute) and route.path == path and method in route.methods
        for route in api_router.routes
    )
