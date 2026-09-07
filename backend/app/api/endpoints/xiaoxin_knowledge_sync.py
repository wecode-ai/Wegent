# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Notification ingress for Xiaoxin's HR knowledge publication."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.xiaoxin_knowledge_sync import (
    XiaoxinKnowledgeSyncNotification,
    XiaoxinKnowledgeSyncResponse,
)
from app.services.auth.xiaoxin_sync_token import verify_xiaoxin_sync_token
from app.services.knowledge.xiaoxin import XIAOXIN_HR_RESOURCE_ID
from app.services.knowledge.xiaoxin_sync import (
    XiaoxinSyncError,
    submit_xiaoxin_hr_sync,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/knowledge-sync/notify",
    response_model=XiaoxinKnowledgeSyncResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_xiaoxin_sync_token)],
)
def notify_xiaoxin_knowledge_sync(
    notification: XiaoxinKnowledgeSyncNotification,
    db: Session = Depends(get_db),
) -> XiaoxinKnowledgeSyncResponse:
    """Accept configured domains and submit HR through the shared import path."""
    domains = list(dict.fromkeys(notification.domains))
    accepted = [domain for domain in domains if domain == XIAOXIN_HR_RESOURCE_ID]
    ignored = [domain for domain in domains if domain != XIAOXIN_HR_RESOURCE_ID]

    logger.info(
        "Xiaoxin knowledge-sync notification received",
        extra={
            "trigger_source": "notification",
            "accepted_domains": accepted,
            "ignored_domains": ignored,
            "sync_time": notification.sync_time,
            "operator": notification.operator,
        },
    )

    if accepted:
        try:
            submission = submit_xiaoxin_hr_sync(db, trigger_source="notification")
        except XiaoxinSyncError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        logger.info(
            "Xiaoxin knowledge-sync notification submitted",
            extra={
                "trigger_source": "notification",
                "domain": XIAOXIN_HR_RESOURCE_ID,
                "knowledge_base_id": submission.knowledge_base_id,
                "document_id": submission.document.id,
                "sync_time": notification.sync_time,
                "operator": notification.operator,
            },
        )

    return XiaoxinKnowledgeSyncResponse(
        accepted_domains=accepted,
        ignored_domains=ignored,
    )
