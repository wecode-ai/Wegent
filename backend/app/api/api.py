# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints import auth, users, bots, tasks, repository, executors, teams
from app.api.endpoints.kind import k_router
from app.api.router import api_router
import wecode.api  # noqa: F401  side-effect import to load wecode patches and auto-mount internal routers

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(bots.router, prefix="/bots", tags=["bots"])
api_router.include_router(teams.router, prefix="/teams", tags=["teams"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(repository.router, prefix="/git", tags=["repository"])
api_router.include_router(executors.router, prefix="/executors", tags=["executors"])
api_router.include_router(k_router)