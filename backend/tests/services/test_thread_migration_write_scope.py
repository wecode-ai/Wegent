"""A cached Project authority cannot authorize writes after a Thread moves."""

import pytest
from fastapi import HTTPException
from sqlalchemy import update

from app.models.delivery import LoopItem
from app.services.cloud_projects.access import IssueAction
from app.services.loop_items.service import loop_item_service
from tests.services.test_project_board_snapshot_queries import _project
from tests.services.test_thread_participation import make_group, person


@pytest.mark.parametrize(
    "action",
    [
        IssueAction.COMMENT,
        IssueAction.EDIT_CONTENT,
        IssueAction.EXECUTE,
        None,
    ],
)
def test_cached_source_scope_cannot_authorize_rehomed_thread(
    test_db, test_user, action
):
    source, _ = _project(test_db, test_user.id, 0)
    owner = person(test_db, "migration-target-owner")
    group = make_group(test_db, owner, [])
    item = LoopItem(
        id="LEGACY-MOVE-1",
        cloud_project_id=source,
        title="Rehomed",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.commit()
    test_db.refresh(item)
    test_db.execute(
        update(LoopItem)
        .where(LoopItem.id == item.id)
        .values(
            cloud_project_id=group.id,
        )
        .execution_options(synchronize_session=False)
    )
    assert item.cloud_project_id == source
    with pytest.raises(HTTPException) as denied:
        loop_item_service._require_item_access(
            test_db,
            item,
            test_user.id,
            action=action,
            write=True,
        )
    assert denied.value.status_code == 404


def test_execution_admission_rechecks_cached_source_owner(test_db, test_user):
    from app.services.loop_item_executions.service import loop_item_execution_service
    from tests.services.test_loop_item_executions import (
        _make_bot,
        _make_item,
        _make_project,
    )

    source = _make_project(test_db, test_user)
    agent = _make_bot(test_db, source, test_user)
    item = _make_item(test_db, source, test_user)
    owner = person(test_db, "migration-admission-target-owner")
    group = make_group(test_db, owner, [])
    test_db.flush()
    values = dict(
        loop_item_id=item.id,
        cloud_project_id=str(source.id),
        agent=agent,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id=None,
        priority="medium",
    )
    trial = test_db.begin_nested()
    valid = loop_item_execution_service.enqueue_for_assignment(test_db, **values)
    assert valid.cloud_project_id == str(source.id)
    trial.rollback()
    test_db.refresh(item)
    test_db.execute(
        update(LoopItem)
        .where(LoopItem.id == item.id)
        .values(
            cloud_project_id=group.id,
        )
        .execution_options(synchronize_session=False)
    )
    assert item.cloud_project_id == source.id
    with pytest.raises(HTTPException) as denied:
        loop_item_execution_service.enqueue_for_assignment(test_db, **values)
    assert denied.value.status_code == 404
