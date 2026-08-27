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

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.models.delivery import CloudProject
from app.schemas.cloud_project import CloudProjectBoardConfig, default_board_statuses

STATUS_HISTORY_KEY = "status_history"


@dataclass(frozen=True)
class ProjectStatusTransition:
    previous_status: str
    current_status: str
    processing_start_status_id: str | None
    previous_index: int | None
    current_index: int | None
    processing_start_index: int | None

    @property
    def entered_processing(self) -> bool:
        if self.current_index is None or self.processing_start_index is None:
            return False
        previous_index = self.previous_index
        if previous_index is None:
            return False
        return previous_index < self.processing_start_index <= self.current_index


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


def project_board_config(project: CloudProject) -> CloudProjectBoardConfig:
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    raw = metadata.get("board_config")
    return CloudProjectBoardConfig.model_validate(raw if isinstance(raw, dict) else {})


def project_status_transition(
    project: CloudProject,
    *,
    previous_status: str,
    current_status: str,
) -> ProjectStatusTransition:
    config = project_board_config(project)
    status_ids = [status.id for status in config.statuses]
    indexes = {status_id: index for index, status_id in enumerate(status_ids)}
    boundary = config.processing_start_status_id
    return ProjectStatusTransition(
        previous_status=previous_status,
        current_status=current_status,
        processing_start_status_id=boundary,
        previous_index=indexes.get(previous_status),
        current_index=indexes.get(current_status),
        processing_start_index=indexes.get(boundary) if boundary else None,
    )


def is_processing_status(project: CloudProject, status_id: str) -> bool:
    transition = project_status_transition(
        project,
        previous_status=status_id,
        current_status=status_id,
    )
    return bool(
        transition.current_index is not None
        and transition.processing_start_index is not None
        and transition.current_index >= transition.processing_start_index
    )


def later_project_status(
    project: CloudProject,
    *,
    current_status: str,
    candidate_status: str,
) -> str:
    config = project_board_config(project)
    indexes = {status.id: index for index, status in enumerate(config.statuses)}
    current_index = indexes.get(current_status)
    candidate_index = indexes.get(candidate_status)
    if current_index is None or candidate_index is None:
        return current_status
    return candidate_status if candidate_index > current_index else current_status


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
