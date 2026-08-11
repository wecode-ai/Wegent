# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Per-task kanban status transition history for cloud projects.

Board status columns are user-customizable (``board_config.statuses``), so
each entry snapshots both the status id and its display name; a later rename
never rewrites history. Every cloud project records transitions; local
project spaces route to the executor and never touch the backend LoopItem
store.
"""

from datetime import datetime, timezone
from typing import Any

from app.models.delivery import CloudProject
from app.schemas.cloud_project import default_board_statuses

STATUS_HISTORY_KEY = "status_history"
STATUS_HISTORY_TRIGGERS = frozenset(
    {
        "create",
        "user_update",
        "ai_started",
        "ai_completed",
        "task_started",
        "delivery",
        "status_removed",
    }
)


def _status_id(entry: object) -> object:
    return entry.get("id") if isinstance(entry, dict) else getattr(entry, "id", None)


def _status_name(entry: object) -> str:
    name = entry.get("name") if isinstance(entry, dict) else getattr(entry, "name", "")
    return name if isinstance(name, str) else ""


def status_name(project: CloudProject, status_id: str) -> str:
    """Display name for a status id; falls back to the default board statuses.

    A legacy project without an explicit ``board_config`` still recognizes the
    five default status ids, mirroring ``_project_status_ids``.
    """
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    board_config = metadata.get("board_config")
    statuses = (
        board_config.get("statuses")
        if isinstance(board_config, dict)
        and isinstance(board_config.get("statuses"), list)
        else None
    )
    if statuses is None:
        statuses = default_board_statuses()
    for entry in statuses:
        if _status_id(entry) == status_id:
            return _status_name(entry)
    return ""


def write_status_change(
    metadata: dict[str, Any],
    *,
    from_status: str,
    to_status: str,
    from_status_name: str,
    to_status_name: str,
    trigger: str,
    by_user_id: int | None,
) -> None:
    """Append one transition to ``metadata["status_history"]`` in place."""
    current = metadata.get(STATUS_HISTORY_KEY)
    # Always build a fresh list: callers shallow-copy the committed metadata,
    # so appending in place would mutate the committed list and leave the new
    # metadata content-equal to it, which SQLAlchemy then skips on flush.
    history = list(current) if isinstance(current, list) else []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    history.append(
        {
            "from_status": from_status,
            "from_status_name": from_status_name,
            "to_status": to_status,
            "to_status_name": to_status_name,
            "trigger": trigger,
            "by_user_id": by_user_id,
            "at": now.isoformat(),
        }
    )
    metadata[STATUS_HISTORY_KEY] = history
