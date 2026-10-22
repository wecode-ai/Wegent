# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.project_chat.service import project_chat_service


def activity(
    project: CloudProject, item: LoopItem, metadata: dict[str, Any], agent: str
) -> ProjectChatMessage:
    identity = str(uuid4())
    return ProjectChatMessage(
        message_id=identity,
        client_message_id=identity,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=agent,
        sender_name=agent,
        message_type="text",
        content="Result",
        metadata_json=metadata,
        agent_id=agent,
        status="completed",
    )


@pytest.mark.parametrize(
    "other_status,human,reassigned,newer_round",
    [
        ("completed", False, False, False),
        ("running", False, False, False),
        ("failed", False, False, False),
        ("completed", True, False, False),
        ("completed", False, True, False),
        ("completed", False, False, True),
    ],
)
def test_member_results_wait_for_explicit_manager_decision(
    test_db: Session,
    test_user: User,
    other_status: str,
    human: bool,
    reassigned: bool,
    newer_round: bool,
) -> None:
    identity = uuid4().hex
    project = CloudProject(
        public_id=identity,
        project_key=identity[:12],
        name="Agent handoff",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{identity}",
        metadata_json={},
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        id=f"{identity}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Work",
        description="",
        status="in_progress",
        priority="none",
        created_by_user_id=test_user.id,
        assignee_agent_id="another-owner" if reassigned else "worker-1",
        metadata_json={},
    )
    test_db.add(item)
    test_db.flush()
    metadata = {"dispatch_id": "dispatch", "coordination_round_id": "round"}
    manager = activity(
        project,
        item,
        {
            **metadata,
            "activity_type": "manager_assignment",
            "dispatch_assignments": [
                {
                    "assignee_type": "agent",
                    "agent_id": "worker-1",
                    "status": "completed",
                },
                {
                    "assignee_type": "human" if human else "agent",
                    "agent_id": "worker-2",
                    "status": other_status,
                },
            ],
        },
        "manager",
    )
    member = activity(
        project, item, {**metadata, "dispatch_role": "member"}, "worker-2"
    )
    test_db.add_all([manager, member])
    test_db.commit()
    if newer_round:
        next_assignment = activity(
            project,
            item,
            {
                **manager.metadata_json,
                "coordination_round_id": "newer-round",
            },
            "manager",
        )
        test_db.add(next_assignment)
        test_db.commit()

    project_chat_service._advance_task_to_review(test_db, member)
    test_db.commit()

    assert item.status == "in_progress"
    assert item.assignee_agent_id == ("another-owner" if reassigned else "worker-1")
    assert test_db.query(ProjectChatMessage).filter_by(
        task_id=item.id
    ).count() == 2 + int(newer_round)
    version = item.version
    project_chat_service._advance_task_to_review(test_db, member)
    assert item.version == version
