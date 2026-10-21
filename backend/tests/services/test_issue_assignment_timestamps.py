"""Assignment timestamps must be unambiguous across Executor timezones."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.db import timezone as database_timezone
from app.models.delivery import LoopItemComment
from app.services.issue_assignments import AssignmentEvent, IssueAssignmentService


@pytest.mark.parametrize("dialect, utc_hour", [("mysql", 12), ("sqlite", 20)])
def test_assignment_response_normalizes_database_clock(
    dialect: str, utc_hour: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        database_timezone, "DATABASE_DATETIME_TIMEZONE", timezone(timedelta(hours=8))
    )
    db = MagicMock(spec=Session)
    db.get.return_value = None
    db.get_bind.return_value.dialect.name = dialect
    timestamp = datetime(2026, 10, 20, 20, 0, 1)
    assignment = AssignmentEvent(
        comment=LoopItemComment(
            id="assignment",
            loop_item_id="issue",
            created_by_user_id=7,
            created_at=timestamp,
            updated_at=timestamp,
        ),
        metadata={"target_type": "human", "target_id": "7"},
    )

    result = IssueAssignmentService.response_values(db, assignment)

    expected = datetime(2026, 10, 20, utc_hour, 0, 1, tzinfo=timezone.utc)
    assert result["created_at"] == expected
    assert result["updated_at"] == expected
    assert result["created_at"].isoformat().endswith("+00:00")
