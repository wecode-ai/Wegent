# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints import (
    admin,
    auth,
    groups,
    health,
    oidc,
    quota,
    repository,
    users,
    wiki,
)
from app.api.endpoints.adapter import (
    agents,
    attachments,
    bots,
    chat,
    dify,
    executors,
    models,
    shells,
    tasks,
    teams,
)
from app.api.endpoints.kind import k_router
from app.api.router import api_router

# Health check endpoints (no prefix, directly under /api)
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(oidc.router, prefix="/auth/oidc", tags=["auth", "oidc"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(groups.router, prefix="/groups", tags=["groups"])
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(models.router, prefix="/models", tags=["public-models"])
api_router.include_router(shells.router, prefix="/shells", tags=["shells"])
api_router.include_router(agents.router, prefix="/agents", tags=["public-shell"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(chat.router, prefix="/chat", tags=["chat"])
api_router.include_router(
    attachments.router, prefix="/attachments", tags=["attachments"]
)
api_router.include_router(repository.router, prefix="/git", tags=["repository"])
api_router.include_router(executors.router, prefix="/executors", tags=["executors"])
api_router.include_router(quota.router, prefix="/quota", tags=["quota"])
api_router.include_router(dify.router, prefix="/dify", tags=["dify"])
api_router.include_router(wiki.router, prefix="/wiki", tags=["wiki"])
api_router.include_router(
    wiki.internal_router, prefix="/internal/wiki", tags=["wiki-internal"]
)
api_router.include_router(k_router)
