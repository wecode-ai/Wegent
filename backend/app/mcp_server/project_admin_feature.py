# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The MCP rollout boundary preserves legacy space updates during rollback."""

from collections.abc import Collection

from fastapi import HTTPException

from app.core.config import settings

LEGACY_SPACE_UPDATE_FIELDS = frozenset(
    {
        "name",
        "description",
        "tags",
        "version",
        "operation_id",
        "idempotency_key",
        "dry_run",
    }
)


def require_project_admin_write_enabled(
    *, space_fields: Collection[str] | None = None
) -> None:
    """Gate new MCP writes while retaining explicitly supplied legacy fields."""
    if settings.WEWORK_PROJECT_ADMIN_TOOLS_V1:
        return
    if space_fields is not None and set(space_fields) <= LEGACY_SPACE_UPDATE_FIELDS:
        return
    raise HTTPException(
        409,
        {
            "reason_code": "feature_disabled",
            "message": "wework.projectAdminTools.v1 is disabled",
        },
    )
