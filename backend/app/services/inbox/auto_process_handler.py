"""Inbox auto-process handler for triggering subscriptions on message arrival."""

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.events import QueueMessageCreatedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.schemas.subscription import SubscriptionEventType
from app.schemas.work_queue import AutoProcessConfig, SubscriptionRef
from shared.models.db.enums import QueueMessageStatus, TriggerMode
from shared.models.db.work_queue import QueueMessage

logger = logging.getLogger(__name__)


class InboxAutoProcessHandler:
    """Handler that auto-processes inbox messages via linked subscriptions."""

    async def on_message_created(self, event: QueueMessageCreatedEvent) -> None:
        """Handle QueueMessageCreatedEvent.

        Checks if the queue has auto-processing enabled and triggers
        the linked subscription if conditions are met.
        """
        logger.info(
            f"[InboxAutoProcess] Received QueueMessageCreatedEvent: "
            f"message_id={event.message_id}, queue_id={event.queue_id}"
        )

        try:
            with get_db_session() as db:
                # Load WorkQueue
                work_queue = (
                    db.query(Kind)
                    .filter(
                        Kind.id == event.queue_id,
                        Kind.kind == "WorkQueue",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not work_queue:
                    logger.debug(
                        f"[InboxAutoProcess] WorkQueue {event.queue_id} not found"
                    )
                    return

                # Parse autoProcess config
                spec = work_queue.json.get("spec", {})
                auto_process_data = spec.get("autoProcess")
                if not auto_process_data:
                    return

                try:
                    auto_process = AutoProcessConfig.model_validate(auto_process_data)
                except Exception as e:
                    logger.warning(
                        f"[InboxAutoProcess] Invalid autoProcess config for queue "
                        f"{event.queue_id}: {e}"
                    )
                    return

                # Check if enabled
                if not auto_process.enabled:
                    return

                # Check trigger mode
                if auto_process.triggerMode == TriggerMode.MANUAL:
                    return

                if auto_process.triggerMode != TriggerMode.IMMEDIATE:
                    logger.debug(
                        f"[InboxAutoProcess] Unsupported trigger mode "
                        f"{auto_process.triggerMode} for queue {event.queue_id}"
                    )
                    return

                # Check subscriptionRef
                if not auto_process.subscriptionRef:
                    logger.warning(
                        f"[InboxAutoProcess] Auto-process enabled but no "
                        f"subscriptionRef for queue {event.queue_id}"
                    )
                    return

                # Load the message
                message = (
                    db.query(QueueMessage)
                    .filter(QueueMessage.id == event.message_id)
                    .first()
                )

                if not message:
                    logger.warning(
                        f"[InboxAutoProcess] Message {event.message_id} not found"
                    )
                    return

                # Prevent re-processing of messages already being processed
                if message.status in (
                    QueueMessageStatus.PROCESSING,
                    QueueMessageStatus.PROCESSED,
                ):
                    logger.info(
                        f"[InboxAutoProcess] Message {event.message_id} already "
                        f"in status {message.status}, skipping"
                    )
                    return

                # Resolve subscription
                subscription = self._resolve_subscription(
                    db,
                    auto_process.subscriptionRef,
                    work_queue.user_id,
                )

                if not subscription:
                    self._mark_message_failed(
                        db,
                        message,
                        "Subscription not found or not accessible",
                    )
                    return

                # Validate subscription configuration
                error = self._validate_subscription(subscription)
                if error:
                    self._mark_message_failed(db, message, error)
                    return

                # Update message status to PROCESSING
                message.status = QueueMessageStatus.PROCESSING
                message.process_subscription_id = subscription.id
                message.processing_started_at = datetime.now(timezone.utc)
                db.commit()

                # Build inbox context for prompt template
                inbox_context = self._build_inbox_context(message, work_queue, event)

                # Create execution and dispatch
                self._dispatch_execution(db, subscription, message, inbox_context)

                logger.info(
                    f"[InboxAutoProcess] Dispatched auto-processing for "
                    f"message {event.message_id} via subscription {subscription.id}"
                )

        except Exception as e:
            logger.error(
                f"[InboxAutoProcess] Failed to process message "
                f"{event.message_id}: {e}",
                exc_info=True,
            )

    def _resolve_subscription(
        self,
        db: Session,
        ref: SubscriptionRef,
        queue_owner_user_id: int,
    ) -> Optional[Kind]:
        """Resolve subscription by reference triple."""
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Subscription",
                Kind.namespace == ref.namespace,
                Kind.name == ref.name,
                Kind.user_id == ref.userId,
                Kind.is_active == True,
            )
            .first()
        )

    def _validate_subscription(self, subscription: Kind) -> Optional[str]:
        """Validate subscription is suitable for inbox auto-processing.

        Returns error message if invalid, None if valid.
        """
        from app.services.subscription.helpers import validate_subscription_for_read

        try:
            crd = validate_subscription_for_read(subscription.json)
        except Exception as e:
            return f"Invalid subscription configuration: {e}"

        # Check enabled
        internal = subscription.json.get("_internal", {})
        if not internal.get("enabled", True):
            return "Subscription is disabled"

        # Check trigger type is event with inbox_message
        if crd.spec.trigger:
            trigger = crd.spec.trigger
            if hasattr(trigger, "type") and trigger.type:
                from app.schemas.subscription import SubscriptionTriggerType

                if trigger.type != SubscriptionTriggerType.EVENT:
                    return (
                        f"Subscription trigger type is {trigger.type}, "
                        f"expected 'event'"
                    )
            if hasattr(trigger, "event") and trigger.event:
                if trigger.event.event_type != SubscriptionEventType.INBOX_MESSAGE:
                    return (
                        f"Subscription event type is {trigger.event.event_type}, "
                        f"expected 'inbox_message'"
                    )

        return None

    def _mark_message_failed(
        self, db: Session, message: QueueMessage, error: str
    ) -> None:
        """Mark a message as failed with error details."""
        message.status = QueueMessageStatus.FAILED
        message.process_error = error
        db.commit()
        logger.warning(
            f"[InboxAutoProcess] Message {message.id} marked as failed: {error}"
        )

    def _build_inbox_context(
        self,
        message: QueueMessage,
        work_queue: Kind,
        event: QueueMessageCreatedEvent,
    ) -> str:
        """Build standardized inbox context for subscription prompt."""
        spec = work_queue.json.get("spec", {})

        context = {
            "trigger": {
                "source": "inbox",
                "event": "message.created",
            },
            "queue": {
                "id": work_queue.id,
                "name": work_queue.name,
                "displayName": spec.get("displayName", work_queue.name),
            },
            "message": {
                "id": message.id,
                "status": "processing",
                "priority": (
                    message.priority.value
                    if hasattr(message.priority, "value")
                    else str(message.priority)
                ),
                "note": message.note or "",
                "createdAt": (
                    message.created_at.isoformat() if message.created_at else None
                ),
            },
            "sender": {
                "id": event.sender_user_id,
            },
            "contentSnapshot": message.content_snapshot or [],
            "executionContext": {
                "triggeredBy": "auto_process",
                "retryCount": message.retry_count,
            },
        }

        return json.dumps(context, ensure_ascii=False, default=str)

    def _dispatch_execution(
        self,
        db: Session,
        subscription: Kind,
        message: QueueMessage,
        inbox_context: str,
    ) -> None:
        """Create BackgroundExecution and dispatch it."""
        from app.services.subscription.execution import background_execution_manager
        from app.services.subscription.service import subscription_service

        # Create execution with inbox_message_id
        execution = background_execution_manager.create_execution(
            db,
            subscription=subscription,
            user_id=subscription.user_id,
            trigger_type="inbox_message",
            trigger_reason=f"Auto-process inbox message #{message.id}",
            extra_variables={"inbox_message": inbox_context},
            inbox_message_id=message.id,
        )

        # Dispatch for async processing
        subscription_service.dispatch_background_execution(subscription, execution)


# Singleton instance
inbox_auto_process_handler = InboxAutoProcessHandler()


async def handle_inbox_message_created(event: QueueMessageCreatedEvent) -> None:
    """Global handler function for QueueMessageCreatedEvent."""
    await inbox_auto_process_handler.on_message_created(event)
