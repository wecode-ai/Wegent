# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Cross-process Socket.IO pushes for persisted project comments."""

import logging
import os
import threading
from typing import Any

import socketio

from app.core.config import settings

logger = logging.getLogger(__name__)

_manager_lock = threading.Lock()
_manager_pid: int | None = None
_manager: socketio.RedisManager | None = None


def _publish_manager() -> socketio.RedisManager:
    """Return one write-only Redis manager per backend/Celery process."""

    global _manager, _manager_pid
    process_id = os.getpid()
    if _manager is not None and _manager_pid == process_id:
        return _manager
    with _manager_lock:
        if _manager is None or _manager_pid != process_id:
            _manager = socketio.RedisManager(
                settings.REDIS_URL,
                write_only=True,
            )
            _manager_pid = process_id
    return _manager


def push_project_chat_message(message: dict[str, Any]) -> None:
    """Push a persisted project message from API or Celery processes.

    Socket.IO's Redis manager is the transport boundary. Publishing through a
    write-only manager avoids depending on the uvicorn event loop, so a Wegent
    Chat completion inside Celery reaches the same subscribed room immediately.
    """

    try:
        from app.api.ws.wework_runtime_namespace import (
            PROJECT_CHAT_CREATED_EVENT,
            WEWORK_RUNTIME_NAMESPACE,
            project_chat_room,
        )

        project_id = str(message["projectId"])
        task_id = message.get("taskId")
        _publish_manager().emit(
            PROJECT_CHAT_CREATED_EVENT,
            message,
            room=project_chat_room(project_id, str(task_id) if task_id else None),
            namespace=WEWORK_RUNTIME_NAMESPACE,
        )
    except Exception:
        logger.exception("[ProjectChat] Server message push failed")
