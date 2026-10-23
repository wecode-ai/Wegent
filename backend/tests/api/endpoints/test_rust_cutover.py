# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep Rust-owned routes out of the Python public API router."""

import tomllib
from importlib import import_module
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
    ("module", "names"),
    [
        ("deliveries", ("list_issue_assignments", "list_loop_item_tasks")),
        ("internal.callback", ("handle_callback",)),
        ("internal.robot_queue", ("emit_runtime_rpc",)),
        ("loop_item_executions", ("execution_statuses",)),
        ("wework_transcripts", ("release_lease_endpoint",)),
        ("groups", ("list_groups",)),
        (
            "adapter.attachments",
            ("upload_attachment", "get_attachment", "download_attachment"),
        ),
        ("cloud_projects", ("list_cloud_project_members",)),
        ("kind.skills", ("list_unified_skills", "UnifiedSkillResponse")),
        ("connector_runtime", ("list_connector_tools",)),
        (
            "internal.workspace_archives",
            ("restore_sandbox_workspace", "SandboxRestoreResponse"),
        ),
        ("projects", ("list_projects",)),
        ("adapter.tasks", ("get_tasks",)),
        ("workspaces", ("list_workspaces",)),
    ],
)
def test_retired_handler_bodies_are_removed(
    module: str, names: tuple[str, ...]
) -> None:
    endpoint = import_module(f"app.api.endpoints.{module}")
    for name in names:
        assert not hasattr(
            endpoint, name
        ), f"Retired Python handler {module}.{name} returned"


def test_url_metadata_cleanup_preserves_shared_ssrf_validation() -> None:
    from app.services import url_metadata

    assert not (ROUTES_FILE.parents[2] / "backend/app/api/endpoints/utils.py").exists()
    assert not hasattr(url_metadata, "fetch_url_metadata")
    assert callable(url_metadata._validate_url_for_ssrf)


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
        ("POST", "/internal/callback/batch"),
        ("GET", "/internal/robot-queue/device-status"),
        ("POST", "/runtime-work/llm-responses-proxy/chat/completions"),
        ("POST", "/runtime-work/llm-responses-proxy/messages"),
        ("POST", "/runtime-work/llm-responses-proxy/v1/messages"),
        ("GET", "/attachments/{attachment_id}/preview"),
        ("GET", "/attachments/{attachment_id}/playback"),
        ("POST", "/attachments/{attachment_id}/download-token"),
        ("POST", "/attachments/{attachment_id}/public-share"),
        ("GET", "/attachments/download/shared"),
        ("DELETE", "/attachments/{attachment_id}"),
        ("POST", "/v1/attachments/upload"),
        ("GET", "/v1/attachments/{attachment_id}/download"),
        ("POST", "/connector-runtime/call"),
        ("PUT", "/wework-transcripts/{transcript_id}/lease/{fencing_token}"),
    ],
)
def test_sibling_ownership_matches_active_route_table(method: str, path: str) -> None:
    python_registered = any(
        isinstance(route, APIRoute) and route.path == path and method in route.methods
        for route in api_router.routes
    )
    rust_selected = (method, _canonical_route_path(f"/api{path}")) in {
        (selected_method, _canonical_route_path(selected_path))
        for selected_method, selected_path in _rust_owned_routes()
    }
    assert python_registered is not rust_selected
