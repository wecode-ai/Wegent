"""Project chat timestamps must identify the same instant in every transport."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.service import project_chat_service


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
