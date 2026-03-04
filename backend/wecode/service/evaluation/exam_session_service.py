# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for managing exam sessions and timing."""

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from wecode.exceptions import BusinessException
from wecode.models.evaluation import EvalTopic
from wecode.models.evaluation_exam_session import EvalExamSession


class ExamSessionService:
    """Manages exam session lifecycle and timing calculations.

    Three-phase exam flow (manual transitions only):
    1. intro (5 min): Pre-exam introduction and Q&A
    2. exam (50 min): Main exam answering time
    3. review (5 min): Final review and submission check

    Phases are ONLY changed when users manually click buttons.
    No automatic time-based phase transitions.
    """

    DEFAULT_INTRO_MINUTES = 5
    DEFAULT_EXAM_MINUTES = 50
    DEFAULT_REVIEW_MINUTES = 5

    @staticmethod
    def get_or_create_session(
        db: Session,
        topic_id: int,
        user_id: int,
        intro_duration: int = None,
        exam_duration: int = None,
        review_duration: int = None,
    ) -> EvalExamSession:
        """Get active exam session or create new one."""
        session = (
            db.query(EvalExamSession)
            .filter(
                EvalExamSession.topic_id == topic_id,
                EvalExamSession.user_id == user_id,
                EvalExamSession.is_active == 1,
            )
            .first()
        )

        if not session:
            # Use defaults if not provided
            intro_minutes = intro_duration or ExamSessionService.DEFAULT_INTRO_MINUTES
            exam_minutes = exam_duration or ExamSessionService.DEFAULT_EXAM_MINUTES
            review_minutes = (
                review_duration or ExamSessionService.DEFAULT_REVIEW_MINUTES
            )

            session = EvalExamSession(
                topic_id=topic_id,
                user_id=user_id,
                extra_data={
                    "started_at": int(time.time()),
                    "intro_duration_minutes": intro_minutes,
                    "exam_duration_minutes": exam_minutes,
                    "review_duration_minutes": review_minutes,
                    "selected_question_id": 0,
                    "submit_count": 0,
                },
                current_phase="intro",
            )
            db.add(session)
            db.commit()
            db.refresh(session)

        return session

    @staticmethod
    def get_active_session(
        db: Session,
        topic_id: int,
        user_id: int,
    ) -> Optional[EvalExamSession]:
        """Get active exam session without creating one."""
        return (
            db.query(EvalExamSession)
            .filter(
                EvalExamSession.topic_id == topic_id,
                EvalExamSession.user_id == user_id,
                EvalExamSession.is_active == 1,
            )
            .first()
        )

    @staticmethod
    def get_session_status(session: EvalExamSession) -> Dict[str, Any]:
        """Calculate current exam status based on session.

        NOTE: Phases are ONLY changed via manual user actions (advance_phase).
        This method calculates remaining time but NEVER auto-transitions phases.

        Three-phase flow with independent timers:
        1. intro: 5 minutes for pre-exam introduction
        2. exam: 50 minutes for answering (starts when user clicks "开始答题")
        3. review: 5 minutes for final check (starts when user clicks "结束答题")

        When time expires, remaining_seconds becomes negative (overtime).
        """
        # Use UTC time consistently for all calculations
        now = datetime.now(timezone.utc)

        # Get durations from extra_data
        extra = session.extra_data or {}
        intro_minutes = extra.get(
            "intro_duration_minutes", ExamSessionService.DEFAULT_INTRO_MINUTES
        )
        exam_minutes = extra.get(
            "exam_duration_minutes", ExamSessionService.DEFAULT_EXAM_MINUTES
        )
        review_minutes = extra.get(
            "review_duration_minutes", ExamSessionService.DEFAULT_REVIEW_MINUTES
        )

        # Get phase start times from extra_data
        intro_started_at = extra.get("intro_started_at")
        exam_started_at = extra.get("exam_started_at")
        review_started_at = extra.get("review_started_at")

        # For backward compatibility: if intro_started_at not set but started_at exists
        if intro_started_at is None:
            started_at = session.started_at
            if started_at:
                # Ensure we get UTC timestamp
                intro_started_at = int(started_at.replace(tzinfo=None).timestamp())

        # Get current phase - NEVER auto-transition based on time
        phase = session.current_phase
        remaining_seconds = 0

        if phase == "intro" and intro_started_at:
            # Use UTC-aware datetime calculation
            intro_end = datetime.fromtimestamp(
                int(intro_started_at), tz=timezone.utc
            ) + timedelta(minutes=intro_minutes)
            remaining_seconds = int((intro_end - now).total_seconds())

        elif phase == "exam":
            if exam_started_at is None:
                # If exam_started_at not set, use intro end time as fallback
                if intro_started_at:
                    exam_started_at = int(
                        (
                            datetime.fromtimestamp(
                                int(intro_started_at), tz=timezone.utc
                            )
                            + timedelta(minutes=intro_minutes)
                        ).timestamp()
                    )
                else:
                    exam_started_at = int(now.timestamp())
                extra["exam_started_at"] = exam_started_at
                session.extra_data = extra
                from sqlalchemy.orm import attributes

                attributes.flag_modified(session, "extra_data")

            exam_end = datetime.fromtimestamp(
                int(exam_started_at), tz=timezone.utc
            ) + timedelta(minutes=exam_minutes)
            remaining_seconds = int((exam_end - now).total_seconds())

        elif phase == "review":
            if review_started_at is None:
                # If review_started_at not set, calculate from exam start
                if exam_started_at:
                    review_started_at = int(
                        (
                            datetime.fromtimestamp(
                                int(exam_started_at), tz=timezone.utc
                            )
                            + timedelta(minutes=exam_minutes)
                        ).timestamp()
                    )
                else:
                    review_started_at = int(now.timestamp())
                extra["review_started_at"] = review_started_at
                session.extra_data = extra
                from sqlalchemy.orm import attributes

                attributes.flag_modified(session, "extra_data")

            review_end = datetime.fromtimestamp(
                int(review_started_at), tz=timezone.utc
            ) + timedelta(minutes=review_minutes)
            remaining_seconds = int((review_end - now).total_seconds())

        elif phase == "completed":
            remaining_seconds = 0

        # Calculate end times for response (ISO format with UTC)
        # Append 'Z' to indicate UTC timezone for JavaScript compatibility
        intro_end_at = None
        exam_end_at = None
        review_end_at = None
        started_at_iso = None

        if intro_started_at:
            intro_end_at = (
                datetime.fromtimestamp(int(intro_started_at), tz=timezone.utc)
                + timedelta(minutes=intro_minutes)
            ).isoformat()
            started_at_iso = datetime.fromtimestamp(
                int(intro_started_at), tz=timezone.utc
            ).isoformat()
        if exam_started_at:
            exam_end_at = (
                datetime.fromtimestamp(int(exam_started_at), tz=timezone.utc)
                + timedelta(minutes=exam_minutes)
            ).isoformat()
        if review_started_at:
            review_end_at = (
                datetime.fromtimestamp(int(review_started_at), tz=timezone.utc)
                + timedelta(minutes=review_minutes)
            ).isoformat()

        return {
            "phase": phase,
            "started_at": started_at_iso,
            "intro_end_at": intro_end_at,
            "exam_end_at": exam_end_at,
            "review_end_at": review_end_at,
            "remaining_seconds": remaining_seconds,
            "is_overtime": remaining_seconds < 0,
            "submit_count": session.submit_count,
            "selected_question_id": session.selected_question_id or None,
        }

    @staticmethod
    def get_sessions_status_batch(
        sessions: list[EvalExamSession],
    ) -> dict[int, dict[str, Any]]:
        """Calculate status for multiple sessions in batch.

        This is more efficient than calling get_session_status() in a loop
        when processing many sessions.

        Args:
            sessions: List of exam sessions

        Returns:
            Dictionary mapping user_id to session status
        """
        return {
            session.user_id: ExamSessionService.get_session_status(session)
            for session in sessions
        }

    @staticmethod
    def record_submission(db: Session, session: EvalExamSession) -> None:
        """Record a submission (multiple allowed)."""
        session.last_submitted_at = datetime.now(timezone.utc)
        session.submit_count += 1
        # Mark extra_data as modified since submit_count is stored in it
        from sqlalchemy.orm import attributes

        attributes.flag_modified(session, "extra_data")
        db.commit()

    @staticmethod
    def select_question(
        db: Session, session: EvalExamSession, question_id: int
    ) -> None:
        """Record selected question."""
        # Use extra_data directly to ensure SQLAlchemy detects the change
        if session.extra_data is None:
            session.extra_data = {}
        session.extra_data["selected_question_id"] = question_id
        # Mark the field as modified to ensure SQLAlchemy updates it
        from sqlalchemy.orm import attributes

        attributes.flag_modified(session, "extra_data")
        db.commit()

    @staticmethod
    def reset_session(db: Session, topic_id: int, user_id: int) -> None:
        """Soft delete active session (for admin reset)."""
        session = (
            db.query(EvalExamSession)
            .filter(
                EvalExamSession.topic_id == topic_id,
                EvalExamSession.user_id == user_id,
                EvalExamSession.is_active == 1,
            )
            .first()
        )
        if session:
            session.is_active = 0
            db.commit()

    @staticmethod
    def validate_submission_allowed(session: EvalExamSession) -> None:
        """Validate that submission is still allowed."""
        status = ExamSessionService.get_session_status(session)
        if status["phase"] == "completed":
            raise BusinessException("Exam time has expired")

    @staticmethod
    def advance_phase(
        db: Session, session: EvalExamSession, target_phase: str
    ) -> EvalExamSession:
        """Manually advance to the next phase.

        Phase transitions (user-controlled only):
        - intro -> exam: User clicks "Start Exam"
        - exam -> review: User clicks "End Exam"
        - review -> completed: User clicks "Finish Exam"

        Args:
            db: Database session
            session: Current exam session
            target_phase: Target phase to advance to

        Returns:
            Updated exam session

        Raises:
            BusinessException: If phase transition is not allowed
        """
        current_phase = session.current_phase

        # Define valid phase transitions
        valid_transitions = {
            "intro": ["exam"],
            "exam": ["review"],
            "review": ["completed"],
            "completed": [],
        }

        if target_phase not in valid_transitions.get(current_phase, []):
            raise BusinessException(
                f"Cannot transition from '{current_phase}' to '{target_phase}'"
            )

        # Update phase and set phase start times
        session.current_phase = target_phase
        extra = session.extra_data or {}
        now_ts = int(time.time())

        # Set phase-specific start times for independent timers
        # ALWAYS update the start time when transitioning to ensure correct timing
        if target_phase == "exam" and current_phase == "intro":
            # Transitioning from intro to exam - set exam start time to NOW
            extra["exam_started_at"] = now_ts
        elif target_phase == "review" and current_phase == "exam":
            # Transitioning from exam to review - set review start time to NOW
            extra["review_started_at"] = now_ts

        session.extra_data = extra
        from sqlalchemy.orm import attributes

        attributes.flag_modified(session, "extra_data")
        db.commit()
        db.refresh(session)

        return session

    @staticmethod
    def update_session_phase(
        db: Session, session: EvalExamSession, target_phase: str
    ) -> EvalExamSession:
        """Update session phase to any valid phase (for admin use).

        Unlike advance_phase which only allows forward transitions,
        this method allows setting phase to any valid value.

        Args:
            db: Database session
            session: Current exam session
            target_phase: Target phase to set

        Returns:
            Updated exam session
        """
        extra = session.extra_data or {}
        now_ts = int(time.time())

        # Set phase-specific start times when transitioning to certain phases
        if target_phase == "exam" and not extra.get("exam_started_at"):
            extra["exam_started_at"] = now_ts
        elif target_phase == "review" and not extra.get("review_started_at"):
            extra["review_started_at"] = now_ts

        session.current_phase = target_phase
        session.extra_data = extra
        from sqlalchemy.orm import attributes

        attributes.flag_modified(session, "extra_data")
        db.commit()
        db.refresh(session)

        return session
