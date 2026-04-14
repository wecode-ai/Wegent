"""Result writeback for inbox auto-processing.

Writes subscription execution results back to the originating QueueMessage.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from shared.models.db.enums import QueueMessageStatus
from shared.models.db.work_queue import QueueMessage

logger = logging.getLogger(__name__)


def write_execution_result_to_message(
    db: Session,
    inbox_message_id: int,
    status: str,
    result_summary: Optional[str] = None,
    error_message: Optional[str] = None,
    task_id: int = 0,
) -> None:
    """Write subscription execution result back to QueueMessage.

    Args:
        db: Database session
        inbox_message_id: QueueMessage ID
        status: Execution status ("COMPLETED", "FAILED", "CANCELLED")
        result_summary: Summary from AI execution
        error_message: Error message if failed
        task_id: Task ID created for processing
    """
    message = db.query(QueueMessage).filter(QueueMessage.id == inbox_message_id).first()

    if not message:
        logger.warning(
            f"[InboxWriteback] QueueMessage {inbox_message_id} not found, "
            f"cannot write back result"
        )
        return

    if status == "COMPLETED":
        message.status = QueueMessageStatus.PROCESSED
        message.process_result = {
            "summary": result_summary or "",
            "completedAt": datetime.now(timezone.utc).isoformat(),
        }
        if task_id:
            message.process_task_id = task_id
        message.processed_at = datetime.now(timezone.utc)

        logger.info(f"[InboxWriteback] Message {inbox_message_id} marked as PROCESSED")

    elif status == "FAILED":
        message.status = QueueMessageStatus.FAILED
        message.process_result = {"error": error_message or "Execution failed"}
        if task_id:
            message.process_task_id = task_id

        logger.info(
            f"[InboxWriteback] Message {inbox_message_id} marked as FAILED: "
            f"{error_message}"
        )

    elif status == "CANCELLED":
        message.status = QueueMessageStatus.UNREAD
        message.process_result = {"error": "Processing was cancelled"}
        message.process_subscription_id = None

        logger.info(
            f"[InboxWriteback] Message {inbox_message_id} reset to UNREAD "
            f"(cancelled)"
        )

    db.commit()
