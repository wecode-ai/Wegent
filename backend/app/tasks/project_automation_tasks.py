# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Periodic dispatch for Wework project automations."""

import asyncio
import logging

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.services.project_automations import project_automation_service

logger = logging.getLogger(__name__)


def check_due_project_automations_sync() -> int:
    db = SessionLocal()
    try:
        return asyncio.run(project_automation_service.check_due(db))
    except Exception:
        db.rollback()
        logger.exception("Project automation scheduler failed")
        return 0
    finally:
        db.close()


@celery_app.task(
    name="app.tasks.project_automation_tasks.check_due_project_automations"
)
def check_due_project_automations() -> int:
    return check_due_project_automations_sync()
