# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints import auth, users, repository, oidc, quota, admin
from app.api.endpoints.adapter import models, agents, bots, teams, tasks, executors, dify
from app.api.endpoints.kind import k_router
from app.api.router import api_router

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(oidc.router, prefix="/auth/oidc", tags=["auth", "oidc"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(models.router, prefix="/models", tags=["public-models"])
api_router.include_router(agents.router, prefix="/agents", tags=["public-shell"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(repository.router, prefix="/git", tags=["repository"])
api_router.include_router(executors.router, prefix="/executors", tags=["executors"])
api_router.include_router(quota.router, prefix="/quota", tags=["quota"])
api_router.include_router(dify.router, prefix="/dify", tags=["dify"])
api_router.include_router(k_router)