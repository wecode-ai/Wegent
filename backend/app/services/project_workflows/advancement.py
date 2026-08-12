# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Stage completion validation and workflow progression."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_workflow import (
    TaskStageRun,
    TaskWorkflowArtifact,
    TaskWorkflowRun,
)
from app.services.loop_item_executions.service import utcnow
from app.services.project_workflows.state import (
    STAGE_TERMINAL_STATUSES,
    StageStatus,
    WorkflowStatus,
)


class WorkflowAdvancementMixin:
    """Stage completion validation and workflow progression."""

    def _validate_completed_stage(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        stage: TaskStageRun,
    ) -> None:
        required = set(stage.input_snapshot.get("requiredOutputs") or [])
        artifacts = (
            db.query(TaskWorkflowArtifact)
            .filter(TaskWorkflowArtifact.stage_run_id == stage.id)
            .order_by(TaskWorkflowArtifact.created_at.asc())
            .all()
        )
        produced = {artifact.artifact_type for artifact in artifacts}
        missing = sorted(required - produced)
        stage.completed_at = utcnow()
        if missing:
            stage.status = StageStatus.FAILED.value
            stage.failure_code = "required_artifact_missing"
            stage.failure_message = (
                "Execution completed without required artifacts: " + ", ".join(missing)
            )
        else:
            stage.status = StageStatus.PASSED.value
            stage.failure_code = ""
            stage.failure_message = ""
            stage.output_json = {
                "artifacts": [
                    {
                        "id": artifact.id,
                        "type": artifact.artifact_type,
                        "schemaVersion": artifact.schema_version,
                    }
                    for artifact in artifacts
                ]
            }
        task = db.get(LoopItem, run.loop_item_id)
        if task:
            self._advance_after_stage_terminal(
                db,
                run=run,
                stage=stage,
                task=task,
                user_id=int(run.started_by_id or 0),
            )

    def _advance_after_stage_terminal(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        stage: TaskStageRun,
        task: LoopItem,
        user_id: int,
    ) -> None:
        if stage.status in {
            StageStatus.FAILED.value,
            StageStatus.REJECTED.value,
        }:
            group = self._workflow_group(run, stage.group_key)
            if group.get("completion") != "any":
                self._set_run_failed_or_blocked(
                    run,
                    code=stage.failure_code or "stage_failed",
                    message=stage.failure_message or "Workflow stage failed",
                )
                return
        if self._queue_next_squad_members(
            db,
            run=run,
            stage=stage,
            task=task,
            user_id=user_id,
        ):
            self._refresh_run_active_status(db, run)
            return
        group = self._workflow_group(run, stage.group_key)
        latest = self._latest_group_stage_runs(db, run.id, stage.group_key)
        if group.get("execution") == "serial":
            node_key = str(
                stage.input_snapshot.get("workflowNodeKey") or stage.node_key
            )
            node_runs = [
                item
                for item in latest
                if str(item.input_snapshot.get("workflowNodeKey") or item.node_key)
                == node_key
            ]
            if not node_runs or any(
                item.status
                not in {
                    StageStatus.PASSED.value,
                    StageStatus.SKIPPED.value,
                }
                for item in node_runs
            ):
                self._refresh_run_active_status(db, run)
                return
            nodes = group.get("nodes") or []
            node_index = next(
                (
                    index
                    for index, node in enumerate(nodes)
                    if node.get("key") == node_key
                ),
                -1,
            )
            if node_index + 1 < len(nodes):
                binding = self._task_binding(db, run.loop_item_id)
                self._create_node_stage_runs(
                    db,
                    run=run,
                    group=group,
                    node=nodes[node_index + 1],
                    fallback_binding=binding,
                    task=task,
                    user_id=user_id,
                )
                self._refresh_run_active_status(db, run)
                return
            self._advance_to_next_group(
                db,
                run=run,
                group_key=group["key"],
                task=task,
                user_id=user_id,
            )
            return

        completion = group.get("completion", "all")
        passed = [
            item
            for item in latest
            if item.status
            in {
                StageStatus.PASSED.value,
                StageStatus.SKIPPED.value,
            }
        ]
        if completion == "any" and passed:
            self._cancel_other_group_stages(db, run.id, stage.group_key)
            self._advance_to_next_group(
                db,
                run=run,
                group_key=group["key"],
                task=task,
                user_id=user_id,
            )
            return
        if any(
            StageStatus(item.status) not in STAGE_TERMINAL_STATUSES for item in latest
        ):
            self._refresh_run_active_status(db, run)
            return
        if completion == "all" and len(passed) == len(latest):
            self._advance_to_next_group(
                db,
                run=run,
                group_key=group["key"],
                task=task,
                user_id=user_id,
            )
            return
        failed = next(
            (
                item
                for item in latest
                if item.status
                in {
                    StageStatus.FAILED.value,
                    StageStatus.REJECTED.value,
                }
            ),
            stage,
        )
        self._set_run_failed_or_blocked(
            run,
            code=failed.failure_code or "stage_group_failed",
            message=failed.failure_message or "No parallel stage satisfied the group",
        )

    def _queue_next_squad_members(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        stage: TaskStageRun,
        task: LoopItem,
        user_id: int,
    ) -> bool:
        squad_id = str(stage.input_snapshot.get("squadId") or "")
        if not squad_id:
            return False
        workflow_node_key = str(
            stage.input_snapshot.get("workflowNodeKey") or stage.node_key
        )
        stages = (
            db.query(TaskStageRun)
            .filter(
                TaskStageRun.workflow_run_id == run.id,
                TaskStageRun.group_key == stage.group_key,
            )
            .order_by(TaskStageRun.created_at.asc())
            .all()
        )
        stages = [
            item
            for item in stages
            if str(item.input_snapshot.get("squadId") or "") == squad_id
            and str(item.input_snapshot.get("workflowNodeKey") or item.node_key)
            == workflow_node_key
        ]
        max_parallel = max(
            1,
            int(stage.input_snapshot.get("squadMaxParallel") or 1),
        )
        active = [
            item
            for item in stages
            if item.status
            in {
                StageStatus.QUEUED.value,
                StageStatus.CLAIMED.value,
                StageStatus.RUNNING.value,
            }
        ]
        pending = [item for item in stages if item.status == StageStatus.PENDING.value]
        for item in pending[: max(0, max_parallel - len(active))]:
            self._create_execution_for_stage(
                db,
                run=run,
                stage=item,
                task=task,
                user_id=user_id,
            )
        return bool(
            pending
            or active
            or any(
                item.status
                not in {
                    StageStatus.PASSED.value,
                    StageStatus.SKIPPED.value,
                }
                for item in stages
            )
        )

    def _advance_to_next_group(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        group_key: str,
        task: LoopItem,
        user_id: int,
    ) -> None:
        groups = run.workflow_definition_snapshot.get("stages") or []
        index = next(
            (
                position
                for position, group in enumerate(groups)
                if group.get("key") == group_key
            ),
            -1,
        )
        if index + 1 >= len(groups):
            run.status = WorkflowStatus.COMPLETED.value
            run.current_group_key = ""
            run.completed_at = utcnow()
            run.failure_code = ""
            run.failure_message = ""
            return
        next_group = groups[index + 1]
        run.current_group_key = next_group["key"]
        binding = self._task_binding(db, run.loop_item_id)
        self._create_group_stage_runs(
            db,
            run=run,
            group=next_group,
            fallback_binding=binding,
            task=task,
            user_id=user_id,
        )
        self._refresh_run_active_status(db, run)

    @staticmethod
    def _cancel_other_group_stages(
        db: Session,
        run_id: str,
        group_key: str,
    ) -> None:
        now = utcnow()
        rows = (
            db.query(TaskStageRun)
            .filter(
                TaskStageRun.workflow_run_id == run_id,
                TaskStageRun.group_key == group_key,
                TaskStageRun.status.notin_(
                    [stage.value for stage in STAGE_TERMINAL_STATUSES]
                ),
            )
            .all()
        )
        for row in rows:
            execution = (
                db.get(LoopItemExecution, row.loop_item_execution_id)
                if row.loop_item_execution_id
                else None
            )
            if execution and execution.status not in {
                "completed",
                "failed",
                "cancelled",
            }:
                execution.status = "cancelled"
                execution.completed_at = now
                execution.execution_note = "Parallel group already satisfied"
            row.status = StageStatus.CANCELLED.value
            row.completed_at = now
            row.version += 1

    @staticmethod
    def _latest_group_stage_runs(
        db: Session,
        run_id: str,
        group_key: str,
    ) -> list[TaskStageRun]:
        rows = (
            db.query(TaskStageRun)
            .filter(
                TaskStageRun.workflow_run_id == run_id,
                TaskStageRun.group_key == group_key,
            )
            .order_by(TaskStageRun.attempt.asc())
            .all()
        )
        latest: dict[str, TaskStageRun] = {}
        for row in rows:
            latest[row.node_key] = row
        return list(latest.values())

    @staticmethod
    def _refresh_run_active_status(db: Session, run: TaskWorkflowRun) -> None:
        db.flush()
        statuses = {
            row[0]
            for row in db.query(TaskStageRun.status)
            .filter(
                TaskStageRun.workflow_run_id == run.id,
                TaskStageRun.group_key == run.current_group_key,
            )
            .all()
        }
        if StageStatus.WAITING_APPROVAL.value in statuses:
            run.status = WorkflowStatus.WAITING_APPROVAL.value
        elif statuses & {
            StageStatus.RUNNING.value,
            StageStatus.CLAIMED.value,
        }:
            run.status = WorkflowStatus.RUNNING.value
        elif statuses & {
            StageStatus.QUEUED.value,
            StageStatus.PENDING.value,
        }:
            run.status = WorkflowStatus.QUEUED.value

    @staticmethod
    def _set_run_failed_or_blocked(
        run: TaskWorkflowRun,
        *,
        code: str,
        message: str,
    ) -> None:
        policy = str(
            run.workflow_definition_snapshot.get("failurePolicy")
            or run.workflow_definition_snapshot.get("failure_policy")
            or "pause"
        )
        run.status = (
            WorkflowStatus.FAILED.value
            if policy == "stop"
            else WorkflowStatus.BLOCKED.value
        )
        run.failure_code = code
        run.failure_message = message
        if run.status == WorkflowStatus.FAILED.value:
            run.completed_at = utcnow()
