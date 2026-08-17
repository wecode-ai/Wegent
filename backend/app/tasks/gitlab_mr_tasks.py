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

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.models.cloud_project import CloudProject
from app.models.gitlab_mr import MRIntegration, MRRecord
from app.services.gitlab.integration_service import mr_integration_service
from app.services.gitlab.mr_service import mr_service

logger = logging.getLogger(__name__)

EVENT_KIND_HANDLERS = {
    "merge_request": mr_service.handle_merge_request_event,
    "note": mr_service.handle_note_event,
    "pipeline": mr_service.handle_pipeline_event,
}


def _emit_task_created_event(
    db: Session, integration: MRIntegration, record: MRRecord
) -> None:
    """Fire a project-automation ``task.created`` event for a freshly created
    MR fix card so matching assignment rules can take over. Best-effort: a
    failure must not break the MR state machine or the reconcile loop."""
    import asyncio

    from app.models.delivery import LoopItem
    from app.services.project_automations import (
        ProjectAutomationEvent,
        project_automation_processor,
    )

    card = db.get(LoopItem, record.current_loop_item_id)
    if card is None:
        return
    project = db.get(CloudProject, integration.cloud_project_id)
    if project is None:
        return
    try:
        asyncio.run(
            project_automation_processor.process(
                db,
                ProjectAutomationEvent(
                    event_type="task.created",
                    project_id=str(project.id),
                    subject_id=str(card.id),
                    source=project.task_provider,
                    actor_user_id=integration.created_by_user_id or None,
                    payload={
                        "id": card.id,
                        "title": card.title or "",
                        "status": card.status or "",
                        "priority": card.priority or "none",
                        "tags": ["mr-fix"],
                        "description": card.description or "",
                        "source": "gitlab",
                        "mr_iid": record.mr_iid,
                        "source_task_binding_id": card.source_task_binding_id or "",
                    },
                ),
            )
        )
    except Exception:
        logger.exception(
            "Project automation failed for MR fix card card=%s mr_iid=%s",
            card.id,
            record.mr_iid,
        )
        db.rollback()


def _process_integration_event(
    db: Session, integration_id: int, event_kind: str, payload: dict[str, object]
) -> None:
    integration = db.get(MRIntegration, integration_id)
    if integration is None or not integration.enabled:
        return
    project = db.get(CloudProject, integration.cloud_project_id)
    if project is None or project.status != "active":
        # A webhook may linger on the repo after the project was archived; ack
        # it without touching the board.
        return
    handler = EVENT_KIND_HANDLERS.get(event_kind)
    if handler is None:
        return
    record = handler(db, integration, project, payload)
    created = record is not None and getattr(record, "_mr_card_created", False)
    if record is not None:
        # One-shot marker: consumed (and cleared) per handler call so a later
        # event on the same session cannot fire a duplicate notification.
        record._mr_card_created = False
    db.commit()
    if created:
        _emit_task_created_event(db, integration, record)


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
    """Periodically reconcile every enabled MR integration of active projects.

    Archived projects are skipped: their integration is torn down on archive,
    and a stale row must not re-install its GitLab webhook or keep feeding the
    archived board.
    """
    from app.db.session import get_db_session

    processed = 0
    with get_db_session() as db:
        active_project_ids = select(CloudProject.id).where(
            CloudProject.status == "active"
        )
        integrations = (
            db.query(MRIntegration)
            .filter(
                MRIntegration.enabled == True,  # noqa: E712
                MRIntegration.cloud_project_id.in_(active_project_ids),
            )
            .all()
        )
        for integration in integrations:
            try:
                touched = mr_integration_service.reconcile(db, integration)
                db.commit()
                for record in touched:
                    if getattr(record, "_mr_card_created", False):
                        record._mr_card_created = False
                        _emit_task_created_event(db, integration, record)
                processed += 1
            except Exception:
                logger.exception(
                    "Failed to reconcile GitLab MR integration %s", integration.id
                )
                db.rollback()
    return {"status": "ok", "reconciled": processed}
