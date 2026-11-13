"""Personal task intent is persisted with its assignment before assistants poll."""

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.schemas.delivery import LoopItemCreate, LoopItemResponse
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import _make_project


def test_personal_task_intent_is_bound_to_its_initial_assignment(test_db, test_user):
    project = _make_project(test_db, test_user)
    with patch("app.core.async_utils.schedule_async_task"):
        item = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="My task",
                assignee_user_id=test_user.id,
                notify_assignee=False,
                personal_task=True,
            ),
        )
    metadata = item.metadata_json
    assert (
        metadata["personal_task_assignment_at"]
        == metadata["assignment_history"][-1]["at"]
    )
    projected = loop_item_service.response_values(test_db, item, test_user.id)
    assert (
        LoopItemResponse.model_validate(projected).personal_task_assignment_at
        == metadata["personal_task_assignment_at"]
    )


def test_personal_task_intent_cannot_disable_assistance_for_another_owner(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    with pytest.raises(HTTPException) as failure:
        loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Other owner's task",
                assignee_user_id=None,
                personal_task=True,
            ),
            assign_creator_if_unassigned=False,
        )
    assert failure.value.status_code == 422
