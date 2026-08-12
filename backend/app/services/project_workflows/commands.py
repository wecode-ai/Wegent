# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Public commands for project workflow runs and execution state."""

import copy
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.project_workflow import (
    EPOCH_TIME,
    TaskExecutionBinding,
    TaskStageRun,
    TaskWorkflowArtifact,
    TaskWorkflowRun,
)
from app.schemas.base_role import BaseRole
from app.schemas.project_workflow import (
    ExecutionActorRef,
    ExecutionTargetRef,
    WorkflowAction,
    WorkflowArtifactCreate,
    WorkflowArtifactView,
    WorkflowRunDetailView,
    WorkflowRunView,
)
from app.services.adapters.team_kinds import team_kinds_service
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_executions.service import utcnow
from app.services.project_chat.service import bot_config
from app.services.project_workflows.common import (
    _id,
    _iso,
    _optional_text,
    _row_version,
)
from app.services.project_workflows.state import (
    STAGE_TERMINAL_STATUSES,
    StageStatus,
    WorkflowStatus,
)


class WorkflowRunCommandMixin:
    """Public commands for project workflow runs and execution state."""

    def start_task_workflow(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        idempotency_key: str,
        trigger_message_id: str | None = None,
    ) -> WorkflowRunView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        task = self._require_task(db, project_id, item_id)
        binding = (
            db.query(TaskExecutionBinding)
            .filter(TaskExecutionBinding.loop_item_id == item_id)
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task has no AI execution binding",
            )
        existing = (
            db.query(TaskWorkflowRun)
            .filter(
                TaskWorkflowRun.loop_item_id == item_id,
                TaskWorkflowRun.idempotency_key == idempotency_key,
            )
            .first()
        )
        if existing:
            return self._run_view(existing)
        if trigger_message_id:
            trigger = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.message_id == trigger_message_id,
                    ProjectChatMessage.project_id == str(project_id),
                    ProjectChatMessage.task_id == item_id,
                    ProjectChatMessage.sender_type == "user",
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .first()
            )
            if trigger is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Workflow trigger message does not belong to this task",
                )
        workflow_snapshot = self._resolve_binding_workflow_snapshot(
            db,
            project_id=project_id,
            binding=binding,
        )
        target = ExecutionTargetRef(
            type=binding.execution_target_type,
            id=_optional_text(binding.execution_target_id),
        )
        target_snapshot = self.resolve_execution_target(
            db,
            user_id=user_id,
            target=target,
        )
        groups = workflow_snapshot["stages"]
        first_group = groups[0]
        run = TaskWorkflowRun(
            id=_id(),
            loop_item_id=item_id,
            workflow_definition_id=workflow_snapshot.get("id", ""),
            workflow_definition_snapshot=workflow_snapshot,
            repository_binding_id=binding.repository_binding_id,
            execution_target_type=target.type,
            execution_target_id=target.id or "",
            execution_target_snapshot=target_snapshot,
            status=WorkflowStatus.QUEUED.value,
            current_group_key=first_group["key"],
            started_by_type="user",
            started_by_id=str(user_id),
            idempotency_key=idempotency_key,
            trigger_message_id=trigger_message_id or "",
        )
        db.add(run)
        db.flush()
        if binding.repository_binding_id:
            self._ensure_task_development_state(
                db,
                task=task,
                binding=binding,
                run=run,
            )
        self._create_group_stage_runs(
            db,
            run=run,
            group=first_group,
            fallback_binding=binding,
            task=task,
            user_id=user_id,
        )
        self._refresh_run_active_status(db, run)
        db.commit()
        db.refresh(run)
        return self._run_view(run)

    def list_task_runs(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
    ) -> list[WorkflowRunView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._require_task(db, project_id, item_id)
        rows = (
            db.query(TaskWorkflowRun)
            .filter(TaskWorkflowRun.loop_item_id == item_id)
            .order_by(TaskWorkflowRun.created_at.desc())
            .all()
        )
        return [self._run_view(row) for row in rows]

    def get_run_detail(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        user_id: int,
    ) -> WorkflowRunDetailView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        return self._run_detail_view(db, run)

    def submit_stage_artifact(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        stage_id: str,
        user_id: int,
        request: WorkflowArtifactCreate,
    ) -> WorkflowArtifactView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        stage = self._get_stage(db, run_id=run.id, stage_id=stage_id)
        if StageStatus(stage.status) in {
            StageStatus.CANCELLED,
            StageStatus.REJECTED,
            StageStatus.SKIPPED,
        }:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Artifacts cannot be submitted to a closed stage",
            )
        artifact = TaskWorkflowArtifact(
            id=_id(),
            workflow_run_id=run.id,
            stage_run_id=stage.id,
            artifact_type=request.artifact_type,
            schema_version=request.schema_version,
            content_json=copy.deepcopy(request.content),
            object_key=request.object_key or "",
            sha256=(request.sha256 or "").lower(),
            created_at=utcnow(),
        )
        db.add(artifact)
        db.flush()
        execution = (
            db.get(LoopItemExecution, stage.loop_item_execution_id)
            if stage.loop_item_execution_id
            else None
        )
        if execution and execution.status == "completed":
            self._validate_completed_stage(db, run=run, stage=stage)
        db.commit()
        db.refresh(artifact)
        return self._artifact_view(artifact)

    def approve_stage(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        stage_id: str,
        user_id: int,
        request: WorkflowAction,
    ) -> WorkflowRunDetailView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        task = self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        stage = self._get_stage(db, run_id=run.id, stage_id=stage_id)
        _row_version(stage, request.version)
        if stage.status != StageStatus.WAITING_APPROVAL.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Stage is not waiting for approval",
            )
        artifact = TaskWorkflowArtifact(
            id=_id(),
            workflow_run_id=run.id,
            stage_run_id=stage.id,
            artifact_type="approval_decision",
            content_json={
                "decision": "approved",
                "reason": request.reason or "",
                "userId": user_id,
            },
            created_at=utcnow(),
        )
        db.add(artifact)
        stage.status = StageStatus.PASSED.value
        stage.output_json = copy.deepcopy(artifact.content_json)
        stage.completed_at = utcnow()
        stage.version += 1
        self._advance_after_stage_terminal(
            db,
            run=run,
            stage=stage,
            task=task,
            user_id=user_id,
        )
        db.commit()
        db.refresh(run)
        return self._run_detail_view(db, run)

    def reject_stage(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        stage_id: str,
        user_id: int,
        request: WorkflowAction,
    ) -> WorkflowRunDetailView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        stage = self._get_stage(db, run_id=run.id, stage_id=stage_id)
        _row_version(stage, request.version)
        if stage.status != StageStatus.WAITING_APPROVAL.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Stage is not waiting for approval",
            )
        db.add(
            TaskWorkflowArtifact(
                id=_id(),
                workflow_run_id=run.id,
                stage_run_id=stage.id,
                artifact_type="approval_decision",
                content_json={
                    "decision": "rejected",
                    "reason": request.reason or "",
                    "userId": user_id,
                },
                created_at=utcnow(),
            )
        )
        stage.status = StageStatus.REJECTED.value
        stage.failure_code = "approval_rejected"
        stage.failure_message = request.reason or "Approval was rejected"
        stage.completed_at = utcnow()
        stage.version += 1
        self._set_run_failed_or_blocked(
            run,
            code=stage.failure_code,
            message=stage.failure_message,
        )
        db.commit()
        db.refresh(run)
        return self._run_detail_view(db, run)

    def retry_stage(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        stage_id: str,
        user_id: int,
        request: WorkflowAction,
    ) -> WorkflowRunDetailView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        task = self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        stage = self._get_stage(db, run_id=run.id, stage_id=stage_id)
        _row_version(stage, request.version)
        if stage.status != StageStatus.FAILED.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Only failed stages can be retried",
            )
        retry = TaskStageRun(
            id=_id(),
            workflow_run_id=run.id,
            group_key=stage.group_key,
            node_key=stage.node_key,
            node_type=stage.node_type,
            target_type=stage.target_type,
            target_id=stage.target_id,
            target_snapshot=copy.deepcopy(stage.target_snapshot),
            execution_target_type=stage.execution_target_type,
            execution_target_id=stage.execution_target_id,
            status=StageStatus.QUEUED.value,
            attempt=stage.attempt + 1,
            workspace_id=stage.workspace_id,
            input_snapshot=copy.deepcopy(stage.input_snapshot),
        )
        db.add(retry)
        db.flush()
        if retry.node_type == "agent":
            self._create_execution_for_stage(
                db,
                run=run,
                stage=retry,
                task=task,
                user_id=user_id,
            )
        elif retry.node_type == "human_gate":
            retry.status = StageStatus.WAITING_APPROVAL.value
        run.status = (
            WorkflowStatus.WAITING_APPROVAL.value
            if retry.status == StageStatus.WAITING_APPROVAL.value
            else WorkflowStatus.QUEUED.value
        )
        run.failure_code = ""
        run.failure_message = ""
        run.version += 1
        db.commit()
        db.refresh(run)
        return self._run_detail_view(db, run)

    def cancel_run(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        run_id: str,
        user_id: int,
        request: WorkflowAction,
    ) -> tuple[WorkflowRunDetailView, list[LoopItemExecution]]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._require_task(db, project_id, item_id)
        run = self._get_run(db, item_id=item_id, run_id=run_id)
        _row_version(run, request.version)
        if run.status in {
            WorkflowStatus.CANCELLED.value,
            WorkflowStatus.COMPLETED.value,
        }:
            return self._run_detail_view(db, run), []
        active_stages = (
            db.query(TaskStageRun)
            .filter(
                TaskStageRun.workflow_run_id == run.id,
                TaskStageRun.status.notin_(
                    [stage.value for stage in STAGE_TERMINAL_STATUSES]
                ),
            )
            .all()
        )
        cancelled_executions: list[LoopItemExecution] = []
        now = utcnow()
        for stage in active_stages:
            if stage.loop_item_execution_id:
                execution = db.get(
                    LoopItemExecution,
                    stage.loop_item_execution_id,
                )
                if execution and execution.status not in {
                    "completed",
                    "failed",
                    "cancelled",
                }:
                    execution.status = "cancelled"
                    execution.completed_at = now
                    execution.execution_note = request.reason or "Workflow cancelled"
                    cancelled_executions.append(execution)
            stage.status = StageStatus.CANCELLED.value
            stage.completed_at = now
            stage.version += 1
        run.status = WorkflowStatus.CANCELLED.value
        run.cancelled_at = now
        run.failure_message = request.reason or ""
        run.version += 1
        db.commit()
        db.refresh(run)
        return self._run_detail_view(db, run), cancelled_executions

    def sync_execution_state(
        self,
        db: Session,
        *,
        execution_id: int,
    ) -> None:
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or not execution.workflow_run_id
            or not execution.stage_run_id
        ):
            return
        run = db.get(TaskWorkflowRun, execution.workflow_run_id)
        stage = db.get(TaskStageRun, execution.stage_run_id)
        if run is None or stage is None:
            return
        if execution.runtime_device_id:
            stage.runtime_instance_id = execution.runtime_device_id
        if execution.runtime_task_id:
            stage.runtime_task_id = execution.runtime_task_id
        if execution.status == "claimed":
            stage.status = StageStatus.CLAIMED.value
        elif execution.status == "running":
            stage.status = StageStatus.RUNNING.value
            if stage.started_at == EPOCH_TIME:
                stage.started_at = utcnow()
            if run.status in {
                WorkflowStatus.QUEUED.value,
                WorkflowStatus.BLOCKED.value,
            }:
                run.status = WorkflowStatus.RUNNING.value
        elif execution.status == "queued":
            stage.status = StageStatus.QUEUED.value
            run.status = WorkflowStatus.QUEUED.value
        elif execution.status == "completed":
            self._validate_completed_stage(db, run=run, stage=stage)
        elif execution.status == "failed":
            stage.status = StageStatus.FAILED.value
            stage.failure_code = "execution_failed"
            stage.failure_message = execution.error_message or "Execution failed"
            stage.completed_at = utcnow()
            task = db.get(LoopItem, run.loop_item_id)
            if task:
                self._advance_after_stage_terminal(
                    db,
                    run=run,
                    stage=stage,
                    task=task,
                    user_id=int(run.started_by_id or 0),
                )
        elif execution.status == "cancelled":
            stage.status = StageStatus.CANCELLED.value
            stage.completed_at = utcnow()
        stage.version += 1
        run.version += 1
        db.commit()

    def resolve_actor(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        actor: ExecutionActorRef,
    ) -> dict[str, Any]:
        if actor.type == "project_agent":
            agent = self._get_agent(db, project_id, str(actor.id))
            return {
                "type": actor.type,
                "id": agent.id,
                "name": agent.title or agent.name or "",
                "version": agent.version,
                "config": bot_config(agent),
            }
        if actor.type == "project_squad":
            squad = self._get_squad(db, project_id, str(actor.id))
            members = [
                self.resolve_actor(
                    db,
                    project_id=project_id,
                    user_id=user_id,
                    actor=ExecutionActorRef(
                        type="project_agent",
                        id=agent_id,
                    ),
                )
                for agent_id in squad.member_agent_ids
            ]
            return {
                "type": actor.type,
                "id": squad.id,
                "name": squad.name,
                "leaderAgentId": squad.leader_agent_id,
                "memberAgentIds": list(squad.member_agent_ids),
                "routingInstructions": squad.routing_instructions,
                "maxParallelMembers": squad.max_parallel_members,
                "members": members,
                "version": squad.version,
            }
        team_kinds_service.get_team_detail(
            db=db,
            team_id=int(actor.team_id or 0),
            user_id=user_id,
        )
        team = (
            db.query(Kind)
            .filter(
                Kind.id == actor.team_id,
                Kind.kind == "Team",
                Kind.namespace == actor.namespace,
                Kind.name == actor.name,
                Kind.user_id == actor.user_id,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if team is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Wegent Team reference no longer matches the selected resource",
            )
        return {
            "type": "wegent_team",
            "teamId": team.id,
            "namespace": team.namespace,
            "name": team.name,
            "userId": team.user_id,
            "updatedAt": _iso(team.updated_at),
            "resource": copy.deepcopy(team.json),
        }

    def resolve_execution_target(
        self,
        db: Session,
        *,
        user_id: int,
        target: ExecutionTargetRef,
    ) -> dict[str, Any]:
        if target.type == "managed_container":
            return {
                "type": target.type,
                "profileId": target.id or "default",
                "provisioner": "executor_manager",
            }
        device = (
            db.query(Kind)
            .filter(
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.name == target.id,
                Kind.user_id == user_id,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if device is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "AI device not found")
        spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
        return {
            "type": target.type,
            "deviceId": device.name,
            "deviceType": spec.get("deviceType", "local"),
            "bindShell": spec.get("bindShell", "claudecode"),
            "capabilities": spec.get("capabilities") or [],
            "runtimeInstanceId": spec.get("runtimeInstanceId"),
            "updatedAt": _iso(device.updated_at),
        }
