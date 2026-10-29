"""Board reads preserve presentation and use a bounded number of SQL queries."""

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    LoopItemTaskBinding,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import CloudProjectAccess
from app.services.collaboration_human_assignments import human_task_bindings
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.loop_items.service import loop_item_service
from app.services.project_board_snapshot import project_board_snapshot_service
from app.services.project_chat.service import project_chat_service
from tests.utils.collaboration import authorize_project


def _project(db: Session, owner_id: int, size: int) -> tuple[str, list[str]]:
    key = uuid.uuid4().hex
    project = CloudProject(
        public_id=key,
        project_key=key[:12],
        name=key,
        created_by_user_id=owner_id,
        storage_prefix=key,
    )
    space = authorize_project(db, project)
    members = [
        User(user_name=f"{key}-{index}", password_hash="unused", is_active=True)
        for index in range(size)
    ]
    db.add_all(members)
    db.flush()
    for member in members:
        db.add(
            ResourceMember.create(
                resource_type="Workspace",
                resource_id=space.id,
                entity_id=str(member.id),
                role="Developer",
                status="approved",
            )
        )
    items = []
    for index, member in enumerate(members):
        item_id = f"{key}-{index}"
        item = LoopItem(
            id=item_id,
            cloud_project_id=project.id,
            created_by_user_id=owner_id,
            title=f"Card {index}",
            description="Preview",
            sequence_number=index + 1,
            status="pending",
            priority="none",
            assignee_user_id=owner_id if index % 2 == 0 else member.id,
            metadata_json={
                "ai_state": {
                    "status": "running",
                    "project_chat_message_id": f"message-{item_id}",
                }
            },
        )
        db.add(item)
        db.flush()
        _item_history(db, item, owner_id, index)
        items.append(item.id)
    project_id = project.id
    db.commit()
    return project_id, items


def _item_history(db: Session, item: LoopItem, owner_id: int, index: int) -> None:
    db.add(
        ProjectChatMessage(
            message_id=f"message-{item.id}",
            project_id=item.cloud_project_id,
            task_id=item.id,
            sender_type="agent",
            sender_id="bot",
            sender_name="Bot",
            message_type="text",
            content="Cached success",
            status="completed",
            metadata_json={},
            created_at=datetime(2026, 10, 1),
            updated_at=datetime(2026, 10, 1),
        )
    )
    db.add(
        LoopItemExecution(
            loop_item_id=item.id,
            cloud_project_id=item.cloud_project_id,
            status="completed",
        )
    )
    db.flush()
    db.add(
        LoopItemExecution(
            loop_item_id=item.id,
            cloud_project_id=item.cloud_project_id,
            status="failed",
            attempt_no=2,
            error_message="Newest failure",
            runtime_device_id="device",
            runtime_task_id=f"runtime-{index}",
        )
    )
    db.add(
        LoopItemComment(
            id=f"assignment-{item.id}",
            loop_item_id=item.id,
            cloud_project_id=item.cloud_project_id,
            created_by_user_id=owner_id,
            metadata_json={
                "event_type": "assignment",
                "action": "assign",
                "target_type": "human",
                "target_id": str(item.assignee_user_id),
                "trigger": "direct",
            },
        )
    )


def _snapshot(db: Session, project_id: str, user_id: int):
    db.expunge_all()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", record)
    try:
        snapshot = project_board_snapshot_service.get(db, project_id, user_id)
    finally:
        event.remove(bind, "before_cursor_execute", record)
    return snapshot, statements


def test_board_query_count_does_not_grow_with_issues_or_members(
    test_db: Session, test_user: User, record_property
) -> None:
    owner_id = test_user.id
    small_id, _ = _project(test_db, owner_id, 2)
    large_id, large_items = _project(test_db, owner_id, 30)

    small, small_queries = _snapshot(test_db, small_id, owner_id)
    large, large_queries = _snapshot(test_db, large_id, owner_id)

    record_property("small_snapshot_queries", len(small_queries))
    record_property("large_snapshot_queries", len(large_queries))
    assert len(small.items) == 2
    assert len(large.items) == 30
    assert len(large.members) == 31
    assert len(large_queries) == len(small_queries), large_queries
    assert len(large_queries) <= 15, large_queries
    assert {item.id for item in large.items} == set(large_items)
    for item in large.items:
        assert item.description == "Preview"
        assert item.execution_state == "failed"
        assert item.execution_attempt_no == 2
        assert item.execution_error == "Newest failure"
        assert item.ai_state["status"] == "failed"
        assert item.ai_state["runtime_device_id"] == "device"
        assert item.assignee_name
        if item.assignee_user_id == owner_id:
            assert item.human_task_binding["assignmentId"] == f"assignment-{item.id}"
        else:
            assert item.human_task_binding is None


def test_batch_projection_preserves_related_issue_visibility(
    test_db: Session, test_user: User
) -> None:
    owner_id = test_user.id
    project_id, item_ids = _project(test_db, owner_id, 3)
    project = test_db.get(CloudProject, project_id)
    member = (
        test_db.query(User)
        .filter(User.user_name.like(f"{project.public_id}-%"))
        .first()
    )
    member_id = member.id
    for item_id in item_ids:
        item = test_db.get(LoopItem, item_id)
        item.metadata_json = {**item.metadata_json, "security_level": "related"}
    own = test_db.get(LoopItem, item_ids[0])
    own.assignee_user_id = member_id
    test_db.commit()

    snapshot, _ = _snapshot(test_db, project_id, member_id)

    assert [item.id for item in snapshot.items] == [item_ids[0]]
    assert snapshot.items[0].can_view_detail is True
    assert snapshot.items[0].description == "Preview"


def test_snapshot_rechecks_access_after_membership_is_revoked(
    test_db: Session, test_user: User
) -> None:
    project_id, _ = _project(test_db, test_user.id, 1)
    project = test_db.get(CloudProject, project_id)
    member = (
        test_db.query(User).filter(User.user_name.like(f"{project.public_id}-%")).one()
    )
    member_id, workspace_id = member.id, project.workspace_id
    snapshot, _ = _snapshot(test_db, project_id, member_id)
    assert len(snapshot.items) == 1
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=workspace_id,
            entity_type="user",
            entity_id=str(member_id),
        )
        .one()
    )
    grant.status = "rejected"
    test_db.commit()

    with pytest.raises(HTTPException) as denied:
        _snapshot(test_db, project_id, member_id)

    assert denied.value.status_code == 404


def test_board_and_page_bindings_only_expose_the_readers_own_tasks(
    test_db: Session, test_user: User
) -> None:
    project_id, item_ids = _project(test_db, test_user.id, 1)
    project = test_db.get(CloudProject, project_id)
    member = (
        test_db.query(User).filter(User.user_name.like(f"{project.public_id}-%")).one()
    )
    for owner_id in [test_user.id, member.id]:
        test_db.add(
            LoopItemTaskBinding(
                id=uuid.uuid4().hex,
                cloud_project_id=project_id,
                loop_item_id=item_ids[0],
                task_user_id=owner_id,
                linked_by_user_id=owner_id,
                device_id=f"device-{owner_id}",
                task_id=f"private-task-{owner_id}",
            )
        )
    test_db.commit()
    for reader_id in [test_user.id, member.id]:
        snapshot, _ = _snapshot(test_db, project_id, reader_id)
        page_bindings = loop_item_service.list_project_task_bindings(
            test_db, project_id, reader_id, item_ids=item_ids
        )
        issue_bindings = loop_item_service.list_task_bindings(
            test_db, item_ids[0], reader_id
        )
        for bindings in [snapshot.task_bindings, page_bindings, issue_bindings]:
            assert [binding.task_user_id for binding in bindings] == [reader_id]
            assert [binding.task_id for binding in bindings] == [
                f"private-task-{reader_id}"
            ]


def test_viewer_snapshot_omits_members_and_runtime_bindings(
    test_db: Session, test_user: User
) -> None:
    owner_id = test_user.id
    project_id, item_ids = _project(test_db, owner_id, 1)
    project = test_db.get(CloudProject, project_id)
    member = (
        test_db.query(User).filter(User.user_name.like(f"{project.public_id}-%")).one()
    )
    member_id = member.id
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=project.workspace_id,
            entity_type="user",
            entity_id=str(member_id),
        )
        .one()
    )
    grant.role = "Viewer"
    test_db.add(
        LoopItemTaskBinding(
            id=uuid.uuid4().hex,
            cloud_project_id=project_id,
            loop_item_id=item_ids[0],
            task_user_id=owner_id,
            linked_by_user_id=owner_id,
            device_id="device",
            task_id="private-task",
        )
    )
    test_db.commit()

    owner, _ = _snapshot(test_db, project_id, owner_id)
    viewer, _ = _snapshot(test_db, project_id, member_id)

    assert len(owner.members) == 2
    assert len(owner.task_bindings) == 1
    assert len(viewer.items) == 1
    assert viewer.members == []
    assert viewer.task_bindings == []
    assert viewer.agents == []


def test_snapshot_authorizes_the_project_once_with_multiple_agents(
    test_db: Session, test_user: User, mocker
) -> None:
    owner_id = test_user.id
    project_id, _ = _project(test_db, owner_id, 2)
    for index in range(2):
        test_db.add(
            ProjectChatAgent(
                id=f"bot-{project_id}-{index}",
                cloud_project_id=project_id,
                name=f"Bot {index}",
                title=f"Bot {index}",
                status="active",
                created_by_user_id=owner_id,
                metadata_json={"runtime": "codex"},
            )
        )
    test_db.commit()
    check = mocker.spy(collaboration_permission_service, "check")

    snapshot, _ = _snapshot(test_db, project_id, owner_id)

    assert len(snapshot.agents) == 2
    assert all(agent.can_use for agent in snapshot.agents)
    check.assert_called_once_with(test_db, owner_id, "read", project_id)


@pytest.mark.parametrize("role", ["Viewer", "Developer", "Maintainer"])
def test_archived_agents_still_require_project_administration(
    test_db: Session, test_user: User, role: str
) -> None:
    owner_id = test_user.id
    project_id, _ = _project(test_db, owner_id, 1)
    project = test_db.get(CloudProject, project_id)
    member = (
        test_db.query(User).filter(User.user_name.like(f"{project.public_id}-%")).one()
    )
    member_id = member.id
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=project.workspace_id,
            entity_type="user",
            entity_id=str(member_id),
        )
        .one()
    )
    grant.role = role
    test_db.add(
        ProjectChatAgent(
            id=f"archived-{project_id}",
            cloud_project_id=project_id,
            name="Archived Bot",
            title="Archived Bot",
            status="archived",
            created_by_user_id=owner_id,
            metadata_json={"runtime": "codex"},
        )
    )
    test_db.commit()

    if role == "Maintainer":
        agents = project_chat_service.list_agents(
            test_db, user_id=member_id, project_id=project_id, include_archived=True
        )
        assert [agent.id for agent in agents] == [f"archived-{project_id}"]
        assert agents[0].can_use is False
    else:
        with pytest.raises(HTTPException) as denied:
            project_chat_service.list_agents(
                test_db, user_id=member_id, project_id=project_id, include_archived=True
            )
        assert denied.value.status_code == 403


def test_batch_projection_keeps_agent_approval_and_team_execution_names(
    test_db: Session, test_user: User
) -> None:
    owner_id = test_user.id
    project_id, item_ids = _project(test_db, owner_id, 2)
    project = test_db.get(CloudProject, project_id)
    agent = ProjectChatAgent(
        id=f"agent-{project_id}",
        cloud_project_id=project_id,
        name="Review Bot",
        title="Review Agent",
        created_by_user_id=owner_id,
    )
    team = Kind(
        kind="Team", namespace="default", name="Build Team", user_id=owner_id, json={}
    )
    test_db.add_all([agent, team])
    test_db.flush()
    items = [test_db.get(LoopItem, item_id) for item_id in item_ids]
    for item in items:
        item.assignee_user_id = None
    items[0].assignee_agent_id = agent.id
    items[1].assignee_team_id = team.id
    test_db.add_all(
        [
            LoopItemExecution(
                loop_item_id=items[0].id,
                cloud_project_id=project_id,
                agent_id=agent.id,
                status="pending_approval",
            ),
            LoopItemExecution(
                loop_item_id=items[1].id,
                cloud_project_id=project_id,
                team_id=team.id,
                status="failed",
            ),
        ]
    )
    test_db.flush()

    values = loop_item_service.response_values_many(
        test_db,
        items,
        owner_id,
        access=CloudProjectAccess(project=project, role=BaseRole.Maintainer),
    )

    assert values[0]["assignee_agent_name"] == "Review Bot"
    assert values[0]["can_approve"] is True
    assert values[0]["ai_state"] is None
    assert values[1]["assignee_team_name"] == "Build Team"
    assert values[1]["ai_state"]["agent_name"] == "Build Team"


def test_batch_human_bindings_use_only_the_latest_round_in_each_project(
    test_db: Session, test_user: User
) -> None:
    owner_id = test_user.id
    project_id, item_ids = _project(test_db, owner_id, 2)
    other_project_id, _ = _project(test_db, owner_id, 1)
    items = [test_db.get(LoopItem, item_id) for item_id in item_ids]
    for index, item in enumerate(items):
        item.assignee_user_id = owner_id
        comment = test_db.get(LoopItemComment, f"assignment-{item.id}")
        comment.metadata_json = {
            **comment.metadata_json,
            "target_id": str(owner_id),
            "trigger": "collaboration_round",
        }
        for revision in range(3):
            test_db.add(
                ProjectChatMessage(
                    message_id=f"round-{item.id}-{revision}",
                    project_id=other_project_id if revision == 2 else project_id,
                    task_id=item.id,
                    sender_type="agent",
                    sender_id="manager",
                    sender_name="Manager",
                    message_type="text",
                    content="Dispatch",
                    created_at=datetime(2026, 10, 2) + timedelta(minutes=revision),
                    metadata_json={
                        "activity_type": "manager_assignment",
                        "dispatch_id": f"dispatch-{revision}",
                        "coordination_round_id": f"round-{revision}",
                        "dispatch_assignments": (
                            [
                                {
                                    "assignee_type": "human",
                                    "human_user_id": owner_id,
                                    "human_assignment_id": f"human-{item.id}-{revision}",
                                    "assignment_id": f"member-{item.id}-{revision}",
                                }
                            ]
                            if not (index == 1 and revision == 1)
                            else []
                        ),
                    },
                )
            )
    test_db.flush()

    result = human_task_bindings(
        test_db, items, owner_id, projects=[test_db.get(CloudProject, project_id)]
    )

    assert result == {
        items[0].id: {
            "humanAssignmentId": f"human-{items[0].id}-1",
            "dispatchId": "dispatch-1",
            "dispatchRoundId": "round-1",
            "assignmentId": f"member-{items[0].id}-1",
            "issueAssignmentId": f"assignment-{items[0].id}",
        }
    }


def test_batch_human_bindings_exclude_cancelled_default_and_workflow_assignments(
    test_db: Session, test_user: User
) -> None:
    owner_id = test_user.id
    project_id, item_ids = _project(test_db, owner_id, 5)
    items = [test_db.get(LoopItem, item_id) for item_id in item_ids]
    for item in items:
        item.assignee_user_id = owner_id
        comment = test_db.get(LoopItemComment, f"assignment-{item.id}")
        comment.metadata_json = {**comment.metadata_json, "target_id": str(owner_id)}
    cancelled = items[1]
    test_db.add(
        LoopItemComment(
            id=f"cancel-{cancelled.id}",
            loop_item_id=cancelled.id,
            cloud_project_id=project_id,
            created_by_user_id=owner_id,
            metadata_json={
                "event_type": "assignment",
                "action": "unassign",
                "assignment_event_id": f"assignment-{cancelled.id}",
            },
        )
    )
    default = test_db.get(LoopItemComment, f"assignment-{items[2].id}")
    default.metadata_json = {**default.metadata_json, "trigger": "default"}
    workflow = test_db.get(LoopItemComment, f"assignment-{items[3].id}")
    workflow.metadata_json = {**workflow.metadata_json, "workflow_step": "Review"}
    test_db.add(
        LoopItemComment(
            id=f"second-{items[4].id}",
            loop_item_id=items[4].id,
            cloud_project_id=project_id,
            created_by_user_id=owner_id,
            metadata_json={
                "event_type": "assignment",
                "action": "assign",
                "target_type": "agent",
                "target_id": "another-worker",
            },
        )
    )
    test_db.flush()

    result = human_task_bindings(
        test_db, items, owner_id, projects=[test_db.get(CloudProject, project_id)]
    )

    assert set(result) == {items[0].id}
    assert result[items[0].id]["assignmentId"] == f"assignment-{items[0].id}"
