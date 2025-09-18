# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints import auth, users, bots, tasks, repository, executors, teams, subtasks, oidc
from app.api.endpoints.kind import k_router
from app.internal.api import internal_router
from app.api.router import api_router

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(oidc.router, prefix="/auth/oidc", tags=["auth", "oidc"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
# api_router.include_router(subtasks.router, prefix="/subtasks", tags=["subtasks"])
api_router.include_router(repository.router, prefix="/github", tags=["github"])
api_router.include_router(executors.router, prefix="/executors", tags=["executors"])
api_router.include_router(k_router)
api_router.include_router(internal_router)