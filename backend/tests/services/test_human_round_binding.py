"""Incomplete persisted manager plans must not expose a stale human binding."""

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.collaboration_human_assignments import _round_human_task_binding
from tests.services.test_project_chat_execution_snapshot import run


@pytest.mark.parametrize(
    "metadata",
    [
        None,
        [],
        "legacy",
        {},
        {"activity_type": "manager_assignment", "dispatch_assignments": None},
        {
            "activity_type": "manager_assignment",
            "dispatch_assignments": {"invalid": True},
        },
    ],
)
def test_unstructured_metadata_has_no_round_binding(
    test_db: Session,
    run: tuple[CloudProject, LoopItem, ProjectChatMessage],
    metadata: Any,
) -> None:
    _, item, row = run
    row.metadata_json = metadata
    test_db.commit()
    assert _round_human_task_binding(test_db, item) is None


@pytest.mark.parametrize(
    "missing",
    [
        None,
        "human_assignment_id",
        "assignment_id",
        "dispatch_id",
        "coordination_round_id",
    ],
)
def test_round_binding_requires_complete_human_identity(
    test_db: Session,
    test_user: User,
    run: tuple[CloudProject, LoopItem, ProjectChatMessage],
    missing: str | None,
) -> None:
    _, item, row = run
    item.assignee_user_id = test_user.id
    assignment = {
        "assignee_type": "human",
        "human_user_id": str(test_user.id),
        "human_assignment_id": "human-1",
        "assignment_id": "member-1",
    }
    metadata = {
        "activity_type": "manager_assignment",
        "dispatch_id": "dispatch-1",
        "coordination_round_id": "round-1",
        "dispatch_assignments": [None, "invalid", assignment],
    }
    if missing in assignment:
        assignment.pop(missing)
    elif missing:
        metadata.pop(missing)
    row.metadata_json = metadata
    test_db.commit()
    binding = _round_human_task_binding(test_db, item)
    assert binding == (
        None
        if missing
        else {
            "humanAssignmentId": "human-1",
            "assignmentId": "member-1",
            "dispatchId": "dispatch-1",
            "dispatchRoundId": "round-1",
        }
    )
