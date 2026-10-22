"""A human round assignment owns every personal Task created to do its work."""

from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, Delivery, LoopItem, LoopItemTaskBinding
from app.models.user import User
from app.services.collaboration_human_assignments import (
    collaboration_human_assignment_status,
)
from app.services.delivery.service import delivery_service


@pytest.mark.parametrize("delivered_task", ["earlier", "latest", None])
def test_reports_delivery_from_any_task_of_the_same_human_assignment(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    delivered_task: str | None,
) -> None:
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"HUMAN{uuid4().hex[:6].upper()}",
        name="Human round",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    test_db.add(project)
    test_db.flush()
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        title="Review evidence",
        status="in_progress",
        created_by_user_id=test_user.id,
    )
    test_db.add(issue)
    test_db.flush()
    start = datetime(2026, 10, 14, 9)
    bindings = {}
    for index, task_id in enumerate(["earlier", "latest", "other-assignment"]):
        binding = LoopItemTaskBinding(
            id=str(uuid4()),
            cloud_project_id=str(project.id),
            loop_item_id=issue.id,
            task_user_id=test_user.id,
            device_id="human-device",
            task_id=task_id,
            linked_at=start + timedelta(minutes=index),
            metadata_json={
                "human_assignment_id": (
                    "another-human-work"
                    if task_id == "other-assignment"
                    else "human-work"
                )
            },
        )
        bindings[task_id] = binding
        test_db.add(binding)
    test_db.flush()
    deliveries = {}
    for task_id in ["earlier", "latest", "other-assignment"]:
        delivery = Delivery(
            id=str(uuid4()),
            loop_item_id=issue.id,
            created_by_user_id=test_user.id,
            source_task_binding_id=bindings[task_id].id,
            status=(
                "delivered"
                if task_id == delivered_task or task_id == "other-assignment"
                else "draft"
            ),
            delivered_at=start + timedelta(minutes=5),
            markdown_object_key=f"{task_id}.md",
        )
        deliveries[task_id] = delivery
        test_db.add(delivery)
    test_db.commit()
    monkeypatch.setattr(
        delivery_service, "read_markdown", lambda delivery: delivery.markdown_object_key
    )

    result = collaboration_human_assignment_status(
        test_db,
        project_id=project.id,
        issue_id=issue.id,
        human_assignment_id="human-work",
    )

    assert result["status"] == ("completed" if delivered_task else "running")
    assert result["runtime_task_id"] == (delivered_task or "latest")
    assert result["delivery_id"] == (
        deliveries[delivered_task].id if delivered_task else None
    )
    assert result["result"] == (f"{delivered_task}.md" if delivered_task else "")
