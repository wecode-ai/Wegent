"""Project chat timestamps must identify the same instant in every transport."""

from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.db import timezone as database_timezone
from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.project_chat import ProjectChatAgentStart
from app.services.project_chat.service import project_chat_service
from tests.services.test_project_chat_service import create_project


@pytest.mark.parametrize(
    "dialect,created,updated",
    [
        ("mysql", "2026-10-08T12:27:23+00:00", "2026-10-08T12:34:54+00:00"),
        ("sqlite", "2026-10-08T20:27:23+00:00", "2026-10-08T20:34:54+00:00"),
    ],
)
def test_message_view_marks_database_timestamps_with_the_session_timezone(
    dialect: str, created: str, updated: str
) -> None:
    db = MagicMock()
    db.get_bind.return_value.dialect.name = dialect
    row = ProjectChatMessage(
        id=1,
        message_id="run-88",
        project_id="project-1",
        task_id="PRJD70561-10",
        sender_type="agent",
        sender_id="123",
        sender_name="Agent",
        message_type="text",
        content="Completed",
        metadata_json={},
        status="completed",
        created_at=datetime(2026, 10, 8, 20, 27, 23),
        updated_at=datetime(2026, 10, 8, 20, 34, 54),
    )

    view = project_chat_service.to_view(row, db=db)

    assert view.created_at == created
    assert view.updated_at == updated
    assert view.model_dump(by_alias=True)["createdAt"] == created


def test_aware_message_timestamp_is_not_shifted_again() -> None:
    db = MagicMock()
    db.get_bind.return_value.dialect.name = "mysql"
    row = ProjectChatMessage(
        id=1,
        message_id="aware-message",
        project_id="project-1",
        sender_type="user",
        sender_id="2",
        sender_name="User",
        message_type="text",
        content="Hello",
        metadata_json={},
        status="completed",
        created_at=datetime(2026, 10, 8, 12, 27, 23, tzinfo=UTC),
        updated_at=datetime(2026, 10, 8, 12, 34, 54, tzinfo=UTC),
    )

    view = project_chat_service.to_view(row, db=db)

    assert view.created_at == "2026-10-08T12:27:23+00:00"
    assert view.updated_at == "2026-10-08T12:34:54+00:00"


@pytest.mark.parametrize("status_value", ["completed", "failed", "cancelled"])
def test_execution_activity_timestamp_follows_its_status_transition(
    monkeypatch: pytest.MonkeyPatch, status_value: str
) -> None:
    row = ProjectChatMessage(
        content="", status="streaming", metadata_json={"run_id": "run-1"}
    )
    events: list[datetime] = []

    def record_transition(*args: object, **kwargs: object) -> None:
        events.append(datetime.now(UTC))

    monkeypatch.setattr(project_chat_service, "_set_task_ai_state", record_transition)
    monkeypatch.setattr(
        project_chat_service, "_advance_task_to_review", record_transition
    )

    project_chat_service._finish_activity(
        MagicMock(), row, status_value=status_value, content="Result", error=None
    )

    activity_at = datetime.fromisoformat(row.metadata_json["activity_at"])
    assert activity_at >= events[-1]
    assert activity_at.tzinfo == UTC
    assert row.metadata_json["run_id"] == "run-1"
    assert row.status == status_value
    assert row.content == "Result"


def test_persisted_execution_activity_follows_start_and_completion_history(
    test_db: Session, test_user: User
) -> None:
    project = create_project(test_db, test_user)
    task = LoopItem(
        cloud_project_id=project.id,
        title="Chronological activity",
        status="inbox",
        assignee_agent_id="12",
        metadata_json={},
    )
    test_db.add(task)
    test_db.commit()
    started = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=task.id,
            agentId="12",
            runtimeDeviceId="timeline-device",
            runtimeTaskId="timeline-task",
        ),
    )
    test_db.refresh(task)
    start_transition = task.metadata_json["status_history"][-1]
    assert start_transition["trigger"] == "ai_started"
    assert datetime.fromisoformat(
        started.metadata["activity_at"]
    ) >= datetime.fromisoformat(start_transition["at"])
    row = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == started.message_id)
        .one()
    )
    project_chat_service._set_task_ai_state(
        test_db, row=row, trigger=None, agent=None, status_value="running"
    )
    assert row.metadata_json["activity_at"] == started.metadata["activity_at"]

    completed = project_chat_service.finish_runtime_activity(
        test_db,
        runtime_device_id="timeline-device",
        runtime_task_id="timeline-task",
        status_value="completed",
        content="Execution result",
    )

    test_db.refresh(task)
    completion_transition = task.metadata_json["status_history"][-1]
    assert completion_transition["trigger"] == "ai_completed"
    assert completed is not None
    assert completed.content == "Execution result"
    assert datetime.fromisoformat(
        completed.metadata["activity_at"]
    ) >= datetime.fromisoformat(completion_transition["at"])
    row.status = "streaming"
    project_chat_service._set_task_ai_state(
        test_db, row=row, trigger=None, agent=None, status_value="running"
    )
    restart_transition = task.metadata_json["status_history"][-1]
    assert restart_transition["trigger"] == "ai_started"
    assert datetime.fromisoformat(
        row.metadata_json["activity_at"]
    ) >= datetime.fromisoformat(restart_transition["at"])


@pytest.mark.parametrize("offset_minutes", [0, 330, -330])
def test_mysql_message_timestamp_uses_configured_database_timezone(
    monkeypatch: pytest.MonkeyPatch, offset_minutes: int
) -> None:
    configured_timezone = timezone(timedelta(minutes=offset_minutes))
    monkeypatch.setattr(
        database_timezone, "DATABASE_DATETIME_TIMEZONE", configured_timezone
    )
    db = MagicMock()
    db.get_bind.return_value.dialect.name = "mysql"
    timestamp = datetime(2026, 10, 8, 20, 27, 23)

    actual = database_timezone.database_datetime_as_utc(db, timestamp)

    assert actual == timestamp.replace(tzinfo=configured_timezone).astimezone(UTC)
