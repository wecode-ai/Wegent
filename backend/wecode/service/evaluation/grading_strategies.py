# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Grading strategy implementations for evaluation module."""

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
from wecode.service.evaluation.grading_base import GradingContext, GradingStrategy

logger = logging.getLogger(__name__)


@dataclass
class ScorerResult:
    """Result from a single scorer model."""

    task_id: int
    model_id: str
    content: str
    status: str
    error_message: Optional[str] = None
    s3_path: Optional[str] = None


class SingleModelStrategy(GradingStrategy):
    """Strategy for single model grading."""

    async def execute(self, ctx: GradingContext) -> None:
        """Execute single model grading.

        Note: This method runs in a background thread. It creates its own
        database session and handles all database operations independently.
        """
        logger.info(f"[SingleModelStrategy] Starting grading for task {ctx.task_id}")
        await self._execute_grading_async(ctx)

    async def _execute_grading_async(self, ctx: GradingContext) -> None:
        """Execute grading asynchronously in background thread."""
        db = SessionLocal()

        try:
            task = (
                db.query(EvalGradingTask)
                .filter(EvalGradingTask.id == ctx.task_id)
                .first()
            )
            if not task:
                logger.error(
                    f"[SingleModelStrategy] Grading task {ctx.task_id} not found"
                )
                return

            user = db.query(User).filter(User.id == ctx.user_id).first()
            if not user:
                await self._update_task_failed(
                    db, ctx.task_id, f"User {ctx.user_id} not found"
                )
                return

            team = (
                db.query(Kind)
                .filter(Kind.id == ctx.team_id, Kind.is_active == True)
                .first()
            )
            if not team:
                await self._update_task_failed(
                    db, ctx.task_id, f"Team {ctx.team_id} not found"
                )
                return

            task_params = TaskCreationParams(
                message=ctx.prompt,
                title=f"[Grading] Task #{task.id}",
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

            task.task_id = wegent_task.id
            db.commit()

            if ctx.attachments:
                await self._copy_attachments_to_context(
                    db, user_subtask.id, user.id, ctx.attachments
                )
                db.commit()

            await self._trigger_ai_response(
                db, wegent_task, user_subtask, assistant_subtask, team, user, ctx.prompt
            )

            content, error = await self._wait_for_subtask_completion(
                db, assistant_subtask.id, timeout=ctx.grading_timeout
            )

            if error:
                logger.error(f"[SingleModelStrategy] Grading failed: {error}")
                await self._update_task_failed(db, ctx.task_id, error)
                return

            self._complete_task(db, task, content)
            logger.info(
                f"[SingleModelStrategy] Successfully completed grading task {task.id}"
            )

        except Exception as e:
            logger.exception(
                f"[SingleModelStrategy] Error in grading task {ctx.task_id}"
            )
            await self._update_task_failed(db, ctx.task_id, str(e))
        finally:
            db.close()


class MultiModelStrategy(GradingStrategy):
    """Strategy for multi-model grading with aggregation."""

    def __init__(self, config: MultiModelGradingConfig):
        super().__init__()
        self._config = config

    async def execute(self, ctx: GradingContext) -> None:
        """Execute multi-model grading.

        Note: This method runs in a background thread. It creates its own
        database session and handles all database operations independently.
        """
        logger.info(
            f"[MultiModelStrategy] Starting multi-model grading for task {ctx.task_id} "
            f"with {len(self._config.scorer_models)} scorers"
        )
        await self._execute_multi_model_grading_async(ctx)

    async def _execute_multi_model_grading_async(self, ctx: GradingContext) -> None:
        """Execute multi-model grading workflow asynchronously with overall timeout."""
        db = SessionLocal()
        start_time = time.time()

        try:
            task = (
                db.query(EvalGradingTask)
                .filter(EvalGradingTask.id == ctx.task_id)
                .first()
            )
            if not task:
                logger.error(
                    f"[MultiModelStrategy] Grading task {ctx.task_id} not found"
                )
                return

            user = db.query(User).filter(User.id == ctx.user_id).first()
            if not user:
                await self._update_task_failed(
                    db, ctx.task_id, f"User {ctx.user_id} not found"
                )
                return

            # Phase 1: Execute all scorers in parallel
            scorer_count = len(self._config.scorer_models)
            logger.info(
                f"[MultiModelStrategy] Phase 1: Executing {scorer_count} scorers"
            )
            if scorer_count == 0:
                logger.error("[MultiModelStrategy] No scorer models configured!")
                await self._update_task_failed(
                    db, ctx.task_id, "No scorer models configured"
                )
                return
            scorer_results = await self._execute_scorers(
                db, task, user, ctx, start_time
            )

            successful_scorers = [
                r for r in scorer_results if r.status == "completed" and r.content
            ]
            failed_scorers = [
                r for r in scorer_results if r.status != "completed" or not r.content
            ]

            logger.info(
                f"[MultiModelStrategy] Scorer results: {len(successful_scorers)} successful, {len(failed_scorers)} failed"
            )
            for r in scorer_results:
                logger.info(
                    f"  - {r.model_id}: status={r.status}, content_length={len(r.content) if r.content else 0}, error={r.error_message}"
                )

            if not successful_scorers:
                await self._update_task_failed(
                    db, ctx.task_id, "All scorer models failed to produce results"
                )
                return

            logger.info(f"[MultiModelStrategy] Storing scorer results to database...")
            try:
                self._store_scorer_results(db, task, scorer_results)
                logger.info(f"[MultiModelStrategy] Scorer results stored successfully")
            except Exception as e:
                logger.exception(
                    f"[MultiModelStrategy] Failed to store scorer results: {e}"
                )
                raise  # Re-raise to trigger task failure

            # Phase 2: Execute aggregator
            logger.info("[MultiModelStrategy] Phase 2: Executing aggregator")
            logger.info(
                f"[MultiModelStrategy] Aggregator config: team_id={self._config.aggregator_team_id}, model_id={self._config.aggregator_model.model_id}"
            )
            final_report = await self._execute_aggregator(
                db, task, user, successful_scorers, ctx, start_time
            )

            if not final_report:
                logger.error("[MultiModelStrategy] Aggregator returned no final report")
                await self._update_task_failed(
                    db, ctx.task_id, "Aggregator failed to produce final report"
                )
                return
            else:
                logger.info(
                    f"[MultiModelStrategy] Aggregator produced report of length {len(final_report)}"
                )

            # Complete the task with final report
            self._complete_task(db, task, final_report)

            logger.info(
                f"[MultiModelStrategy] Successfully completed multi-model grading for task {ctx.task_id}"
            )

        except Exception as e:
            logger.exception(
                f"[MultiModelStrategy] Unexpected error in multi-model grading task {ctx.task_id}"
            )
            await self._update_task_failed(db, ctx.task_id, f"Unexpected error: {e}")
        finally:
            db.close()

    async def _execute_scorers(
        self,
        db: Session,
        task: EvalGradingTask,
        user: User,
        ctx: GradingContext,
        start_time: float,
    ) -> List[ScorerResult]:
        """Execute all scorer models in parallel with shared overall timeout.

        Each scorer creates its own database session to avoid concurrent session issues.
        """

        # Create separate tasks that each manage their own database session
        async def run_scorer_with_own_session(
            scorer_config: ScorerModelConfig,
        ) -> ScorerResult:
            scorer_db = SessionLocal()
            try:
                # Each scorer queries its own objects to avoid session conflicts
                scorer_task = (
                    scorer_db.query(EvalGradingTask)
                    .filter(EvalGradingTask.id == ctx.task_id)
                    .first()
                )
                if not scorer_task:
                    return ScorerResult(
                        task_id=0,
                        model_id=scorer_config.model_id,
                        content="",
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
                        content="",
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
                        content="",
                        status="failed",
                        error_message=str(result),
                    )
                )
            else:
                logger.info(
                    f"[MultiModelStrategy] Scorer {i} ({model_id}) completed with status={result.status}"
                )
                scorer_results.append(result)

        logger.info(
            f"[MultiModelStrategy] _execute_scorers returning {len(scorer_results)} results"
        )
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
        """Execute a single scorer model with remaining timeout."""
        model_id = scorer_config.model_id

        try:
            elapsed = time.time() - start_time
            remaining_timeout = max(60, ctx.grading_timeout - int(elapsed))

            if elapsed >= ctx.grading_timeout:
                return ScorerResult(
                    task_id=0,
                    model_id=model_id,
                    content="",
                    status="failed",
                    error_message="Overall grading timeout exceeded before scorer started",
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
                    content="",
                    status="failed",
                    error_message=f"Team {team_id} not found",
                )

            task_params = TaskCreationParams(
                message=ctx.prompt,
                title=f"[Scorer-{model_id}] Grading Task #{task.id}",
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

            if ctx.attachments:
                await self._copy_attachments_to_context(
                    db, user_subtask.id, user.id, ctx.attachments
                )
                db.commit()

            # Trigger AI response
            logger.info(
                f"[MultiModelStrategy] Scorer {model_id}: Triggering AI response"
            )
            await self._trigger_ai_response(
                db, wegent_task, user_subtask, assistant_subtask, team, user, ctx.prompt
            )

            logger.info(
                f"[MultiModelStrategy] Scorer {model_id}: Waiting for AI completion (subtask_id={assistant_subtask.id})"
            )
            content, error = await self._wait_for_subtask_completion(
                db, assistant_subtask.id, timeout=remaining_timeout
            )
            logger.info(
                f"[MultiModelStrategy] Scorer {model_id}: Wait completed, content_length={len(content) if content else 0}, error={error}"
            )

            s3_path = (
                self._save_scorer_result_to_s3(db, task, model_id, content)
                if content
                else None
            )

            logger.info(
                f"[MultiModelStrategy] Scorer {model_id}: Returning result with status={'completed' if content else 'failed'}"
            )
            return ScorerResult(
                task_id=wegent_task.id,
                model_id=model_id,
                content=content or "",
                status="completed" if content else "failed",
                error_message=error,
                s3_path=s3_path,
            )

        except Exception as e:
            logger.exception(f"[MultiModelStrategy] Scorer {model_id} execution failed")
            return ScorerResult(
                task_id=0,
                model_id=model_id,
                content="",
                status="failed",
                error_message=str(e),
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
        """Execute aggregator model with all scorer results using remaining timeout."""
        logger.info(
            f"[MultiModelStrategy] _execute_aggregator called with {len(scorer_results)} scorer results"
        )
        try:
            elapsed = time.time() - start_time
            remaining_timeout = max(60, ctx.grading_timeout - int(elapsed))

            if elapsed >= ctx.grading_timeout:
                logger.error(
                    f"[MultiModelStrategy] Aggregator timeout: {ctx.grading_timeout}s exceeded"
                )
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
                    f"[MultiModelStrategy] Aggregator team {self._config.aggregator_team_id} not found"
                )
                return None

            aggregator_prompt = self._build_aggregator_prompt(task, scorer_results)

            task_params = TaskCreationParams(
                message=aggregator_prompt,
                title=f"[Aggregator] Grading Task #{task.id}",
                is_group_chat=False,
                model_id=self._config.aggregator_model.model_id,
                force_override_bot_model=self._config.aggregator_model.force_override,
            )

            logger.info(
                f"[MultiModelStrategy] Creating aggregator chat task with team_id={self._config.aggregator_team_id}"
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

            logger.info(
                f"[MultiModelStrategy] Aggregator chat task created: task_id={wegent_task.id}, assistant_subtask_id={assistant_subtask.id}"
            )

            # Store aggregator task ID in report_data
            report_data = dict(task.report_data) if task.report_data else {}
            report_data.setdefault("multi_model_grading", {})[
                "aggregator_task_id"
            ] = wegent_task.id
            task.report_data = report_data
            flag_modified(task, "report_data")
            db.commit()

            # Trigger AI response
            logger.info(f"[MultiModelStrategy] Aggregator: Triggering AI response")
            await self._trigger_ai_response(
                db,
                wegent_task,
                user_subtask,
                assistant_subtask,
                team,
                user,
                aggregator_prompt,
            )

            logger.info(
                f"[MultiModelStrategy] Aggregator: Waiting for AI completion with timeout {remaining_timeout}s"
            )

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
        self, task: EvalGradingTask, scorer_results: List[ScorerResult]
    ) -> str:
        """Build the prompt for the aggregator model."""
        from wecode.service.evaluation.question_service import QuestionService
        from wecode.service.evaluation.topic_service import TopicService

        question = QuestionService().get(self._get_db_for_service(), task.question_id)
        question_title = question.title if question else f"Question #{task.question_id}"

        scorer_results_text = "\n\n".join(
            f"--- 评分专家 {i+1} (模型: {r.model_id}) ---\n{r.content}"
            for i, r in enumerate(scorer_results)
        )

        template = (
            self._config.aggregator_prompt_template
            or self._default_aggregator_template()
        )
        return template.format(
            question_title=question_title,
            answer_summary="[用户提交内容见评分专家结果]",
            scorer_results=scorer_results_text,
        )

    def _default_aggregator_template(self) -> str:
        return """你是一位评分结果汇总专家。请综合以下多个评分专家的结果，给出最终评分报告。

原始题目：
{question_title}

用户提交内容摘要：
{answer_summary}

评分专家结果：
{scorer_results}

请分析：
1. 各专家评分的差异和共识点
2. 最终得分（综合各专家意见，给出合理的最终分数）
3. 综合评语（整合各专家意见，给出全面的评价）
4. 主要改进建议

请输出格式化的最终评分报告。"""

    def _store_scorer_results(
        self, db: Session, task: EvalGradingTask, scorer_results: List[ScorerResult]
    ) -> None:
        """Store scorer results in task report_data."""
        scoring_results_data = [
            {
                "task_id": r.task_id,
                "model_id": r.model_id,
                "content": r.content,
                "status": r.status,
                "error_message": r.error_message,
                "s3_path": r.s3_path,
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

    def _save_scorer_result_to_s3(
        self, db: Session, task: EvalGradingTask, model_id: str, content: str
    ) -> Optional[str]:
        """Save a scorer result to S3."""
        from wecode.models.evaluation import EvalQuestion
        from wecode.service.evaluation.topic_service import TopicService

        question = db.query(EvalQuestion).filter_by(id=task.question_id).first()
        if not question:
            return None

        topic = TopicService().get(db, question.topic_id)
        topic_id = topic.id if topic else 0

        return self._storage_service.save_grading_report(
            respondent_id=task.respondent_id,
            topic_id=topic_id,
            question_id=task.question_id,
            content=content,
            is_draft=True,
        )

    def _get_db_for_service(self) -> Session:
        """Get a new database session for service calls."""
        return SessionLocal()
