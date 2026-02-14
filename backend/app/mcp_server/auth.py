# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task token authentication for MCP Server.

This module re-exports task token functions from the centralized auth service.
For new code, prefer importing directly from app.services.auth.

Example:
    from app.services.auth import create_task_token, verify_task_token
"""

# Re-export from centralized auth service for backward compatibility
from app.services.auth.task_token import (
    TaskTokenData,
    TaskTokenInfo,
    create_task_token,
    extract_token_from_header,
    get_user_from_task_token,
    verify_task_token,
)

__all__ = [
    "TaskTokenData",
    "TaskTokenInfo",
    "create_task_token",
    "verify_task_token",
    "get_user_from_task_token",
    "extract_token_from_header",
]
