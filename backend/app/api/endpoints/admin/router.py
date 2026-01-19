# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin router that aggregates all admin sub-routers."""

from fastapi import APIRouter

from app.api.endpoints.admin import (
    api_keys,
    kind_management,
    public_bots,
    public_ghosts,
    public_models,
    public_retrievers,
    public_shells,
    public_teams,
    stats,
    system_config,
    tasks,
    users,
)

router = APIRouter()

# Include all sub-routers
router.include_router(users.router, tags=["admin-users"])
router.include_router(public_models.router, tags=["admin-public-models"])
router.include_router(public_teams.router, tags=["admin-public-teams"])
router.include_router(public_bots.router, tags=["admin-public-bots"])
router.include_router(public_ghosts.router, tags=["admin-public-ghosts"])
router.include_router(public_shells.router, tags=["admin-public-shells"])
router.include_router(public_retrievers.router, tags=["admin-public-retrievers"])
router.include_router(system_config.router, tags=["admin-system-config"])
router.include_router(api_keys.router, tags=["admin-api-keys"])
router.include_router(kind_management.router, tags=["admin-kind-management"])
router.include_router(stats.router, tags=["admin-stats"])
router.include_router(tasks.router, tags=["admin-tasks"])
