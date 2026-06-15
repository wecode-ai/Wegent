# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter

from app.api.endpoints.kind.skills import router as skills_router


def test_skill_router_has_concrete_paths_when_included_without_prefix():
    """Skill routes must not depend on caller-provided prefixes to be valid."""
    parent_router = APIRouter()

    parent_router.include_router(skills_router)

    route_paths = {route.path for route in parent_router.routes}
    assert "/kinds/skills" in route_paths
