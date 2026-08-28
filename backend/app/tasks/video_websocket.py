# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket emitters used by synchronous video Celery workers."""

import json
import logging
import time
from typing import Any, Optional

from app.utils.client_payload_sanitizer import sanitize_client_payload

logger = logging.getLogger(__name__)


def _event_log_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Return safe identifiers for tracing one card event."""
    block = payload.get("block")
    if not isinstance(block, dict):
        result = payload.get("result")
        blocks = result.get("blocks") if isinstance(result, dict) else None
        block = blocks[0] if isinstance(blocks, list) and blocks else {}
    preview = block.get("card_preview_data") if isinstance(block, dict) else {}
    direct_preview = payload.get("card_preview_data")
    if isinstance(direct_preview, dict):
        preview = direct_preview
    return {
        "subtask_id": payload.get("subtask_id"),
        "block_id": payload.get("block_id") or block.get("id"),
        "status": payload.get("status") or block.get("status"),
        "card_status": payload.get("card_status") or block.get("card_status"),
        "progress": preview.get("progress") if isinstance(preview, dict) else None,
    }


def emit_chat_event_from_celery(
    event_name: str,
    payload: dict[str, Any],
    task_id: int,
) -> None:
    """Publish a Socket.IO event through Redis."""
    client = None
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL, decode_responses=False)
        sanitized_payload = sanitize_client_payload(payload)
        subscriber_count = client.publish(
            "socketio",
            json.dumps(
                {
                    "method": "emit",
                    "event": event_name,
                    "data": [sanitized_payload],
                    "namespace": "/chat",
                    "room": f"task:{task_id}",
                }
            ),
        )
        context = _event_log_context(sanitized_payload)
        log_method = logger.info if subscriber_count else logger.warning
        log_method(
            "[video_websocket] Published event=%s task_id=%s "
            "subtask_id=%s block_id=%s status=%s card_status=%s "
            "progress=%s redis_subscribers=%s",
            event_name,
            task_id,
            context["subtask_id"],
            context["block_id"],
            context["status"],
            context["card_status"],
            context["progress"],
            subscriber_count,
        )
    except Exception:
        logger.exception(
            "[video_websocket] Failed to publish %s for task %s",
            event_name,
            task_id,
        )
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                logger.debug("[video_websocket] Failed to close Redis client")


def emit_card_created(
    task_id: int,
    subtask_id: int,
    block: dict[str, Any],
) -> None:
    """Emit a public card block created by a workflow."""
    emit_chat_event_from_celery(
        "chat:block_created",
        {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "block": block,
        },
        task_id,
    )


def emit_card_updated(
    task_id: int,
    subtask_id: int,
    block: dict[str, Any],
) -> None:
    """Emit a complete card update through the generic block protocol."""
    emit_chat_event_from_celery(
        "chat:block_updated",
        {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "block_id": block["id"],
            "status": block["status"],
            "card_id": block["card_id"],
            "card_type": block["card_type"],
            "card_status": block["card_status"],
            "card_data": block["card_data"],
            "card_preview_data": block["card_preview_data"],
            "card_error": block["card_error"],
        },
        task_id,
    )


def emit_card_done(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    block: dict[str, Any],
) -> None:
    """Emit a terminal card result."""
    emit_card_updated(task_id=task_id, subtask_id=subtask_id, block=block)
    emit_chat_event_from_celery(
        "chat:done",
        {
            "type": "done",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "offset": 0,
            "result": {"value": "", "blocks": [block]},
        },
        task_id,
    )


def emit_card_error(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    block: dict[str, Any],
) -> None:
    """Emit a terminal card error."""
    emit_card_updated(task_id=task_id, subtask_id=subtask_id, block=block)
    emit_chat_event_from_celery(
        "chat:error",
        {
            "type": "error",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "error": block.get("card_error") or "Video workflow failed",
        },
        task_id,
    )


def emit_card_cancelled(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    block: dict[str, Any],
) -> None:
    """Emit a terminal card cancellation."""
    emit_card_updated(task_id=task_id, subtask_id=subtask_id, block=block)
    emit_chat_event_from_celery(
        "chat:cancelled",
        {
            "type": "cancelled",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
        },
        task_id,
    )


def emit_video_chunk(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    video_block_id: str,
    progress: int,
    status: str,
    message: str = "",
    is_placeholder: bool = True,
) -> None:
    """Emit a video progress block."""
    block = {
        "id": video_block_id,
        "type": "video",
        "status": status,
        "is_placeholder": is_placeholder,
        "video_url": "",
        "video_thumbnail": None,
        "video_duration": None,
        "video_attachment_id": None,
        "video_progress": progress,
        "content": "",
        "timestamp": int(time.time() * 1000),
    }
    emit_chat_event_from_celery(
        "chat:chunk",
        {
            "type": "chunk",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "content": "",
            "offset": 0,
            "result": {"blocks": [block]},
        },
        task_id,
    )


def emit_video_done(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    result_data: dict[str, Any],
) -> None:
    """Emit video completion."""
    emit_chat_event_from_celery(
        "chat:done",
        {
            "type": "done",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "offset": 0,
            "result": result_data,
        },
        task_id,
    )


def emit_video_error(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    video_block_id: str,
    error_message: str,
    progress: int = 0,
) -> None:
    """Emit video failure."""
    emit_video_chunk(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        video_block_id=video_block_id,
        progress=progress,
        status="error",
        is_placeholder=False,
    )
    emit_chat_event_from_celery(
        "chat:error",
        {
            "type": "error",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "error": error_message,
        },
        task_id,
    )


def emit_video_cancelled(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int],
    video_block_id: str,
    progress: int = 0,
) -> None:
    """Emit the final cancelled block and cancellation event."""
    emit_video_chunk(
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        video_block_id=video_block_id,
        progress=progress,
        status="cancelled",
    )
    emit_chat_event_from_celery(
        "chat:cancelled",
        {
            "type": "cancelled",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
        },
        task_id,
    )
