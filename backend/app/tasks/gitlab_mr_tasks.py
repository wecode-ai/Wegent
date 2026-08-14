# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery tasks for the GitLab MR -> board fix-task loop.

``process_gitlab_event`` handles one inbound webhook event; the webhook endpoint
only validates and enqueues it so the request stays fast. ``reconcile_gitlab_mr_integrations``
is the periodic safety net: it re-verifies installed hooks, settles rounds that
never received a pipeline terminal event (no-CI repos or lost webhooks), and
closes MRs that merged without an event.
"""

import logging

from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.models.cloud_project import CloudProject
from app.models.gitlab_mr import MRIntegration
from app.services.gitlab.integration_service import mr_integration_service
from app.services.gitlab.mr_service import mr_service

logger = logging.getLogger(__name__)

EVENT_KIND_HANDLERS = {
    "merge_request": mr_service.handle_merge_request_event,
    "note": mr_service.handle_note_event,
    "pipeline": mr_service.handle_pipeline_event,
}


def _process_integration_event(
    db: Session, integration_id: int, event_kind: str, payload: dict[str, object]
) -> None:
    integration = db.get(MRIntegration, integration_id)
    if integration is None or not integration.enabled:
        return
    project = db.get(CloudProject, integration.cloud_project_id)
    if project is None:
        return
    handler = EVENT_KIND_HANDLERS.get(event_kind)
    if handler is None:
        return
    handler(db, integration, project, payload)
    db.commit()


@celery_app.task(
    bind=True,
    name="app.tasks.gitlab_mr_tasks.process_gitlab_event",
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def process_gitlab_event(
    self, integration_id: int, event_kind: str, payload: dict[str, object]
) -> dict[str, object]:
    """Apply one validated GitLab webhook event to the MR state machine.

    The webhook endpoint already acked with 202, so GitLab will not re-deliver;
    a failure must surface and retry here instead of being swallowed as a
    successful ack."""
    from app.db.session import get_db_session

    with get_db_session() as db:
        try:
            _process_integration_event(db, integration_id, event_kind, payload)
        except Exception:
            db.rollback()
            raise
    return {"status": "ok"}


@celery_app.task(
    bind=True,
    name="app.tasks.gitlab_mr_tasks.reconcile_gitlab_mr_integrations",
)
def reconcile_gitlab_mr_integrations(self) -> dict[str, object]:
    """Periodically reconcile every enabled MR integration."""
    from app.db.session import get_db_session

    processed = 0
    with get_db_session() as db:
        integrations = (
            db.query(MRIntegration)
            .filter(MRIntegration.enabled == True)
            .all()  # noqa: E712
        )
        for integration in integrations:
            try:
                mr_integration_service.reconcile(db, integration)
                db.commit()
                processed += 1
            except Exception:
                logger.exception(
                    "Failed to reconcile GitLab MR integration %s", integration.id
                )
                db.rollback()
    return {"status": "ok", "reconciled": processed}
