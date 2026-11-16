"""History attributes automation operations without changing authorization actors."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import ProjectAutomationRule, ProjectAutomationRun
from app.models.user import User
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.issue_assignment import IssueAssignmentResponse
from app.schemas.project_chat import LoopItemAssign
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import project_automation_execution
from tests.services.test_loop_item_assignment import (
    _active_execution,
    _make_bot,
    _make_item,
    _make_project,
)


@pytest.mark.parametrize("operation", ["create", "assign", "update"])
def test_automation_history_snapshots_rule_and_preserves_user(
    test_db: Session, test_user: User, operation: str
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="新事项分析",
        created_by_user_id=test_user.id,
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.commit()
    context = project_automation_execution._automation_context(test_db, rule, run)
    expected = {"rule_id": str(rule.id), "rule_name": rule.title, "run_id": str(run.id)}
    with patch("app.core.async_utils.schedule_async_task"):
        if operation == "create":
            item = loop_item_service.create(
                test_db,
                project.id,
                test_user.id,
                LoopItemCreate(title="Automatic work", assignee_agent_id=bot.id),
                automation_context=context,
            )
        elif operation == "assign":
            item = loop_item_service.assign(
                test_db,
                project_id=project.id,
                item_id=item.id,
                user_id=test_user.id,
                values=LoopItemAssign(
                    version=item.version, assignee_type="agent", assignee_id=bot.id
                ),
                automation_context=context,
            )
        else:
            item = loop_item_service.update(
                test_db,
                item.id,
                test_user.id,
                LoopItemUpdate(version=item.version, assignee_agent_id=bot.id),
                automation_context=context,
            )
    test_db.expire_all()
    for key in ("assignment_history", "status_history"):
        entry = item.metadata_json[key][-1]
        assert entry["automation"] == expected
        assert entry["by_user_id"] == test_user.id
    execution = _active_execution(test_db, item)
    assert execution.assigner_user_id == test_user.id
    events = issue_assignment_service.list(
        test_db, project_id=project.id, issue_id=item.id, user_id=test_user.id
    )
    event = next(value for value in events if value.member_id == bot.id)
    response = issue_assignment_service.response_values(test_db, event)
    assert response["automation"] == expected
    assert response["created_by_user_id"] == test_user.id
    assert (
        IssueAssignmentResponse.model_validate(response).model_dump()["automation"]
        == expected
    )
    manual_response = {**response, "automation": None}
    assert (
        "automation"
        not in IssueAssignmentResponse.model_validate(manual_response).model_dump()
    )
    rule.title = "Renamed rule"
    test_db.commit()
    assert item.metadata_json["assignment_history"][-1]["automation"] == expected
    with patch("app.core.async_utils.schedule_async_task"):
        item = loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(version=item.version, status="in_review"),
        )
    assert "automation" not in item.metadata_json["status_history"][-1]
