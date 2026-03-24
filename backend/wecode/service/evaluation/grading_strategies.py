# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Grading strategy implementations for evaluation module.

This module contains concrete strategy implementations:
- SingleModelStrategy: Single model grading
- MultiModelStrategy: Multi-model grading with aggregation

Key design:
- Strategies return GradingResult, NOT modify task state directly
- Strategies do NOT import GradingService (no circular dependency)
- GradingService handles state updates based on returned result
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.chat.storage import TaskCreationParams, create_chat_task
from wecode.models.evaluation import EvalGradingTask
from wecode.schemas.evaluation import MultiModelGradingConfig, ScorerModelConfig
from wecode.service.evaluation.grading_base import (
    AttachmentInfo,
    GradingContext,
    GradingResult,
    GradingStrategy,
)

logger = logging.getLogger(__name__)


@dataclass
class ScorerResult:
    """Result from a single scorer model."""

    task_id: int
    model_id: str
    status: str
    s3_path: Optional[str] = None
    error_message: Optional[str] = None


class SingleModelStrategy(GradingStrategy):
    """Strategy for single model grading."""

    async def execute(self, ctx: GradingContext) -> GradingResult:
        """Execute single model grading and return result."""
        logger.info(f"[SingleModelStrategy] Starting grading for task {ctx.task_id}")

        db = SessionLocal()
        try:
            return await self._execute_grading(db, ctx)
        except Exception as e:
            logger.exception(
                f"[SingleModelStrategy] Error in grading task {ctx.task_id}"
            )
            return GradingResult(success=False, error_message=str(e))
        finally:
            db.close()

    async def _execute_grading(self, db: Session, ctx: GradingContext) -> GradingResult:
        """Execute grading with database session."""
        task = (
            db.query(EvalGradingTask).filter(EvalGradingTask.id == ctx.task_id).first()
        )
        if not task:
            return GradingResult(
                success=False, error_message=f"Grading task {ctx.task_id} not found"
            )

        user = db.query(User).filter(User.id == ctx.user_id).first()
        if not user:
            return GradingResult(
                success=False, error_message=f"User {ctx.user_id} not found"
            )

        team = (
            db.query(Kind)
            .filter(Kind.id == ctx.team_id, Kind.is_active == True)
            .first()
        )
        if not team:
            return GradingResult(
                success=False, error_message=f"Team {ctx.team_id} not found"
            )

        # Build unified title format
        model_id = ctx.model_id or "default"
        title = (
            f"[EVA][user_id={task.respondent_id}]"
            f"[qid={task.question_id}][{team.name}][{model_id}]"
        )

        task_params = TaskCreationParams(
            message=ctx.prompt,
            title=title,
            is_group_chat=False,
            model_id=ctx.model_id,
            force_override_bot_model=ctx.force_override_bot_model,
        )

        chat_result = await create_chat_task(
            db=db,
            user=user,
            team=team,
            message=ctx.prompt,
            params=task_params,
            task_id=None,
            should_trigger_ai=True,
            source="evaluation",
        )

        wegent_task = chat_result.task
        user_subtask = chat_result.user_subtask
        assistant_subtask = chat_result.assistant_subtask

        # Store chat task ID in both db field and report_data
        # This allows tracking the chat task even if grading fails
        task.task_id = wegent_task.id
        report_data = dict(task.report_data) if task.report_data else {}
        report_data["task_id"] = wegent_task.id
        task.report_data = report_data
        flag_modified(task, "report_data")
        db.commit()

        # Copy attachments
        if ctx.attachments:
            await self._copy_attachments_to_context(
                db, user_subtask.id, user.id, ctx.attachments
            )
            db.commit()

        # Trigger AI response
        await self._trigger_ai_response(
            db, wegent_task, user_subtask, assistant_subtask, team, user, ctx.prompt
        )

        # Wait for completion
        content, error = await self._wait_for_subtask_completion(
            db, assistant_subtask.id, timeout=ctx.grading_timeout
        )

        if error:
            logger.error(f"[SingleModelStrategy] Grading failed: {error}")
            return GradingResult(success=False, error_message=error)

        logger.info(
            f"[SingleModelStrategy] Successfully completed grading task {task.id}"
        )
        return GradingResult(success=True, content=content)


class MultiModelStrategy(GradingStrategy):
    """Strategy for multi-model grading with aggregation."""

    def __init__(self, config: MultiModelGradingConfig):
        super().__init__()
        self._config = config

    async def execute(self, ctx: GradingContext) -> GradingResult:
        """Execute multi-model grading and return result."""
        logger.info(
            f"[MultiModelStrategy] Starting multi-model grading for task {ctx.task_id} "
            f"with {len(self._config.scorer_models)} scorers"
        )

        db = SessionLocal()
        start_time = time.time()

        try:
            return await self._execute_multi_model_grading(db, ctx, start_time)
        except Exception as e:
            logger.exception(
                f"[MultiModelStrategy] Error in grading task {ctx.task_id}"
            )
            return GradingResult(success=False, error_message=f"Unexpected error: {e}")
        finally:
            db.close()

    async def _execute_multi_model_grading(
        self, db: Session, ctx: GradingContext, start_time: float
    ) -> GradingResult:
        """Execute multi-model grading workflow."""
        task = (
            db.query(EvalGradingTask).filter(EvalGradingTask.id == ctx.task_id).first()
        )
        if not task:
            return GradingResult(
                success=False, error_message=f"Grading task {ctx.task_id} not found"
            )

        user = db.query(User).filter(User.id == ctx.user_id).first()
        if not user:
            return GradingResult(
                success=False, error_message=f"User {ctx.user_id} not found"
            )

        # Phase 1: Execute all scorers in parallel
        scorer_count = len(self._config.scorer_models)
        logger.info(f"[MultiModelStrategy] Phase 1: Executing {scorer_count} scorers")

        if scorer_count == 0:
            return GradingResult(
                success=False, error_message="No scorer models configured"
            )

        scorer_results = await self._execute_scorers(db, task, user, ctx, start_time)

        successful_scorers = [
            r for r in scorer_results if r.status == "completed" and r.s3_path
        ]
        failed_scorers = [
            r for r in scorer_results if r.status != "completed" or not r.s3_path
        ]

        logger.info(
            f"[MultiModelStrategy] Scorer results: "
            f"{len(successful_scorers)} successful, {len(failed_scorers)} failed"
        )

        if not successful_scorers:
            return GradingResult(
                success=False,
                error_message="All scorer models failed to produce results",
            )

        # Store scorer results
        self._store_scorer_results(db, task, scorer_results)

        # Phase 2: Execute aggregator
        logger.info("[MultiModelStrategy] Phase 2: Executing aggregator")
        final_report = await self._execute_aggregator(
            db, task, user, successful_scorers, ctx, start_time
        )

        if not final_report:
            return GradingResult(
                success=False,
                error_message="Aggregator failed to produce final report",
            )

        logger.info(
            f"[MultiModelStrategy] Successfully completed multi-model grading "
            f"for task {ctx.task_id}"
        )

        # Return result with scorer info for potential use by service
        scorer_results_dicts = [
            {
                "task_id": r.task_id,
                "model_id": r.model_id,
                "s3_path": r.s3_path,
                "status": r.status,
                "error_message": r.error_message,
            }
            for r in scorer_results
        ]

        return GradingResult(
            success=True,
            content=final_report,
            scorer_results=scorer_results_dicts,
        )

    async def _execute_scorers(
        self,
        db: Session,
        task: EvalGradingTask,
        user: User,
        ctx: GradingContext,
        start_time: float,
    ) -> List[ScorerResult]:
        """Execute all scorer models in parallel."""

        async def run_scorer_with_own_session(
            scorer_config: ScorerModelConfig,
        ) -> ScorerResult:
            """Run scorer with its own database session."""
            scorer_db = SessionLocal()
            try:
                scorer_task = (
                    scorer_db.query(EvalGradingTask)
                    .filter(EvalGradingTask.id == ctx.task_id)
                    .first()
                )
                if not scorer_task:
                    return ScorerResult(
                        task_id=0,
                        model_id=scorer_config.model_id,
                        status="failed",
                        error_message=f"Task {ctx.task_id} not found",
                    )

                scorer_user = (
                    scorer_db.query(User).filter(User.id == ctx.user_id).first()
                )
                if not scorer_user:
                    return ScorerResult(
                        task_id=0,
                        model_id=scorer_config.model_id,
                        status="failed",
                        error_message=f"User {ctx.user_id} not found",
                    )

                return await self._execute_single_scorer(
                    scorer_db,
                    scorer_task,
                    self._config.scorer_team_id,
                    scorer_config,
                    scorer_user,
                    ctx,
                    start_time,
                )
            finally:
                scorer_db.close()

        scorer_tasks = [
            run_scorer_with_own_session(config) for config in self._config.scorer_models
        ]

        results = await asyncio.gather(*scorer_tasks, return_exceptions=True)

        scorer_results = []
        for i, result in enumerate(results):
            model_id = self._config.scorer_models[i].model_id
            if isinstance(result, Exception):
                logger.error(
                    f"[MultiModelStrategy] Scorer {i} ({model_id}) failed: {result}"
                )
                scorer_results.append(
                    ScorerResult(
                        task_id=0,
                        model_id=model_id,
                        status="failed",
                        error_message=str(result),
                    )
                )
            else:
                logger.info(
                    f"[MultiModelStrategy] Scorer {i} ({model_id}) "
                    f"completed with status={result.status}"
                )
                scorer_results.append(result)

        return scorer_results

    async def _execute_single_scorer(
        self,
        db: Session,
        task: EvalGradingTask,
        team_id: int,
        scorer_config: ScorerModelConfig,
        user: User,
        ctx: GradingContext,
        start_time: float,
    ) -> ScorerResult:
        """Execute a single scorer model."""
        model_id = scorer_config.model_id

        try:
            elapsed = time.time() - start_time
            remaining_timeout = max(60, ctx.grading_timeout - int(elapsed))

            if elapsed >= ctx.grading_timeout:
                return ScorerResult(
                    task_id=0,
                    model_id=model_id,
                    status="failed",
                    error_message="Overall grading timeout exceeded",
                )

            team = (
                db.query(Kind)
                .filter(Kind.id == team_id, Kind.is_active == True)
                .first()
            )
            if not team:
                return ScorerResult(
                    task_id=0,
                    model_id=model_id,
                    status="failed",
                    error_message=f"Team {team_id} not found",
                )

            # Build unified title format
            title = (
                f"[EVA][user_id={task.respondent_id}]"
                f"[qid={task.question_id}][{team.name}][{model_id}]"
            )

            task_params = TaskCreationParams(
                message=ctx.prompt,
                title=title,
                is_group_chat=False,
                model_id=model_id,
                force_override_bot_model=scorer_config.force_override,
            )

            chat_result = await create_chat_task(
                db=db,
                user=user,
                team=team,
                message=ctx.prompt,
                params=task_params,
                task_id=None,
                should_trigger_ai=True,
                source="evaluation",
            )

            wegent_task = chat_result.task
            user_subtask = chat_result.user_subtask
            assistant_subtask = chat_result.assistant_subtask

            # Copy attachments
            if ctx.attachments:
                await self._copy_attachments_to_context(
                    db, user_subtask.id, user.id, ctx.attachments
                )
                db.commit()

            # Trigger AI response
            await self._trigger_ai_response(
                db, wegent_task, user_subtask, assistant_subtask, team, user, ctx.prompt
            )

            # Wait for completion
            content, error = await self._wait_for_subtask_completion(
                db, assistant_subtask.id, timeout=remaining_timeout
            )

            # Save result to S3
            s3_path = None
            if content:
                s3_path = self._save_scorer_result_to_s3(db, task, model_id, content)

            return ScorerResult(
                task_id=wegent_task.id,
                model_id=model_id,
                status="completed" if s3_path else "failed",
                s3_path=s3_path,
                error_message=error,
            )

        except Exception as e:
            logger.exception(f"[MultiModelStrategy] Scorer {model_id} failed")
            return ScorerResult(
                task_id=0,
                model_id=model_id,
                status="failed",
                error_message=str(e),
            )

    def _save_scorer_result_to_s3(
        self, db: Session, task: EvalGradingTask, model_id: str, content: str
    ) -> Optional[str]:
        """Save scorer result to S3."""
        # Get topic_id from question
        from wecode.service.evaluation.question_service import QuestionService

        question_service = QuestionService()
        question = question_service.get(db, task.question_id)
        topic_id = question.topic_id if question else 0

        # Use base class utility with model-specific suffix
        suffix = f"_scorer_{model_id}"
        return self._save_content_to_s3(
            respondent_id=task.respondent_id,
            topic_id=topic_id,
            question_id=task.question_id,
            content=content,
            suffix=suffix,
        )

    async def _execute_aggregator(
        self,
        db: Session,
        task: EvalGradingTask,
        user: User,
        scorer_results: List[ScorerResult],
        ctx: GradingContext,
        start_time: float,
    ) -> Optional[str]:
        """Execute aggregator model with scorer results."""
        try:
            elapsed = time.time() - start_time
            remaining_timeout = max(60, ctx.grading_timeout - int(elapsed))

            if elapsed >= ctx.grading_timeout:
                logger.error("[MultiModelStrategy] Aggregator timeout exceeded")
                return None

            team = (
                db.query(Kind)
                .filter(
                    Kind.id == self._config.aggregator_team_id, Kind.is_active == True
                )
                .first()
            )
            if not team:
                logger.error(
                    f"[MultiModelStrategy] Aggregator team "
                    f"{self._config.aggregator_team_id} not found"
                )
                return None

            # Build aggregator prompt
            aggregator_prompt = self._build_aggregator_prompt(db, task, scorer_results)

            # Build unified title format
            aggregator_model_id = self._config.aggregator_model.model_id
            title = (
                f"[EVA][user_id={task.respondent_id}]"
                f"[qid={task.question_id}][{team.name}][{aggregator_model_id}]"
            )

            task_params = TaskCreationParams(
                message=aggregator_prompt,
                title=title,
                is_group_chat=False,
                model_id=self._config.aggregator_model.model_id,
                force_override_bot_model=self._config.aggregator_model.force_override,
            )

            chat_result = await create_chat_task(
                db=db,
                user=user,
                team=team,
                message=aggregator_prompt,
                params=task_params,
                task_id=None,
                should_trigger_ai=True,
                source="evaluation",
            )

            wegent_task = chat_result.task
            user_subtask = chat_result.user_subtask
            assistant_subtask = chat_result.assistant_subtask

            # Add scorer results as attachments
            scorer_attachments = self._build_scorer_attachments(scorer_results)
            if scorer_attachments:
                await self._copy_attachments_to_context(
                    db, user_subtask.id, user.id, scorer_attachments
                )
                db.commit()

            # Store aggregator task ID in both report_data and db field
            # db field task_id = final report producing task (aggregator for multi-model)
            task.task_id = wegent_task.id
            report_data = dict(task.report_data) if task.report_data else {}
            report_data.setdefault("multi_model_grading", {})[
                "aggregator_task_id"
            ] = wegent_task.id
            task.report_data = report_data
            flag_modified(task, "report_data")
            db.commit()

            # Trigger AI response
            await self._trigger_ai_response(
                db,
                wegent_task,
                user_subtask,
                assistant_subtask,
                team,
                user,
                aggregator_prompt,
            )

            # Wait for completion
            content, error = await self._wait_for_subtask_completion(
                db, assistant_subtask.id, timeout=remaining_timeout
            )

            if error:
                logger.error(f"[MultiModelStrategy] Aggregator failed: {error}")
                return None

            return content

        except Exception as e:
            logger.exception(f"[MultiModelStrategy] Aggregator execution failed: {e}")
            return None

    def _build_aggregator_prompt(
        self, db: Session, task: EvalGradingTask, scorer_results: List[ScorerResult]
    ) -> str:
        """Build the prompt for the aggregator model."""
        from wecode.service.evaluation.question_service import QuestionService

        question_service = QuestionService()
        question = question_service.get(db, task.question_id)
        question_title = question.title if question else f"Question #{task.question_id}"

        # Build scorer summary
        summary_lines = []
        scorer_count = 0
        for i, r in enumerate(scorer_results):
            if r.s3_path and r.status == "completed":
                summary_lines.append(
                    f"- 评分专家 {i+1}: 模型 {r.model_id} "
                    f"(见附件: scorer_{i+1}_{r.model_id}_report.md)"
                )
                scorer_count += 1
        scorer_summary = "\n".join(summary_lines)

        # Get template from config
        template = self._config.aggregator_prompt_template
        if not template:
            raise ValueError("aggregator_prompt_template is required")

        try:
            return template.format(
                question_title=question_title,
                scorer_count=scorer_count,
                scorer_summary=scorer_summary,
            )
        except KeyError as e:
            raise ValueError(
                f"Template has unsupported placeholder {e}. "
                f"Supported: question_title, scorer_count, scorer_summary"
            )

    def _build_scorer_attachments(
        self, scorer_results: List[ScorerResult]
    ) -> List[AttachmentInfo]:
        """Build attachment info list from scorer results."""
        attachments = []
        for i, result in enumerate(scorer_results):
            if result.s3_path and result.status == "completed":
                attachments.append(
                    AttachmentInfo(
                        key=result.s3_path,
                        filename=f"scorer_{i+1}_{result.model_id}_report.md",
                        content_type="text/markdown",
                    )
                )
        return attachments

    def _store_scorer_results(
        self, db: Session, task: EvalGradingTask, scorer_results: List[ScorerResult]
    ) -> None:
        """Store scorer results in task report_data."""
        scoring_results_data = [
            {
                "task_id": r.task_id,
                "model_id": r.model_id,
                "s3_path": r.s3_path,
                "status": r.status,
                "error_message": r.error_message,
            }
            for r in scorer_results
        ]

        report_data = dict(task.report_data) if task.report_data else {}
        report_data["multi_model_grading"] = {
            "grading_mode": "multi",
            "scoring_task_ids": [r.task_id for r in scorer_results],
            "scoring_results": scoring_results_data,
            "created_at": datetime.now().isoformat(),
        }
        task.report_data = report_data
        flag_modified(task, "report_data")
        db.commit()
