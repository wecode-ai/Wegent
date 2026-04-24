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
        if exam_started_at and phase == "completed":
            if session.completed_at:
                # Normal case: completed_at is set
                exam_start_dt = datetime.fromtimestamp(
                    int(exam_started_at), tz=timezone.utc
                )
                exam_duration_seconds = int(
                    (session.completed_at - exam_start_dt).total_seconds()
                )
            elif review_started_at:
                # Fallback: use review_started_at as approximate completion time
                # This handles cases where completed_at wasn't saved properly
                exam_start_dt = datetime.fromtimestamp(
                    int(exam_started_at), tz=timezone.utc
                )
                review_start_dt = datetime.fromtimestamp(
                    int(review_started_at), tz=timezone.utc
                )
                exam_duration_seconds = int(
                    (review_start_dt - exam_start_dt).total_seconds()
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
    def _convert_text_slots_if_needed(
        db: Session,
        session: EvalExamSession,
        target_phase: str,
    ) -> bool:
        """Convert text slot content to S3 attachments when entering review or completed phase.

        For dynamic answer slots with inputMode='text':
        - Reads from content_data.answers[slot_key].text
        - Converts to S3 file
        - Saves to content_data.answers[slot_key].files
        - Clears content_data.answers[slot_key].text

        Note: Conversion happens when entering review phase AND when completing the exam.
        This ensures text content is converted even if modified during review phase.
        """
        logger.info(
            f"[ExamSession] _convert_text_slots_if_needed called: "
            f"target_phase={target_phase}, session_id={session.id}"
        )

        # Convert when entering review phase OR when completing the exam
        # This handles the case where user modifies text during review phase
        if target_phase not in ("review", "completed"):
            logger.info(
                f"[ExamSession] Skipping conversion - target_phase={target_phase} "
                f"is not 'review' or 'completed'"
            )
            return False

        # Query all questions for this topic
        questions = (
            db.query(EvalQuestion)
            .filter(
                EvalQuestion.topic_id == session.topic_id,
                EvalQuestion.is_active,
            )
            .all()
        )
        question_ids = [q.id for q in questions]
        question_map = {q.id: q for q in questions}

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

            question = question_map.get(answer.question_id)
            answer_slots = []
            if question and question.content_data:
                answer_slots = question.content_data.get("answerSlots", [])

            # Create new dict to trigger SQLAlchemy change detection
            new_content_data = dict(answer.content_data)
            answer_modified = False

            # Process dynamic answer slots with text inputMode
            if answer_slots:
                answers = new_content_data.get("answers", {})
                for slot in answer_slots:
                    slot_key = slot.get("key")
                    input_mode = slot.get("inputMode", "attachment")
                    # Only process text slots
                    if not slot_key or input_mode != "text":
                        continue

                    slot_answer = answers.get(slot_key, {})
                    text_content = slot_answer.get("text", "")
                    existing_files = slot_answer.get("files", [])

                    # Skip if no text content
                    if not text_content or not text_content.strip():
                        continue

                    # BUG FIX: Always convert text to S3 if text content exists
                    # This handles the case where user returns to exam, modifies text,
                    # and previews again - we need to update the S3 file with new content
                    # Note: Old S3 files are NOT deleted to preserve history and avoid data loss

                    # Convert text content to S3
                    attachment = TextConversionService.convert_text_slot_to_s3(
                        db, session, answer.question_id, text_content, slot_key
                    )

                    if attachment:
                        # Update answers structure
                        if "answers" not in new_content_data:
                            new_content_data["answers"] = {}
                        if slot_key not in new_content_data["answers"]:
                            new_content_data["answers"][slot_key] = {}
                        new_content_data["answers"][slot_key]["files"] = [attachment]
                        # BUG FIX: Keep text content in DB until final submission
                        # This allows user to return to exam phase and continue editing
                        # Only clear text when entering completed phase (final submission)
                        if target_phase == "completed":
                            new_content_data["answers"][slot_key]["text"] = ""
                        answer_modified = True
                        converted_count += 1
                        logger.info(
                            f"[ExamSession] Converted text to S3 for answer {answer.id} slot {slot_key} "
                            f"(text {'cleared' if target_phase == 'completed' else 'preserved'})"
                        )

            # Handle link_or_attachment mode - attachment takes priority
            if answer_slots:
                answers = new_content_data.get("answers", {})
                for slot in answer_slots:
                    slot_key = slot.get("key")
                    input_mode = slot.get("inputMode", "attachment")
                    # Only process link_or_attachment slots
                    if not slot_key or input_mode != "link_or_attachment":
                        continue

                    slot_answer = answers.get(slot_key, {})
                    link = slot_answer.get("link", "").strip()
                    files = slot_answer.get("files", [])

                    # If both link and files exist, prioritize attachment (clear link)
                    if link and files:
                        logger.info(
                            f"[ExamSession] Answer {answer.id} slot {slot_key} has both link and files, "
                            f"prioritizing attachment ({len(files)} files)"
                        )
                        # Create a copy to avoid modifying the original dict directly
                        if slot_key not in new_content_data["answers"]:
                            new_content_data["answers"][slot_key] = {}
                        new_content_data["answers"][slot_key]["link"] = ""
                        answer_modified = True

            if answer_modified:
                answer.content_data = new_content_data
                attributes.flag_modified(answer, "content_data")

        if converted_count > 0:
            db.commit()
            logger.info(f"[ExamSession] Committed {converted_count} conversions")
            return True

        logger.info("[ExamSession] No text slots to convert")
        return False

    @staticmethod
    def advance_phase_with_conversion(
        db: Session,
        session: EvalExamSession,
        target_phase: str,
    ) -> EvalExamSession:
        """Advance exam phase with text conversion when entering review phase."""
        # Convert supplementary notes to S3 when entering review phase
        ExamSessionService._convert_text_slots_if_needed(db, session, target_phase)

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
            # Mark extra_data as modified since completed_at is stored in extra_data
            attributes.flag_modified(session, "extra_data")

        db.commit()
        db.refresh(session)
        return session

    @staticmethod
    def complete_exam_session(
        db: Session,
        session: EvalExamSession,
    ) -> EvalExamSession:
        """Complete exam session.

        If session has text slots that haven't been converted yet
        (e.g., when transitioning directly from exam to completed), convert them now.
        """
        # Check if there are any notes that need conversion
        # This handles the case when author forces exam -> completed transition
        # skipping the review phase
        ExamSessionService._convert_text_slots_if_needed(db, session, "review")

        session.current_phase = "completed"
        session.completed_at = datetime.now(timezone.utc)
        # Mark extra_data as modified since completed_at is stored in extra_data
        attributes.flag_modified(session, "extra_data")

        db.commit()
        db.refresh(session)
        return session
