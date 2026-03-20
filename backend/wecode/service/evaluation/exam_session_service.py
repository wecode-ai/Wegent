# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for managing exam sessions and timing."""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session, attributes

from wecode.exceptions import BusinessException
from wecode.models.evaluation import EvalAnswer, EvalQuestion, EvalTopic
from wecode.models.evaluation_exam_session import EvalExamSession
from wecode.service.evaluation.text_conversion_service import TextConversionService

logger = logging.getLogger(__name__)


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
                attributes.flag_modified(session, "extra_data")

            exam_end = datetime.fromtimestamp(
                int(exam_started_at), tz=timezone.utc
            ) + timedelta(minutes=exam_minutes)
            remaining_seconds = int((exam_end - now).total_seconds())

        elif phase == "review":
            # Review phase shares the same timer as exam phase
            # Calculate remaining time based on exam end time, not a separate review timer
            if exam_started_at:
                exam_end = datetime.fromtimestamp(
                    int(exam_started_at), tz=timezone.utc
                ) + timedelta(minutes=exam_minutes)
                remaining_seconds = int((exam_end - now).total_seconds())
            else:
                # Fallback if exam_started_at not set
                remaining_seconds = 0

        elif phase == "completed":
            remaining_seconds = 0

        # Calculate actual exam duration (exam + review phases only, excluding intro)
        exam_duration_seconds = None
        if exam_started_at and phase == "completed" and session.completed_at:
            # Calculate time from exam start to completion
            exam_start_dt = datetime.fromtimestamp(
                int(exam_started_at), tz=timezone.utc
            )
            exam_duration_seconds = int(
                (session.completed_at - exam_start_dt).total_seconds()
            )
        elif exam_started_at and phase in ["exam", "review"]:
            # For ongoing exams, calculate from exam start to now
            exam_start_dt = datetime.fromtimestamp(
                int(exam_started_at), tz=timezone.utc
            )
            exam_duration_seconds = int((now - exam_start_dt).total_seconds())

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
            "selected_question_id": session.selected_question_id or None,
            "exam_duration_seconds": exam_duration_seconds,
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
    def select_question(
        db: Session, session: EvalExamSession, question_id: int
    ) -> None:
        """Record selected question."""
        # Use extra_data directly to ensure SQLAlchemy detects the change
        if session.extra_data is None:
            session.extra_data = {}
        session.extra_data["selected_question_id"] = question_id
        # Mark the field as modified to ensure SQLAlchemy updates it
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
        attributes.flag_modified(session, "extra_data")
        db.commit()
        db.refresh(session)

        return session

    @staticmethod
    def _convert_supplementary_notes_if_needed(
        db: Session,
        session: EvalExamSession,
        target_phase: str,
    ) -> bool:
        """Convert text inputs to S3 attachments when entering review phase.

        Reads from content_data.inputs.supplementaryNotes,
        converts to S3 file, and saves to content_data.attachments.supplementaryNotes.
        """
        logger.info(
            f"[ExamSession] _convert_supplementary_notes_if_needed called: "
            f"target_phase={target_phase}, session_id={session.id}"
        )

        # Only convert when entering review phase
        if target_phase != "review":
            logger.info(
                f"[ExamSession] Skipping conversion - target_phase={target_phase} is not 'review'"
            )
            return False

        # Query all questions for this topic
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == session.topic_id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )

        # Query all latest answers for this user
        user_answers = (
            db.query(EvalAnswer)
            .filter(
                EvalAnswer.question_id.in_(question_ids),
                EvalAnswer.respondent_id == session.user_id,
                EvalAnswer.is_latest,
            )
            .all()
        )

        logger.info(f"[ExamSession] Found {len(user_answers)} answers to process")

        converted_count = 0
        for answer in user_answers:
            if not answer.content_data:
                continue

            # Get text from inputs.supplementaryNotes
            inputs = answer.content_data.get("inputs", {})
            notes = inputs.get("supplementaryNotes", "")

            # Check if already converted (attachments.supplementaryNotes exists)
            attachments = answer.content_data.get("attachments", {})
            existing_files = attachments.get("supplementaryNotes", [])

            # Skip if no notes or already has files
            if not notes or not notes.strip():
                continue
            if existing_files:
                logger.info(
                    f"[ExamSession] Answer {answer.id} already has {len(existing_files)} files, skipping"
                )
                continue

            # Convert notes to S3
            attachment = TextConversionService.convert_question_notes_to_s3(
                db, session, answer.question_id, notes
            )

            if attachment:
                # Create new dict to trigger SQLAlchemy change detection
                new_content_data = dict(answer.content_data)

                # Ensure attachments dict exists
                if "attachments" not in new_content_data:
                    new_content_data["attachments"] = {}
                new_content_data["attachments"]["supplementaryNotes"] = [attachment]

                # Clear inputs.supplementaryNotes
                if "inputs" in new_content_data:
                    new_content_data["inputs"] = dict(new_content_data["inputs"])
                    new_content_data["inputs"]["supplementaryNotes"] = ""

                answer.content_data = new_content_data
                converted_count += 1
                logger.info(
                    f"[ExamSession] Converted notes to S3 for answer {answer.id}"
                )

        if converted_count > 0:
            db.commit()
            logger.info(f"[ExamSession] Committed {converted_count} conversions")
            return True

        logger.info("[ExamSession] No supplementary notes to convert")
        return False

    @staticmethod
    def advance_phase_with_conversion(
        db: Session,
        session: EvalExamSession,
        target_phase: str,
    ) -> EvalExamSession:
        """Advance exam phase with text conversion when entering review phase."""
        # Convert supplementary notes to S3 when entering review phase
        ExamSessionService._convert_supplementary_notes_if_needed(
            db, session, target_phase
        )

        # Update phase
        session.current_phase = target_phase

        # Set phase start timestamps
        now = int(time.time())
        if target_phase == "exam" and not session.extra_data.get("exam_started_at"):
            session.extra_data["exam_started_at"] = now
            attributes.flag_modified(session, "extra_data")
        elif target_phase == "review":
            # Always update review_started_at when entering review phase
            session.extra_data["review_started_at"] = now
            attributes.flag_modified(session, "extra_data")
        elif target_phase == "completed":
            session.completed_at = datetime.now(timezone.utc)

        db.commit()
        db.refresh(session)
        return session

    @staticmethod
    def complete_exam_session(
        db: Session,
        session: EvalExamSession,
    ) -> EvalExamSession:
        """Complete exam session.

        If session has supplementaryNotes that haven't been converted yet
        (e.g., when transitioning directly from exam to completed), convert them now.
        """
        # Check if there are any notes that need conversion
        # This handles the case when author forces exam -> completed transition
        # skipping the review phase
        ExamSessionService._convert_supplementary_notes_if_needed(db, session, "review")

        session.current_phase = "completed"
        session.completed_at = datetime.now(timezone.utc)

        db.commit()
        db.refresh(session)
        return session
