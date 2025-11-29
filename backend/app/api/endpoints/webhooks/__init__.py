# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Webhooks package for handling external CI events
"""
from app.api.endpoints.webhooks.github import router as github_router
from app.api.endpoints.webhooks.gitlab import router as gitlab_router

__all__ = ["github_router", "gitlab_router"]
