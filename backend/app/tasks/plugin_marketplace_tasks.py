# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Periodic tasks for selectively mirrored plugin releases."""

import logging

from app.core.celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.plugin_marketplace_tasks.sync_plugin_upstreams")
def sync_plugin_upstreams() -> dict[str, int]:
    """Synchronize only explicitly enabled upstream plugin records."""
    from app.core.distributed_lock import distributed_lock
    from app.db.session import get_db_session
    from app.services.plugin_marketplace_service import plugin_marketplace_service

    with distributed_lock.acquire_context(
        "sync_plugin_upstreams", expire_seconds=60 * 60
    ) as acquired:
        if not acquired:
            return {"synced": 0, "skipped": 1}
        with get_db_session() as db:
            items = plugin_marketplace_service.sync_enabled_upstreams(db)
            logger.info("Synchronized %s plugin upstreams", len(items))
            return {"synced": len(items), "skipped": 0}
