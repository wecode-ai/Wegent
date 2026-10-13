# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Python must relinquish only the GET routes selected for this Rust cutover."""

import pytest
from fastapi.routing import APIRoute

from app.api.api import api_router


@pytest.mark.parametrize(
    "path",
    [
        "/teams",
        "/v1/wework-notifications",
        "/tasks/{task_id}/remote-workspace/status",
        "/tasks/lite/personal",
        "/apps/installed",
        "/plugins/installed",
        "/v1/kinds/skills/{skill_id}/download",
        "/tasks/{task_id}/runtime-check",
        "/tasks/{task_id}/remote-workspace/tree",
        "/v1/runtime-tasks/cloud-context",
    ],
)
def test_migrated_get_is_not_registered_in_python(path: str) -> None:
    assert not any(
        isinstance(route, APIRoute) and route.path == path and "GET" in route.methods
        for route in api_router.routes
    )


@pytest.mark.parametrize(
    "method,path",
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
    ],
)
def test_unmigrated_sibling_remains_registered_in_python(
    method: str, path: str
) -> None:
    assert any(
        isinstance(route, APIRoute) and route.path == path and method in route.methods
        for route in api_router.routes
    )
