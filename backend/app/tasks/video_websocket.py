# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket emitters used by synchronous video Celery workers."""

import json
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


def emit_chat_event_from_celery(
    event_name: str,
    payload: dict[str, Any],
    task_id: int,
) -> None:
    """Publish a Socket.IO event through Redis."""
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL, decode_responses=False)
        client.publish(
            "socketio",
            json.dumps(
                {
                    "method": "emit",
                    "event": event_name,
                    "data": [payload],
                    "namespace": "/chat",
                    "room": f"task:{task_id}",
                }
            ),
        )
        client.close()
    except Exception:
        logger.exception(
            "[video_websocket] Failed to publish %s for task %s",
            event_name,
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
