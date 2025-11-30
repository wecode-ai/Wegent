# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.webhooks.github import router as github_router
from app.api.endpoints.webhooks.gitlab import router as gitlab_router
from app.api.endpoints.webhooks.callback import router as callback_router

__all__ = ["github_router", "gitlab_router", "callback_router"]
