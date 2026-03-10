"""Evaluation exam session model for tracking exam timing."""

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column, DateTime, Index, Integer, String
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class EvalExamSession(Base):
    """Tracks exam sessions with timing information per user per topic.

    Uses JSON field for extensible data storage, making this a generic
    topic-respondent relationship table.
    """

    __tablename__ = "wecode_eval_exam_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    topic_id = Column(Integer, nullable=False, default=0)
    user_id = Column(Integer, nullable=False, default=0)

    # Current state (indexed for query performance)
    current_phase = Column(
        String(20), nullable=False, default="intro"
    )  # intro, exam, review, completed

    # Soft delete for reset functionality (indexed)
    is_active = Column(Integer, nullable=False, default=1)  # 1=active, 0=reset/archived

    # Extended data stored as JSON (no index needed)
    # Contains: selected_question_id, intro_duration_minutes, exam_duration_minutes,
    #           review_duration_minutes, started_at, last_submitted_at, exam_started_at,
    #           review_started_at, intro_started_at, completed_at
    extra_data = Column(JSON, nullable=False)

    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "idx_wecode_eval_exam_sessions_topic_user",
            "topic_id",
            "user_id",
            "is_active",
        ),
        Index("idx_wecode_eval_exam_sessions_phase", "current_phase"),
    )

    # Convenience properties for accessing extra_data fields
    @property
    def selected_question_id(self) -> int:
        return self.extra_data.get("selected_question_id", 0) if self.extra_data else 0

    @selected_question_id.setter
    def selected_question_id(self, value: int):
        if self.extra_data is None:
            self.extra_data = {}
        self.extra_data["selected_question_id"] = value

    @property
    def exam_duration_minutes(self) -> int:
        return (
            self.extra_data.get("exam_duration_minutes", 45) if self.extra_data else 45
        )

    @exam_duration_minutes.setter
    def exam_duration_minutes(self, value: int):
        if self.extra_data is None:
            self.extra_data = {}
        self.extra_data["exam_duration_minutes"] = value

    @property
    def qa_duration_minutes(self) -> int:
        return self.extra_data.get("qa_duration_minutes", 5) if self.extra_data else 5

    @qa_duration_minutes.setter
    def qa_duration_minutes(self, value: int):
        if self.extra_data is None:
            self.extra_data = {}
        self.extra_data["qa_duration_minutes"] = value

    @property
    def started_at(self) -> Optional[datetime]:
        if not self.extra_data:
            return None
        ts = self.extra_data.get("started_at")
        # Use UTC consistently - return aware datetime
        return datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None

    @started_at.setter
    def started_at(self, value: Optional[datetime]):
        if self.extra_data is None:
            self.extra_data = {}
        # Store as UTC timestamp
        # If datetime is naive, assume it's UTC
        if value:
            if value.tzinfo is None:
                # Naive datetime - treat as UTC
                self.extra_data["started_at"] = int(value.timestamp())
            else:
                # Aware datetime - convert to UTC timestamp
                from datetime import timezone

                self.extra_data["started_at"] = int(
                    value.astimezone(timezone.utc).timestamp()
                )
        else:
            self.extra_data["started_at"] = None

    @property
    def last_submitted_at(self) -> Optional[datetime]:
        if not self.extra_data:
            return None
        ts = self.extra_data.get("last_submitted_at")
        # Use UTC consistently
        return datetime.utcfromtimestamp(ts) if ts else None

    @property
    def last_submitted_at(self) -> Optional[datetime]:
        if not self.extra_data:
            return None
        ts = self.extra_data.get("last_submitted_at")
        # Use UTC consistently - return aware datetime
        from datetime import timezone

        return datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None

    @last_submitted_at.setter
    def last_submitted_at(self, value: Optional[datetime]):
        if self.extra_data is None:
            self.extra_data = {}
        # Store as UTC timestamp
        # If datetime is naive, assume it's UTC
        if value:
            if value.tzinfo is None:
                # Naive datetime - treat as UTC
                self.extra_data["last_submitted_at"] = int(value.timestamp())
            else:
                # Aware datetime - convert to UTC timestamp
                from datetime import timezone

                self.extra_data["last_submitted_at"] = int(
                    value.astimezone(timezone.utc).timestamp()
                )
        else:
            self.extra_data["last_submitted_at"] = None

    @property
    def completed_at(self) -> Optional[datetime]:
        if not self.extra_data:
            return None
        ts = self.extra_data.get("completed_at")
        return datetime.fromtimestamp(ts, tz=timezone.utc) if ts else None

    @completed_at.setter
    def completed_at(self, value: Optional[datetime]):
        if self.extra_data is None:
            self.extra_data = {}
        if value:
            if value.tzinfo is None:
                self.extra_data["completed_at"] = int(value.timestamp())
            else:
                self.extra_data["completed_at"] = int(
                    value.astimezone(timezone.utc).timestamp()
                )
        else:
            self.extra_data["completed_at"] = None
