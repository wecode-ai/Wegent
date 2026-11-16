"""Round member work keeps a separate identity from its owning Issue assignment event."""

from uuid import uuid4

from app.models.delivery import CloudProject, LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemTaskBind
from app.services.collaboration_human_assignments import human_task_bindings
from app.services.collaboration_round_assignment import assign_round_owner
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import _task_binding_metadata


def test_round_stand_in_binding_identifies_the_issue_event(test_db, test_user):
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"REPRO{uuid4().hex[:6].upper()}",
        name="Stand-in round identity reproduction",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    test_db.add(project)
    test_db.flush()
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        title="Human review",
        status="in_progress",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(issue)
    test_db.flush()
    member = {
        "assignee_type": "human",
        "human_user_id": test_user.id,
        "human_user_name": test_user.user_name,
        "assignment_id": "manager-selected-member-assignment",
        "human_assignment_id": "round-human-work",
    }
    assign_round_owner(test_db, item=issue, assignments=[member], user_id=test_user.id)
    message_id = str(uuid4())
    test_db.add(
        ProjectChatMessage(
            project_id=str(project.id),
            task_id=issue.id,
            message_id=message_id,
            client_message_id=message_id,
            sender_type="agent",
            sender_id="manager",
            sender_name="Manager",
            message_type="text",
            content="",
            metadata_json={
                "activity_type": "manager_assignment",
                "dispatch_id": "dispatch",
                "coordination_round_id": "round",
                "dispatch_assignments": [member],
            },
        )
    )
    test_db.flush()
    binding = human_task_bindings(test_db, [issue], test_user.id, projects=[project])[
        issue.id
    ]
    active = issue_assignment_service.active_for_issue(test_db, issue.id)
    assert binding["assignmentId"] == member["assignment_id"]
    assert len(active) == 1
    assert binding["issueAssignmentId"] == active[0].id
    assert binding["issueAssignmentId"] != binding["assignmentId"]
    values = LoopItemTaskBind(deviceId="recipient-device", taskId="stand-in", **binding)
    stored = _task_binding_metadata(values)
    assert stored["assignment_id"] == member["assignment_id"]
    assert stored["issue_assignment_id"] == active[0].id
