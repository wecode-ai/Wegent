# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Replacing a group owner leaves a consistent stage-assignee projection."""

from copy import deepcopy

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.delivery import LoopItemUpdate
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import (
    _make_bot,
    _make_item,
    _make_project,
)
from tests.utils.agent_resources import create_runnable_wegent_team
from tests.utils.collaboration import authorize_resource


@pytest.fixture(autouse=True)
def isolate_notification_delivery(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_args: None)


@pytest.mark.parametrize("target_type", ["user", "agent", "team"])
def test_replacing_group_owner_can_enter_the_stage_required_by_its_new_owner(
    test_db: Session, test_user: User, target_type: str
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    if target_type == "user":
        target_id = str(test_user.id)
    elif target_type == "agent":
        target_id = _make_bot(test_db, project, test_user).id
    else:
        team = create_runnable_wegent_team(
            test_db, user_id=test_user.id, name_prefix="stage-owner"
        )
        authorize_resource(test_db, project, team)
        _make_bot(test_db, project, test_user, runtime="wegent", wegent_team_id=team.id)
        target_id = str(team.id)
    item.metadata_json = {
        "collaboration_group": {"id": "old-group", "name": "Review group"},
        "collaboration_group_assignment_key": "old-group-assignment",
        "workflow": {
            "current_stage_id": "review",
            "nodes": [
                {"id": "review", "name": "Review"},
                {
                    "id": "build",
                    "name": "Build",
                    "required_assignee_type": target_type,
                    "required_assignee_id": target_id,
                },
            ],
        },
    }
    test_db.commit()

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type=target_type,
            assignee_id=target_id,
            notify_assignee=False,
        ),
    )
    workflow = deepcopy(assigned.metadata_json["workflow"])
    workflow["current_stage_id"] = "build"
    updated = loop_item_service.update(
        test_db,
        assigned.id,
        test_user.id,
        LoopItemUpdate(version=assigned.version, workflow=workflow),
    )

    assert updated.metadata_json["workflow"]["current_stage_id"] == "build"
    assert "collaboration_group" not in updated.metadata_json
    assert "collaboration_group_assignment_key" not in updated.metadata_json
    assert str(getattr(updated, f"assignee_{target_type}_id")) == target_id
