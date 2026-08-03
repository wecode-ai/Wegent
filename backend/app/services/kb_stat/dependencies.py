# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""FastAPI dependencies gating the KB-stat feature behind a master switch.

When ``settings.KB_STAT_ENABLED`` is false, all KB-stat HTTP endpoints
return 503 with a ``kb_stat_disabled`` error code so the frontend can
distinguish "feature off" from other failures. ``/internal/kb-stat/health``
on the runtime side is exempt (it must stay reachable for monitoring).
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.core.config import settings


def require_kb_stat_enabled() -> None:
    """503 when the KB-stat master switch is off.

    Imported as a router-level dependency so every endpoint under
    ``/admin/knowledge-stats`` and ``/knowledge-bases/{kb_id}/stats``
    inherits the gate without per-route boilerplate.
    """
    if not settings.KB_STAT_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "kb_stat_disabled",
                "message": "KB statistics feature is disabled",
                "retryable": False,
            },
        )
