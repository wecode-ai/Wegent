"""
Daily sync task.
"""
from datetime import datetime, timedelta

import structlog

from app.core.database import AsyncSessionLocal
from app.services.sync_service import SyncService

logger = structlog.get_logger(__name__)


async def run_daily_sync():
    """Run daily data sync task."""
    logger.info("Starting daily sync task")

    # Calculate time range for yesterday
    now = datetime.utcnow()
    end_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_time = end_time - timedelta(days=1)

    async with AsyncSessionLocal() as db:
        service = SyncService(db)

        try:
            # Trigger sync
            sync_id = await service.trigger_sync(
                start_time=start_time,
                end_time=end_time,
            )
            logger.info("Sync job created", sync_id=sync_id)

            # Execute sync
            await service.execute_sync(sync_id)
            logger.info("Daily sync completed", sync_id=sync_id)

        except Exception as e:
            logger.exception("Daily sync failed", error=str(e))
