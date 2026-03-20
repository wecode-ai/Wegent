# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Grading service for evaluation module.

This module provides the main GradingService class which uses the Strategy Pattern
to support both single-model and multi-model grading workflows.

Usage:
    grading_service = GradingService()
    grading_service.execute(db, task, team_id, user_id, ...)
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from wecode.models.evaluation import EvalAnswer, EvalGradingTask, GradingTaskStatus
from wecode.schemas.evaluation import (
    AggregatorModelConfig,
    MultiModelGradingConfig,
    ScorerModelConfig,
)
from wecode.service.evaluation.grading_base import AttachmentInfo, GradingContext
from wecode.service.evaluation.grading_strategies import (
    MultiModelStrategy,
    SingleModelStrategy,
)
from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)


class GradingService:
    """Service for managing AI grading tasks.

    Uses Strategy Pattern to support both single-model and multi-model grading.
    """

    def __init__(self):
        self._storage_service = EvalStorageService()

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
    ) -> EvalGradingTask:
        """Create a new grading task."""
        task = EvalGradingTask(
            question_id=question_id,
            question_version=question_version,
            answer_id=answer_id,
            respondent_id=respondent_id,
            status=GradingTaskStatus.PENDING,
        )
        db.add(task)
        db.flush()

        logger.info(
            f"[GradingService] Created grading task {task.id} for "
            f"question={question_id}, answer={answer_id}"
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

                This is the main entry point for grading. It uses the Strategy Pattern
        to delegate to either SingleModelStrategy or MultiModelStrategy based on
                the configuration.
        """
        logger.info(
            f"[GradingService] Starting grading execution for task {task.id} "
            f"with team {team_id}, user {user_id}"
        )

        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError(f"User {user_id} not found")

        team = db.query(Kind).filter(Kind.id == team_id, Kind.is_active == True).first()
        if not team:
            raise ValueError(f"Team {team_id} not found or inactive")

        answer = db.query(EvalAnswer).filter(EvalAnswer.id == task.answer_id).first()
        if not answer:
            raise ValueError(f"Answer {task.answer_id} not found")

        prompt = self._build_grading_prompt(db, task, answer)
        attachments = self._collect_attachments(answer)

        # Update task status to running immediately in main thread
        task.status = GradingTaskStatus.RUNNING
        task.grading_mode = "multi" if multi_model_config else "single"
        task.started_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        db.commit()

        # Create context with ONLY primitive types (no ORM objects)
        # Background thread will query its own copies from database
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

        strategy = (
            MultiModelStrategy(multi_model_config)
            if multi_model_config
            else SingleModelStrategy()
        )

        # Start grading in background thread
        import threading

        def run_strategy():
            import asyncio

            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(strategy.execute(ctx))
            except Exception as e:
                logger.exception(f"[GradingService] Strategy execution failed: {e}")
            finally:
                loop.close()

        thread = threading.Thread(target=run_strategy, daemon=True)
        thread.start()

        return task

    def _build_grading_prompt(
        self, db: Session, task: EvalGradingTask, answer: EvalAnswer
    ) -> str:
        """Build the grading prompt from answer content."""
        from wecode.service.evaluation.question_service import QuestionService
        from wecode.service.evaluation.topic_service import TopicService

        question_service = QuestionService()
        topic_service = TopicService()

        question = question_service.get(db, task.question_id)
        question_title = question.title if question else f"Question #{task.question_id}"

        topic_id = question.topic_id if question else 0
        topic = topic_service.get(db, topic_id) if topic_id else None

        prompt_template = (
            topic.grading_team_config.get("prompt_template")
            if topic and topic.grading_team_config
            else None
        )
        answer_content = self._extract_answer_content(answer)

        if prompt_template:
            return prompt_template.format(
                user_id=task.respondent_id,
                grading_task_id=task.id,
                topic_id=topic_id,
                question_id=task.question_id,
                question_title=question_title,
                answer_content=answer_content,
            )

        return self._build_default_prompt(question_title, answer_content)

    def _extract_answer_content(self, answer: EvalAnswer) -> str:
        """Extract text content from answer."""
        content_data = self._parse_json_field(answer.content_data)
        if not isinstance(content_data, dict):
            content_data = {}

        text_parts = []

        text = content_data.get("text", "")
        if text:
            text_parts.append(text)

        inputs = content_data.get("inputs", {})
        if isinstance(inputs, dict):
            for key, value in inputs.items():
                if value and isinstance(value, str):
                    text_parts.append(f"[{key}]\n{value}")

        participant_name = content_data.get("participantName", "")
        if participant_name:
            text_parts.insert(0, f"Participant: {participant_name}")

        return "\n\n".join(text_parts) if text_parts else "[No text content provided]"

    def _build_default_prompt(self, question_title: str, answer_content: str) -> str:
        """Build default grading prompt."""
        return f"""请对以下用户提交的内容进行评分。

题目：{question_title}

用户提交内容：
{answer_content}

请提供详细的评分报告，包括：
1. 总体评价
2. 详细分析
3. 改进建议
4. 最终得分（如适用）"""

    def _collect_attachments(self, answer: EvalAnswer) -> List[AttachmentInfo]:
        """Collect attachments from answer content_data."""
        attachments = []
        content_data = self._parse_json_field(answer.content_data)
        if not isinstance(content_data, dict):
            return attachments

        attachments_data = content_data.get("attachments", {})

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

        for slot_value in attachments_data.values():
            collect_from_slot(slot_value)

        supplementary_files = content_data.get("supplementaryNotesFiles", [])
        if isinstance(supplementary_files, list):
            collect_from_list(supplementary_files)

        return attachments

    def _parse_json_field(self, field_data: Any) -> Any:
        """Parse a field that may be a JSON string or already a dict."""
        if isinstance(field_data, str):
            try:
                return json.loads(field_data) if field_data else {}
            except json.JSONDecodeError:
                return {}
        return field_data

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
        task.report_data = report_data
        flag_modified(task, "report_data")
        task.version = task.version + 1

        db.flush()
        db.commit()

        logger.info(f"[GradingService] Completed grading task {task.id}")
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
            human_report = report_data.get("human_report", {})
            ai_report = report_data.get("ai_report", {})
            final_content = human_report.get("content") or ai_report.get("content", "")

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
