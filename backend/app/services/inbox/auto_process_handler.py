"""Inbox auto-process handler for triggering subscriptions on message arrival."""

import json
import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.events import QueueMessageCreatedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.schemas.subscription import SubscriptionEventType
from app.schemas.work_queue import AutoProcessConfig, SubscriptionRef
from app.services.chat.storage.db import run_sync_in_executor
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
            f"message_id={event.message_id}, queue_id={event.queue_id}, "
            f"recipient_user_id={event.recipient_user_id}, "
            f"sender_user_id={event.sender_user_id}"
        )

        try:
            auto_process = await run_sync_in_executor(
                self._load_auto_process_config_sync,
                event,
            )
            if auto_process is None:
                return
            if auto_process.mode == "direct_agent":
                from app.services.inbox.direct_agent_handler import (
                    inbox_direct_agent_handler,
                )

                await inbox_direct_agent_handler.handle(event, auto_process)
                return
            await run_sync_in_executor(
                self._process_subscription_sync,
                event,
                auto_process,
            )
        except Exception as e:
            logger.error(
                f"[InboxAutoProcess] Failed to process message "
                f"{event.message_id}: {e}",
                exc_info=True,
            )
            try:
                await run_sync_in_executor(
                    self._mark_processing_failed_sync,
                    event.message_id,
                    str(e),
                )
            except Exception:
                logger.error(
                    f"[InboxAutoProcess] Failed to mark message "
                    f"{event.message_id} as FAILED after error",
                    exc_info=True,
                )

    def _load_auto_process_config_sync(
        self,
        event: QueueMessageCreatedEvent,
    ) -> Optional[AutoProcessConfig]:
        """Load and validate queue routing state in a worker-owned session."""
        with get_db_session() as db:
            work_queue = (
                db.query(Kind)
                .filter(
                    Kind.id == event.queue_id,
                    Kind.kind == "WorkQueue",
                    Kind.is_active == True,
                )
                .first()
            )
            message = (
                db.query(QueueMessage)
                .filter(QueueMessage.id == event.message_id)
                .first()
            )
            if not work_queue or not message:
                return None
            if message.status in (
                QueueMessageStatus.PROCESSING,
                QueueMessageStatus.PROCESSED,
            ):
                return None
            auto_process_data = (work_queue.json.get("spec") or {}).get("autoProcess")
            if not auto_process_data:
                return None
            try:
                auto_process = AutoProcessConfig.model_validate(auto_process_data)
            except Exception as exc:
                logger.warning(
                    "[InboxAutoProcess] Invalid autoProcess config for queue %s: %s",
                    event.queue_id,
                    exc,
                )
                return None
            if not auto_process.enabled:
                return None
            if auto_process.mode != "direct_agent" and (
                auto_process.triggerMode != TriggerMode.IMMEDIATE
            ):
                return None
            return auto_process

    def _process_subscription_sync(
        self,
        event: QueueMessageCreatedEvent,
        auto_process: AutoProcessConfig,
    ) -> None:
        """Create and dispatch a subscription execution outside the event loop."""
        with get_db_session() as db:
            work_queue = (
                db.query(Kind)
                .filter(
                    Kind.id == event.queue_id,
                    Kind.kind == "WorkQueue",
                    Kind.is_active == True,
                )
                .first()
            )
            message = (
                db.query(QueueMessage)
                .filter(QueueMessage.id == event.message_id)
                .first()
            )
            if not work_queue or not message:
                return
            if message.status in (
                QueueMessageStatus.PROCESSING,
                QueueMessageStatus.PROCESSED,
            ):
                return
            if not auto_process.subscriptionRef:
                return
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
            error = self._validate_subscription(subscription)
            if error:
                self._mark_message_failed(db, message, error)
                return
            message.status = QueueMessageStatus.PROCESSING
            message.process_subscription_id = subscription.id
            db.commit()
            inbox_context = self._build_inbox_context(
                message,
                work_queue,
                event,
                db,
            )
            try:
                self._dispatch_execution(db, subscription, message, inbox_context)
            except Exception as exc:
                message.status = QueueMessageStatus.FAILED
                message.process_result = {"error": f"Dispatch failed: {exc}"}
                db.commit()
                raise

    def _mark_processing_failed_sync(self, message_id: int, error: str) -> None:
        """Fail a partially processed message in a fresh session."""
        with get_db_session() as db:
            message = (
                db.query(QueueMessage).filter(QueueMessage.id == message_id).first()
            )
            if message and message.status == QueueMessageStatus.PROCESSING:
                message.status = QueueMessageStatus.FAILED
                message.process_result = {"error": f"Processing failed: {error}"}
                db.commit()

    def _resolve_subscription(
        self,
        db: Session,
        ref: SubscriptionRef,
        queue_owner_user_id: int,
    ) -> Optional[Kind]:
        """Resolve subscription by reference triple.

        Uses queue_owner_user_id instead of ref.userId to prevent
        clients from referencing another user's subscriptions.
        """
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Subscription",
                Kind.namespace == ref.namespace,
                Kind.name == ref.name,
                Kind.user_id == queue_owner_user_id,
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
        message.process_result = {"error": error}
        db.commit()
        logger.warning(
            f"[InboxAutoProcess] Message {message.id} marked as failed: {error}"
        )

    def _pre_write_content_as_attachment(
        self,
        message: QueueMessage,
        user_id: int,
    ) -> List[int]:
        """Pre-write message text content to subtask_contexts as a .md attachment.

        This allows the LLM to reference content by attachment_id instead of
        re-outputting the full text through the model output window.

        Returns:
            List of attachment context IDs (text content first, then existing file IDs
            stored in each USER message's attachmentContextIds field).
        """
        from app.services.context.context_service import context_service

        attachment_ids: List[int] = []

        # Pre-write text content from content_snapshot as a .md attachment
        content_snapshot = message.content_snapshot or []
        text_parts = [
            snap.get("content", "")
            for snap in content_snapshot
            if snap.get("content", "").strip()
        ]
        combined_text = "\n\n---\n\n".join(text_parts)

        if combined_text.strip():
            try:
                with get_db_session() as db:
                    ctx, _ = context_service.upload_attachment(
                        db=db,
                        user_id=user_id,
                        filename=f"inbox_message_{message.id}.md",
                        binary_data=combined_text.encode("utf-8"),
                        subtask_id=0,
                    )
                    attachment_ids.append(ctx.id)
                    logger.info(
                        f"[InboxAutoProcess] Pre-wrote message {message.id} text "
                        f"as attachment context {ctx.id} ({len(combined_text)} chars)"
                    )
            except Exception as e:
                logger.warning(
                    f"[InboxAutoProcess] Failed to pre-write text content for "
                    f"message {message.id}: {e}"
                )

        # Collect pre-existing file attachment IDs stored in each USER message's
        # attachmentContextIds field (written by ingest_message when files are uploaded).
        for snap in content_snapshot:
            existing_ids = snap.get("attachmentContextIds") or []
            attachment_ids.extend(existing_ids)

        return attachment_ids

    def _build_inbox_context(
        self,
        message: QueueMessage,
        work_queue: Kind,
        event: QueueMessageCreatedEvent,
        db: Session,
    ) -> str:
        """Build standardized inbox context for subscription prompt.

        Pre-writes message content to subtask_contexts so the LLM can use
        create_document(source_type='attachment', attachment_id=...) without
        re-outputting the full content through the model output window.

        Also persists all attachment IDs (text pre-write + uploaded files) back
        into the first USER message's attachmentContextIds field inside
        content_snapshot so that _link_inbox_attachments_to_subtask() can
        retrieve them when the subscription task executes.
        """
        spec = work_queue.json.get("spec", {})

        # Pre-write content as attachment and collect all attachment IDs
        content_attachment_ids = self._pre_write_content_as_attachment(
            message=message,
            user_id=work_queue.user_id,
        )

        # Persist all attachment IDs back into the first USER message's
        # attachmentContextIds field so the subscription task can retrieve them
        # via content_snapshot without a separate DB column.
        if content_attachment_ids:
            snapshot = list(message.content_snapshot or [])
            injected = False
            for i, snap in enumerate(snapshot):
                if snap.get("role", "").upper() == "USER":
                    snap_copy = dict(snap)
                    snap_copy["attachmentContextIds"] = content_attachment_ids
                    snapshot[i] = snap_copy
                    injected = True
                    break
            if not injected and snapshot:
                # Fallback: inject into first message if no USER message found
                snap_copy = dict(snapshot[0])
                snap_copy["attachmentContextIds"] = content_attachment_ids
                snapshot[0] = snap_copy
            message.content_snapshot = snapshot
            db.commit()

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
            # Pre-written attachment IDs for LLM to use with create_document.
            # Use create_document(source_type='attachment', attachment_id=<id>)
            # to save content to knowledge base WITHOUT re-outputting it.
            "contentAttachmentIds": content_attachment_ids,
            "executionContext": {
                "triggeredBy": "auto_process",
                "retryCount": (message.process_result or {}).get("retry_count", 0),
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
