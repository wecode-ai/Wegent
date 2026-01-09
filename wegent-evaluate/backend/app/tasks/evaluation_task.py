"""
Daily evaluation task.
"""
import structlog
from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models import ConversationRecord, EvaluationStatus
from app.services.evaluation_service import EvaluationService

logger = structlog.get_logger(__name__)


async def run_daily_evaluation():
    """Run daily evaluation task for pending records."""
    logger.info("Starting daily evaluation task")

    async with AsyncSessionLocal() as db:
        service = EvaluationService(db)

        try:
            # Get count of pending records
            result = await db.execute(
                select(ConversationRecord.id).where(
                    ConversationRecord.evaluation_status == EvaluationStatus.PENDING
                )
            )
            pending_ids = [row[0] for row in result.all()]

            if not pending_ids:
                logger.info("No pending records to evaluate")
                return

            logger.info(f"Found {len(pending_ids)} pending records")

            # Process in batches
            batch_size = settings.EVALUATION_BATCH_SIZE
            for i in range(0, len(pending_ids), batch_size):
                batch_ids = pending_ids[i : i + batch_size]

                job_id, _ = await service.trigger_evaluation(
                    mode="ids",
                    record_ids=batch_ids,
                )

                await service.execute_evaluation(job_id)
                logger.info(
                    f"Processed batch {i // batch_size + 1}",
                    batch_size=len(batch_ids),
                )

            logger.info("Daily evaluation completed")

        except Exception as e:
            logger.exception("Daily evaluation failed", error=str(e))
