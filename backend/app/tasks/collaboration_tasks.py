# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Maintenance tasks for collaboration Issue projections."""

from dataclasses import asdict

from app.core.celery_app import celery_app


@celery_app.task(
    name="app.tasks.collaboration_tasks.reindex_issue_change_request_badges"
)
def reindex_issue_change_request_badges(
    *, project_id: str, item_id: str
) -> dict[str, object]:
    """Reconcile one local Issue's change-request badge sources."""

    from app.db.session import SessionLocal
    from app.services.loop_items.change_requests import (
        reindex_change_request_badges,
    )

    db = SessionLocal()
    try:
        return asdict(
            reindex_change_request_badges(
                db,
                project_id=project_id,
                item_id=item_id,
            )
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
