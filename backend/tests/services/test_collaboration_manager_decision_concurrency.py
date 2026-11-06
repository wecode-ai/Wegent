# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Manager decisions commit their Issue state and dispatch completion together."""

from typing import Any
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.services.collaboration_manager_decisions import (
    apply_collaboration_manager_decision,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import _collaboration_group, _make_project

ManagerDispatch = tuple[CloudProject, LoopItem, ProjectChatAgent, LoopItemExecution]


@pytest.fixture
def manager_dispatch(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> ManagerDispatch:
    """Create a claimed manager dispatch with a real runtime activity binding."""
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *args: None)
    monkeypatch.setattr(
        "app.services.collaboration_manager_decisions.push_project_chat_message",
        lambda *args: None,
    )
    project = _make_project(test_db, test_user)
    group, manager, _ = _collaboration_group(test_db, project, test_user)
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        issue = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Concurrent review", assignee_group_id=str(group["id"])
            ),
        )
    dispatch = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .one()
    )
    dispatch.status = "claimed"
    dispatch.version = 3
    dispatch.runtime_device_id = manager.device_id
    dispatch.runtime_task_id = f"codex-queue-{dispatch.id}"
    test_db.commit()
    return project, issue, manager, dispatch


def _decide(
    db: Session,
    user: User,
    project: CloudProject,
    issue: LoopItem,
    manager: ProjectChatAgent,
    dispatch: LoopItemExecution,
) -> None:
    """Submit the same manager review decision for initial and recovery calls."""
    apply_collaboration_manager_decision(
        db,
        project_id=project.id,
        item_id=issue.id,
        user_id=user.id,
        dispatch_id=dispatch.runtime_origin_context["dispatch_id"],
        manager_agent_id=manager.id,
        idempotency_key="review-concurrent-work",
        target_status="in_review",
        reason="All member outcomes are complete",
        comment="Ready for human review",
    )


def test_manager_decision_refreshes_a_stale_dispatch_version(
    test_db: Session, test_user: User, manager_dispatch: ManagerDispatch
) -> None:
    """Complete the dispatch even when the session retained an older version."""
    project, issue, manager, dispatch = manager_dispatch
    stale_version = dispatch.version
    test_db.query(LoopItemExecution).filter_by(id=dispatch.id).update(
        {LoopItemExecution.version: stale_version + 1}, synchronize_session=False
    )
    assert dispatch.version == stale_version

    _decide(test_db, test_user, project, issue, manager, dispatch)

    test_db.expire_all()
    assert test_db.get(LoopItemExecution, dispatch.id).status == "completed"
    assert test_db.get(LoopItem, issue.id).status == "in_review"


def test_manager_decision_rolls_back_if_dispatch_completion_loses_its_version(
    test_db: Session,
    test_user: User,
    manager_dispatch: ManagerDispatch,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Roll back a lost completion without consuming the decision's retry key."""
    project, issue, manager, dispatch = manager_dispatch
    previous_status = issue.status
    complete = loop_item_execution_service.complete

    def advance_version_before_completion(
        db: Session, **kwargs: Any
    ) -> LoopItemExecution | None:
        """Force a version conflict through the real terminal transition logic."""
        db.query(LoopItemExecution).filter_by(id=dispatch.id).update(
            {LoopItemExecution.version: LoopItemExecution.version + 1},
            synchronize_session=False,
        )
        return complete(db, **kwargs)

    monkeypatch.setattr(
        loop_item_execution_service, "complete", advance_version_before_completion
    )
    with Session(
        bind=test_db.get_bind(), join_transaction_mode="create_savepoint"
    ) as decision_db:
        with pytest.raises(HTTPException) as caught:
            _decide(decision_db, test_user, project, issue, manager, dispatch)
        assert caught.value.status_code == 409
        assert (
            caught.value.detail
            == "Collaboration dispatch changed during manager decision"
        )

    test_db.expire_all()
    assert test_db.get(LoopItemExecution, dispatch.id).status == "claimed"
    assert test_db.get(LoopItem, issue.id).status == previous_status
    assert not any(
        message.metadata_json.get("activity_type") == "manager_status_comment"
        for message in test_db.query(ProjectChatMessage)
        .filter_by(task_id=issue.id)
        .all()
    )

    monkeypatch.setattr(loop_item_execution_service, "complete", complete)
    _decide(test_db, test_user, project, issue, manager, dispatch)
    test_db.expire_all()
    assert test_db.get(LoopItemExecution, dispatch.id).status == "completed"
    assert test_db.get(LoopItem, issue.id).status == "in_review"
    assert (
        sum(
            message.metadata_json.get("activity_type") == "manager_status_comment"
            for message in test_db.query(ProjectChatMessage)
            .filter_by(task_id=issue.id)
            .all()
        )
        == 1
    )
