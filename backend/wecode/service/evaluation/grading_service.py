# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Grading service for evaluation module.

This module provides the GradingService class which:
1. Manages grading task lifecycle (create, complete, fail, publish)
2. Orchestrates grading strategies (single-model, multi-model)
3. Handles state updates based on strategy results

Architecture:
    GradingService (this file)
        └── orchestrates strategies, handles results
    GradingStrategy (grading_base.py)
        └── abstract base with shared utilities
    SingleModelStrategy / MultiModelStrategy (grading_strategies.py)
        └── concrete implementations, return GradingResult

Key design principles:
1. Service manages task lifecycle, strategies only execute
2. Strategies return GradingResult, service handles state updates
3. No circular dependencies (strategies don't import service)
"""

import asyncio
import json
import logging
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from wecode.models.evaluation import EvalAnswer, EvalGradingTask, GradingTaskStatus
from wecode.schemas.evaluation import (
    AggregatorModelConfig,
    MultiModelGradingConfig,
    ScorerModelConfig,
)
from wecode.service.evaluation.grading_base import AttachmentInfo, GradingContext
from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)


class GradingService:
    """Service for managing AI grading tasks.

    Responsibilities:
    - Task CRUD operations (create, get, list)
    - Task lifecycle management (complete, fail, publish)
    - Orchestrating grading strategies
    - Prompt building
    - Report storage
    """

    def __init__(self):
        self._storage_service = EvalStorageService()

    # ==================== Task CRUD ====================

    def get(self, db: Session, task_id: int) -> Optional[EvalGradingTask]:
        """Get a grading task by ID."""
        return db.query(EvalGradingTask).filter(EvalGradingTask.id == task_id).first()

    def get_by_answer(self, db: Session, answer_id: int) -> Optional[EvalGradingTask]:
        """Get grading task by answer ID."""
        return (
            db.query(EvalGradingTask)
            .filter(EvalGradingTask.answer_id == answer_id)
            .order_by(EvalGradingTask.created_at.desc())
            .first()
        )

    def create(
        self,
        db: Session,
        question_id: int,
        question_version: str,
        answer_id: int,
        respondent_id: int,
        grading_mode: Optional[str] = None,
    ) -> EvalGradingTask:
        """Create a new grading task."""
        report_data = {"grading_mode": grading_mode} if grading_mode else {}

        task = EvalGradingTask(
            question_id=question_id,
            question_version=question_version,
            answer_id=answer_id,
            respondent_id=respondent_id,
            status=GradingTaskStatus.PENDING,
            report_data=report_data,
        )
        db.add(task)
        db.flush()

        logger.info(
            f"[GradingService] Created grading task {task.id} for "
            f"question={question_id}, answer={answer_id}, grading_mode={grading_mode}"
        )
        return task

    def list_by_topic(
        self,
        db: Session,
        topic_id: int,
        status: Optional[GradingTaskStatus] = None,
        respondent_id: Optional[int] = None,
    ) -> List[EvalGradingTask]:
        """List grading tasks for a topic."""
        from wecode.models.evaluation import EvalQuestion

        query = (
            db.query(EvalGradingTask)
            .join(EvalQuestion, EvalGradingTask.question_id == EvalQuestion.id)
            .filter(EvalQuestion.topic_id == topic_id)
        )

        if status:
            query = query.filter(EvalGradingTask.status == status)
        if respondent_id:
            query = query.filter(EvalGradingTask.respondent_id == respondent_id)

        return query.order_by(EvalGradingTask.created_at.desc()).all()

    def list_by_question(
        self,
        db: Session,
        question_id: int,
        status: Optional[GradingTaskStatus] = None,
    ) -> List[EvalGradingTask]:
        """List grading tasks for a question."""
        query = db.query(EvalGradingTask).filter(
            EvalGradingTask.question_id == question_id
        )
        if status:
            query = query.filter(EvalGradingTask.status == status)
        return query.order_by(EvalGradingTask.created_at.desc()).all()

    def list_by_answer(self, db: Session, answer_id: int) -> List[EvalGradingTask]:
        """List grading tasks for an answer."""
        return (
            db.query(EvalGradingTask)
            .filter(EvalGradingTask.answer_id == answer_id)
            .order_by(EvalGradingTask.created_at.desc())
            .all()
        )

    # ==================== Task Lifecycle ====================

    def complete(
        self, db: Session, task: EvalGradingTask, report_content: str
    ) -> EvalGradingTask:
        """Mark grading task as completed with AI report."""
        s3_path = self._save_report_to_s3(db, task, report_content, is_draft=True)

        task.status = GradingTaskStatus.COMPLETED
        task.completed_at = datetime.now()

        report_data = dict(task.report_data) if task.report_data else {}
        report_data["ai_report"] = {
            "content": (
                report_content[:1000] + "..."
                if len(report_content) > 1000
                else report_content
            ),
            "s3_path": s3_path,
            "generated_at": datetime.now().isoformat(),
        }
        # Note: task_id is already written to report_data when chat task is created
        # (in SingleModelStrategy or MultiModelStrategy)
        task.report_data = report_data
        flag_modified(task, "report_data")
        task.version = task.version + 1

        db.flush()
        db.commit()

        logger.info(f"[GradingService] Completed grading task {task.id}")
        return task

    def fail(
        self, db: Session, task: EvalGradingTask, error_message: str
    ) -> EvalGradingTask:
        """Mark grading task as failed."""
        task.status = GradingTaskStatus.FAILED
        task.error_message = error_message[:500]
        task.completed_at = datetime.now()
        db.flush()
        db.commit()

        logger.info(f"[GradingService] Failed grading task {task.id}: {error_message}")
        return task

    def update_report(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
        user_id: int,
    ) -> EvalGradingTask:
        """Update human-edited report content."""
        s3_path = self._save_report_to_s3(db, task, report_content, is_draft=True)

        report_data = dict(task.report_data) if task.report_data else {}
        report_data["human_report"] = {
            "content": (
                report_content[:1000] + "..."
                if len(report_content) > 1000
                else report_content
            ),
            "s3_path": s3_path,
            "updated_at": datetime.now().isoformat(),
            "updated_by": user_id,
        }
        task.report_data = report_data
        flag_modified(task, "report_data")
        task.version = task.version + 1

        db.flush()
        db.commit()

        logger.info(f"[GradingService] Updated report for grading task {task.id}")
        return task

    def publish(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: Optional[str] = None,
        attachment: Optional[Dict] = None,
    ) -> EvalGradingTask:
        """Publish grading report to respondent."""
        report_data = dict(task.report_data) if task.report_data else {}

        final_content = report_content
        if not final_content:
            # Priority: human_report (full from S3) > ai_report (full from S3) > inline content
            human_report = report_data.get("human_report", {})
            ai_report = report_data.get("ai_report", {})

            # Try to load full content from S3 first (inline content may be truncated)
            human_s3_path = human_report.get("s3_path") if human_report else None
            ai_s3_path = ai_report.get("s3_path") if ai_report else None

            if human_s3_path:
                s3_content = self._storage_service.get(human_s3_path)
                if s3_content:
                    final_content = s3_content.decode("utf-8")
                    logger.info(
                        f"[GradingService] Loaded full human report from S3 for task {task.id}"
                    )

            if not final_content and ai_s3_path:
                s3_content = self._storage_service.get(ai_s3_path)
                if s3_content:
                    final_content = s3_content.decode("utf-8")
                    logger.info(
                        f"[GradingService] Loaded full AI report from S3 for task {task.id}"
                    )

            # Fallback to inline content if S3 load failed
            if not final_content:
                final_content = human_report.get("content") or ai_report.get(
                    "content", ""
                )

        s3_path = None
        if final_content:
            s3_path = self._save_report_to_s3(db, task, final_content, is_draft=False)

        task.status = GradingTaskStatus.PUBLISHED
        task.published_at = datetime.now()

        report_data["final_report"] = {
            "content": (
                final_content[:1000] + "..."
                if final_content and len(final_content) > 1000
                else final_content
            ),
            "s3_path": s3_path,
            "published_at": datetime.now().isoformat(),
        }
        if attachment:
            report_data["final_report"]["attachment"] = attachment

        task.report_data = report_data
        flag_modified(task, "report_data")
        task.version = task.version + 1

        db.flush()
        db.commit()

        logger.info(f"[GradingService] Published grading task {task.id}")
        return task

    # ==================== Grading Execution ====================

    def execute(
        self,
        db: Session,
        task: EvalGradingTask,
        team_id: int,
        user_id: int,
        model_id: Optional[str] = None,
        force_override_bot_model: bool = False,
        multi_model_config: Optional[MultiModelGradingConfig] = None,
    ) -> EvalGradingTask:
        """Execute AI grading for a task.

        This is the main entry point for grading. It:
        1. Prepares task state and context
        2. Creates the appropriate strategy
        3. Runs strategy in background thread
        4. Handles result (complete or fail) based on strategy outcome
        """
        logger.info(
            f"[GradingService] Starting grading execution for task {task.id} "
            f"with team {team_id}, user {user_id}"
        )

        # Validate user and team
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError(f"User {user_id} not found")

        team = db.query(Kind).filter(Kind.id == team_id, Kind.is_active == True).first()
        if not team:
            raise ValueError(f"Team {team_id} not found or inactive")

        answer = db.query(EvalAnswer).filter(EvalAnswer.id == task.answer_id).first()
        if not answer:
            raise ValueError(f"Answer {task.answer_id} not found")

        # Get question for attachment filtering
        from wecode.service.evaluation.question_service import QuestionService

        question_service = QuestionService()
        question = question_service.get(db, task.question_id)

        # Build prompt
        prompt_type = "scorer" if multi_model_config else "single"
        prompt = self._build_prompt(db, task, prompt_type, multi_model_config)
        attachments = self._collect_attachments(answer, question)

        # Update task status to RUNNING
        task.status = GradingTaskStatus.RUNNING
        task.team_id = team_id
        task.started_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        task.task_id = 0  # Reset, will be set by strategy

        # Update grading mode in report_data
        grading_mode_value = "multi" if multi_model_config else "single"
        report_data = dict(task.report_data) if task.report_data else {}

        # Clear old AI-generated data but preserve user edits
        preserved_keys = {"human_report", "final_report"}
        keys_to_remove = [
            k
            for k in report_data.keys()
            if k not in preserved_keys and k != "grading_mode"
        ]
        for key in keys_to_remove:
            del report_data[key]

        report_data["grading_mode"] = grading_mode_value
        task.report_data = report_data
        flag_modified(task, "report_data")
        db.commit()

        # Create context (only primitive types for thread safety)
        ctx = GradingContext(
            task_id=task.id,
            user_id=user_id,
            team_id=team.id,
            prompt=prompt,
            attachments=attachments,
            grading_timeout=3600,
            model_id=model_id,
            force_override_bot_model=force_override_bot_model,
        )

        # Create strategy
        from wecode.service.evaluation.grading_strategies import (
            MultiModelStrategy,
            SingleModelStrategy,
        )

        strategy = (
            MultiModelStrategy(multi_model_config)
            if multi_model_config
            else SingleModelStrategy()
        )

        # Run strategy in main event loop to avoid cross-loop issues
        # The execution_dispatcher uses httpx.AsyncClient which binds to the
        # event loop where it was created (the main loop). Running strategy
        # in a separate loop causes "Future attached to different loop" errors.
        from app.core.async_utils import get_main_event_loop

        async def execute_and_handle_result():
            """Execute strategy and handle result in main event loop."""
            bg_db = SessionLocal()
            try:
                # Execute strategy
                result = await strategy.execute(ctx)

                # Get fresh task from database
                bg_task = (
                    bg_db.query(EvalGradingTask)
                    .filter(EvalGradingTask.id == ctx.task_id)
                    .first()
                )

                if not bg_task:
                    logger.error(
                        f"[GradingService] Task {ctx.task_id} not found after execution"
                    )
                    return

                # Handle result
                if result.success and result.content is not None:
                    self.complete(bg_db, bg_task, result.content)
                else:
                    error_msg = result.error_message or "Unknown error"
                    self.fail(bg_db, bg_task, error_msg)

            except Exception as e:
                logger.exception(f"[GradingService] Strategy execution failed: {e}")
                try:
                    bg_task = (
                        bg_db.query(EvalGradingTask)
                        .filter(EvalGradingTask.id == ctx.task_id)
                        .first()
                    )
                    if bg_task:
                        self.fail(bg_db, bg_task, str(e))
                except Exception as inner_e:
                    logger.exception(
                        f"[GradingService] Failed to update task: {inner_e}"
                    )
            finally:
                bg_db.close()

        # Schedule in main event loop using run_coroutine_threadsafe
        # This avoids creating a new event loop and the cross-loop issues
        main_loop = get_main_event_loop()
        if main_loop is not None and main_loop.is_running():
            future = asyncio.run_coroutine_threadsafe(
                execute_and_handle_result(), main_loop
            )

            # Add callback to log any errors
            def done_callback(f):
                try:
                    f.result()
                except Exception as e:
                    logger.exception(
                        f"[GradingService] Async execution failed for task {ctx.task_id}: {e}"
                    )

            future.add_done_callback(done_callback)
            logger.info(
                f"[GradingService] Scheduled grading task {task.id} in main event loop"
            )
        else:
            # Fallback: run in background thread with new event loop
            # This may still have cross-loop issues but is better than failing immediately
            logger.warning(
                f"[GradingService] Main event loop not available, "
                f"falling back to background thread for task {task.id}"
            )

            def run_in_thread():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(execute_and_handle_result())
                finally:
                    loop.close()

            thread = threading.Thread(target=run_in_thread, daemon=True)
            thread.start()

        return task

    # ==================== Prompt Building ====================

    def _build_prompt(
        self,
        db: Session,
        task: EvalGradingTask,
        prompt_type: str = "single",
        multi_model_config: Optional[MultiModelGradingConfig] = None,
    ) -> str:
        """Build grading prompt based on type.

        Args:
            db: Database session
            task: The grading task
            prompt_type: One of "single", "scorer"
            multi_model_config: Config for multi-model mode (not used here, for aggregator)

        Returns:
            Formatted prompt string

        Supported template variables:
            - single/scorer: {user_id}, {grading_task_id}, {topic_id}, {question_id}, {question_title}

        Note: Aggregator prompt is built by MultiModelStrategy._build_aggregator_prompt
        """
        from wecode.service.evaluation.question_service import QuestionService
        from wecode.service.evaluation.topic_service import TopicService

        question_service = QuestionService()
        topic_service = TopicService()

        question = question_service.get(db, task.question_id)
        question_title = question.title if question else f"Question #{task.question_id}"
        topic_id = question.topic_id if question else 0
        topic = topic_service.get(db, topic_id) if topic_id else None

        # Get template based on type
        if prompt_type == "scorer":
            template = (
                topic.grading_team_config.get("scorer_prompt_template")
                if topic and topic.grading_team_config
                else None
            )
            template_name = "scorer_prompt_template"
        else:
            template = (
                topic.grading_team_config.get("prompt_template")
                if topic and topic.grading_team_config
                else None
            )
            template_name = "prompt_template"

        if not template:
            raise ValueError(f"{template_name} is required in grading configuration")

        # Build format kwargs
        format_kwargs = {
            "user_id": task.respondent_id,
            "grading_task_id": task.id,
            "topic_id": topic_id,
            "question_id": task.question_id,
            "question_title": question_title,
        }

        try:
            return template.format(**format_kwargs)
        except KeyError as e:
            raise ValueError(
                f"Template has unsupported placeholder {e}. "
                f"Supported: user_id, grading_task_id, topic_id, question_id, question_title"
            )

    # ==================== Attachment Collection ====================

    def _collect_attachments(
        self, answer: EvalAnswer, question: Optional[Any] = None
    ) -> List[AttachmentInfo]:
        """Collect attachments from answer content_data.

        Only collects attachments from slots defined in question.content_data.answerSlots.
        """
        attachments = []
        content_data = self._parse_json_field(answer.content_data)
        if not isinstance(content_data, dict):
            return attachments

        # Get defined slot keys from question
        defined_slot_keys: Optional[set] = None
        if question and question.content_data:
            question_content = self._parse_json_field(question.content_data)
            if isinstance(question_content, dict):
                answer_slots = question_content.get("answerSlots", [])
                if answer_slots:
                    defined_slot_keys = {
                        slot.get("key")
                        for slot in answer_slots
                        if isinstance(slot, dict) and slot.get("key")
                    }

        def collect_from_list(file_list: List[Dict]) -> None:
            for file_info in file_list:
                if isinstance(file_info, dict) and file_info.get("key"):
                    attachments.append(
                        AttachmentInfo(
                            key=file_info["key"],
                            filename=file_info.get("filename", "unnamed"),
                            content_type=file_info.get(
                                "contentType", "application/octet-stream"
                            ),
                        )
                    )

        def collect_from_slot(slot_value: Any) -> None:
            if isinstance(slot_value, list):
                collect_from_list(slot_value)
            elif isinstance(slot_value, dict) and isinstance(
                slot_value.get("files"), list
            ):
                collect_from_list(slot_value["files"])

        # New structure: answers dict with slot keys
        answers_data = content_data.get("answers", {})
        for slot_key, slot_value in answers_data.items():
            if defined_slot_keys is None or slot_key in defined_slot_keys:
                collect_from_slot(slot_value)

        # Legacy structure: attachments dict
        attachments_data = content_data.get("attachments", {})
        for slot_key, slot_value in attachments_data.items():
            if defined_slot_keys is None or slot_key in defined_slot_keys:
                collect_from_slot(slot_value)

        return attachments

    def _parse_json_field(self, field_data: Any) -> Any:
        """Parse a field that may be a JSON string or already a dict."""
        if isinstance(field_data, str):
            try:
                return json.loads(field_data) if field_data else {}
            except json.JSONDecodeError:
                return {}
        return field_data

    # ==================== Report Storage ====================

    def _save_report_to_s3(
        self, db: Session, task: EvalGradingTask, content: str, is_draft: bool
    ) -> Optional[str]:
        """Save a report to S3."""
        from wecode.service.evaluation.question_service import QuestionService

        question_service = QuestionService()
        question = question_service.get(db, task.question_id)
        topic_id = question.topic_id if question else 0

        return self._storage_service.save_grading_report(
            respondent_id=task.respondent_id,
            topic_id=topic_id,
            question_id=task.question_id,
            content=content,
            is_draft=is_draft,
        )


# ==================== Helper Functions ====================


def get_grading_team_id(grading_config: Optional[Dict]) -> Optional[int]:
    """Extract the appropriate team_id from grading config based on grading mode."""
    if not grading_config:
        return None

    grading_mode = grading_config.get("grading_mode", "single")
    if grading_mode == "multi":
        return grading_config.get("scorer_team_id")
    return grading_config.get("team_id")


def build_multi_model_config(
    grading_config: Optional[Dict],
) -> Optional[MultiModelGradingConfig]:
    """Build MultiModelGradingConfig from grading config dict."""
    if not grading_config:
        return None

    grading_mode = grading_config.get("grading_mode", "single")
    if grading_mode != "multi":
        return None

    scorer_team_id = grading_config.get("scorer_team_id")
    aggregator_team_id = grading_config.get("aggregator_team_id")
    scorer_models_data = grading_config.get("scorer_models", [])
    aggregator_model_data = grading_config.get("aggregator_model")

    if not all(
        [scorer_team_id, aggregator_team_id, scorer_models_data, aggregator_model_data]
    ):
        return None

    scorer_models = [ScorerModelConfig(**m) for m in scorer_models_data]
    aggregator_model = AggregatorModelConfig(**aggregator_model_data)

    return MultiModelGradingConfig(
        scorer_team_id=scorer_team_id,
        aggregator_team_id=aggregator_team_id,
        scorer_models=scorer_models,
        aggregator_model=aggregator_model,
        scorer_prompt_template=grading_config.get("scorer_prompt_template"),
        aggregator_prompt_template=grading_config.get("aggregator_prompt_template"),
    )


# Module-level instance for backward compatibility
grading_service = GradingService()
