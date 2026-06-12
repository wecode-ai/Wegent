# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist standalone chat workspace metadata on task resources."""

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.stores.tasks import task_store

logger = logging.getLogger(__name__)

WORKSPACE_PATH_RESULT_KEY = "standalone_chat_workspace_path"
WORKSPACE_PATH_LABEL = "standaloneChatWorkspacePath"
WORKSPACE_SOURCE_LABEL = "standaloneChatWorkspaceSource"


def extract_workspace_path(result: Optional[dict[str, Any]]) -> Optional[str]:
    """Return the standalone chat workspace path from a terminal result."""

    if not isinstance(result, dict):
        return None
    path = result.get(WORKSPACE_PATH_RESULT_KEY)
    if not isinstance(path, str):
        return None
    path = path.strip()
    return path or None


def persist_standalone_workspace_path(
    db: Session,
    *,
    task_id: int,
    workspace_path: str,
) -> bool:
    """Store the standalone chat workspace path in task metadata labels."""

    task = task_store.get_active_task(db, task_id=task_id)
    if not task:
        logger.warning(
            "[StandaloneWorkspace] Task %s not found while persisting workspace path",
            task_id,
        )
        return False

    task_json = dict(task.json or {})
    metadata = dict(task_json.get("metadata") or {})
    labels = dict(metadata.get("labels") or {})
    if labels.get(WORKSPACE_PATH_LABEL) == workspace_path:
        return False

    labels[WORKSPACE_PATH_LABEL] = workspace_path
    labels[WORKSPACE_SOURCE_LABEL] = "local_path"
    metadata["labels"] = labels
    task_json["metadata"] = metadata
    task_store.update_json(db, task=task, payload=task_json)
    db.commit()
    logger.info(
        "[StandaloneWorkspace] Persisted workspace path for task %s: %s",
        task_id,
        workspace_path,
    )
    return True
