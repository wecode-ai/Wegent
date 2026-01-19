# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin endpoints package.

This package contains all admin-related API endpoints, organized by functionality:
- users: User management (CRUD, password reset, role management)
- public_models: Public model management
- public_teams: Public team management
- public_bots: Public bot management
- public_ghosts: Public ghost management
- public_shells: Public shell management
- public_retrievers: Public retriever management
- system_config: System configuration (quick access, slogan/tips)
- api_keys: Service key and personal key management
- kind_management: Kind management and batch operations
- stats: System statistics
- tasks: Task management and token generation
"""

from app.api.endpoints.admin.router import router

__all__ = ["router"]
