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


def project_board_statuses(project: CloudProject) -> list[tuple[str, str]]:
    """(id, name) pairs of the project's board columns, defaults when unset.

    A legacy project without an explicit ``board_config`` still recognizes the
    five default status ids, mirroring ``default_board_statuses``.
    """
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    board_config = metadata.get("board_config")
    raw = (
        board_config.get("statuses")
        if isinstance(board_config, dict)
        and isinstance(board_config.get("statuses"), list)
        else None
    )
    if raw is None:
        return [(status.id, status.name) for status in default_board_statuses()]
    return [
        (str(entry["id"]), str(entry.get("name") or ""))
        for entry in raw
        if isinstance(entry, dict) and entry.get("id")
    ]


def status_name(project: CloudProject, status_id: str) -> str:
    """Display name for a status id; empty when the id is not on the board."""
    for entry_id, entry_name in project_board_statuses(project):
        if entry_id == status_id:
            return entry_name
    return ""


def write_status_change(
    metadata: dict[str, Any],
    *,
    project: CloudProject,
    from_status: str,
    to_status: str,
    trigger: str,
    by_user_id: int | None,
) -> None:
    """Append one transition to ``metadata["status_history"]`` in place."""
    current = metadata.get(STATUS_HISTORY_KEY)
    # Always build a fresh list: callers shallow-copy the committed metadata,
    # so appending in place would mutate the committed list and leave the new
    # metadata content-equal to it, which SQLAlchemy then skips on flush.
    history = list(current) if isinstance(current, list) else []
    now = datetime.now(timezone.utc)
    history.append(
        {
            "from_status": from_status,
            "from_status_name": (
                status_name(project, from_status) if from_status else ""
            ),
            "to_status": to_status,
            "to_status_name": status_name(project, to_status) if to_status else "",
            "trigger": trigger,
            "by_user_id": by_user_id,
            "at": now.isoformat(),
        }
    )
    metadata[STATUS_HISTORY_KEY] = history
