# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Inbound GitLab webhook endpoint for the MR -> board fix-task loop.

The endpoint only validates and enqueues; all GitLab API I/O happens in the
Celery ``process_gitlab_event`` task so the request stays fast. GitLab retries
non-2xx responses, so unrecognized-but-validated events return 200.
"""

import hmac
import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.gitlab_mr import MRIntegration

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/webhooks/gitlab", tags=["gitlab-webhook"])

_ALLOWED_EVENT_KINDS = {"merge_request", "note", "pipeline"}


def _normalize_repository(value: str) -> str:
    return value.strip().strip("/")


@router.post("/mr/{webhook_token}")
async def gitlab_mr_webhook(
    webhook_token: str,
    request: Request,
    x_gitlab_token: str | None = Header(default=None, alias="X-Gitlab-Token"),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Receive a GitLab project webhook event for a registered MR integration."""
    integration = (
        db.query(MRIntegration)
        .filter(
            MRIntegration.webhook_token == webhook_token,
            MRIntegration.enabled == True,  # noqa: E712
        )
        .first()
    )
    if integration is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook not found")

    # GitLab signs requests with the plain shared secret configured on the
    # hook. Compare in constant time to avoid a timing oracle.
    expected = integration.webhook_secret
    if not x_gitlab_token or not hmac.compare_digest(x_gitlab_token, expected):
        logger.warning(
            "[gitlab-webhook] Invalid X-Gitlab-Token for integration %s",
            integration.id,
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook token")

    try:
        payload: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid JSON payload")

    if not isinstance(payload, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid JSON payload")

    # A copied hook must not be able to inject events for a different repo.
    project = payload.get("project")
    repo = (
        (project or {}).get("path_with_namespace")
        if isinstance(project, dict)
        else None
    )
    if not repo or _normalize_repository(str(repo)) != _normalize_repository(
        integration.repository
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Webhook is not registered for this repository"
        )

    event_kind = str(payload.get("object_kind") or "")
    if event_kind not in _ALLOWED_EVENT_KINDS:
        return {"status": "ok", "ignored": True}
    if event_kind == "note":
        attrs = payload.get("object_attributes")
        noteable_type = (
            (attrs or {}).get("noteable_type") if isinstance(attrs, dict) else None
        )
        if str(noteable_type or "") != "MergeRequest":
            return {"status": "ok", "ignored": True}

    # Thin dispatch: heavy lifting happens in the worker.
    from app.tasks.gitlab_mr_tasks import process_gitlab_event

    process_gitlab_event.apply_async(
        args=[integration.id, event_kind, payload],
    )
    return {"status": "ok"}
