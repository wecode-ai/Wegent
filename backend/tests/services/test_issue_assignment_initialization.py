"""Initial assignments must not lock absent history or index ranges."""

import uuid

import pytest

from app.models.delivery import CloudProject, LoopItemActiveAssignment, LoopItemComment
from app.schemas.delivery import LoopItemCreate
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from tests.utils.collaboration import authorize_project


@pytest.mark.parametrize("explicit_assignee", [False, True])
def test_new_issue_initializes_only_explicit_assignments_without_history_locks(
    test_db, test_user, monkeypatch, explicit_assignee
):
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="INITIAL",
        name="Initial assignment",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    test_db.commit()

    read_history = issue_assignment_service._active_events

    def reject_history_lock(*args, **kwargs):
        if not kwargs.get("for_update"):
            return read_history(*args, **kwargs)
        raise AssertionError("A new Issue has no assignment history or index to lock")

    def reject_index_rebuild(*args, **kwargs):
        raise AssertionError("The initial assignment must insert its index directly")

    monkeypatch.setattr(issue_assignment_service, "_active_events", reject_history_lock)
    monkeypatch.setattr(
        issue_assignment_service, "_refresh_active_index", reject_index_rebuild
    )
    monkeypatch.setattr(
        "app.core.async_utils.schedule_async_task", lambda *args, **kwargs: None
    )

    item = loop_item_service.create(
        test_db,
        int(project.id),
        test_user.id,
        LoopItemCreate(
            title="First assignment",
            assignee_user_id=test_user.id if explicit_assignee else None,
        ),
    )

    assert item.created_by_user_id == item.reporter_user_id == test_user.id
    comments = test_db.query(LoopItemComment).filter_by(loop_item_id=item.id).all()
    index = test_db.query(LoopItemActiveAssignment).filter_by(parent_id=item.id).all()
    if not explicit_assignee:
        assert item.assignee_user_id is None
        assert comments == []
        assert index == []
        return
    assert item.assignee_user_id == test_user.id
    assert len(comments) == 1
    comment = comments[0]
    assert comment.metadata_json["action"] == "assign"
    assert comment.metadata_json["target_id"] == str(test_user.id)
    assert comment.metadata_json["trigger"] == "manual"
    assert len(index) == 2
    assert {row.loop_item_id for row in index} == {None, comment.id}
