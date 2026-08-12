# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workflow validation, snapshots, stage creation, and execution setup."""

import copy
import re
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_workflow import (
    ProjectRepositoryBinding,
    TaskDevelopmentLink,
    TaskExecutionBinding,
    TaskStageRun,
    TaskWorkflowRun,
    TaskWorkspace,
)
from app.schemas.project_workflow import WorkflowDefinitionCreate
from app.services.loop_item_executions.service import priority_weight, utcnow
from app.services.project_workflows.common import _id
from app.services.project_workflows.state import StageStatus


class WorkflowExecutionMixin:
    """Workflow validation, snapshots, stage creation, and execution setup."""

    def _validate_workflow_definition(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: WorkflowDefinitionCreate,
    ) -> None:
        if request.repository_binding_id:
            self._get_repository(db, project_id, request.repository_binding_id)
        for group in request.stages:
            for node in group.nodes:
                if node.actor:
                    self.resolve_actor(
                        db,
                        project_id=project_id,
                        user_id=user_id,
                        actor=node.actor,
                    )

    def _resolve_binding_workflow_snapshot(
        self,
        db: Session,
        *,
        project_id: int,
        binding: TaskExecutionBinding,
    ) -> dict[str, Any]:
        if binding.target_type == "workflow":
            workflow = self._get_workflow(db, project_id, binding.target_id)
            return self._workflow_snapshot(workflow)
        actor = copy.deepcopy(binding.target_snapshot)
        return {
            "id": "",
            "name": "Single AI execution",
            "failurePolicy": "pause",
            "version": 1,
            "stages": [
                {
                    "key": "execute",
                    "name": "Execute",
                    "execution": "serial",
                    "completion": "all",
                    "nodes": [
                        {
                            "key": "execute",
                            "name": actor.get("name") or "AI execution",
                            "type": "agent",
                            "actor": actor,
                            "input_artifacts": [],
                            "required_outputs": ["execution_result"],
                            "max_retries": 1,
                            "timeout_seconds": 3600,
                        }
                    ],
                }
            ],
        }

    def _ensure_task_development_state(
        self,
        db: Session,
        *,
        task: LoopItem,
        binding: TaskExecutionBinding,
        run: TaskWorkflowRun,
    ) -> tuple[TaskWorkspace, TaskDevelopmentLink]:
        repository = db.get(ProjectRepositoryBinding, binding.repository_binding_id)
        if repository is None or repository.status != "active":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task repository binding is no longer active",
            )
        workspace = (
            db.query(TaskWorkspace)
            .filter(
                TaskWorkspace.loop_item_id == task.id,
                TaskWorkspace.repository_binding_id == repository.id,
            )
            .first()
        )
        branch_name = self._task_branch_name(db, task=task, repository=repository)
        if workspace is None:
            settings = repository.provider_settings_json or {}
            source_path = str(settings.get("sourceWorkspacePath") or "")
            workspace_path = source_path
            if binding.workspace_mode == "git_worktree":
                root = str(settings.get("worktreeRoot") or "")
                workspace_path = (
                    f"{root.rstrip('/')}/{task.id}" if root else f"/workspace/{task.id}"
                )
            workspace = TaskWorkspace(
                id=_id(),
                loop_item_id=task.id,
                repository_binding_id=repository.id,
                execution_target_type=run.execution_target_type,
                execution_target_id=run.execution_target_id,
                source_workspace_path=source_path,
                workspace_path=workspace_path,
                workspace_kind=binding.workspace_mode,
                branch_name=branch_name,
                base_branch=repository.default_branch,
                status=(
                    "ready"
                    if binding.workspace_mode == "current_workspace" and source_path
                    else "preparing"
                ),
                cleanup_policy=str(
                    (repository.workspace_policy_json or {}).get("cleanup")
                    or "after_merge"
                ),
            )
            db.add(workspace)
            db.flush()
        link = (
            db.query(TaskDevelopmentLink)
            .filter(
                TaskDevelopmentLink.loop_item_id == task.id,
                TaskDevelopmentLink.repository_binding_id == repository.id,
            )
            .first()
        )
        if link is None:
            link = TaskDevelopmentLink(
                id=_id(),
                loop_item_id=task.id,
                repository_binding_id=repository.id,
                workspace_id=workspace.id,
                branch_name=workspace.branch_name,
                base_branch=workspace.base_branch,
                provider=repository.provider,
            )
            db.add(link)
            db.flush()
        return workspace, link

    @staticmethod
    def _task_branch_name(
        db: Session,
        *,
        task: LoopItem,
        repository: ProjectRepositoryBinding,
    ) -> str:
        project = db.get(CloudProject, str(task.cloud_project_id or ""))
        project_key = str(project.project_key if project else "WEWORK")
        task_id = str(task.public_id or task.id)
        slug = re.sub(r"[^a-z0-9]+", "-", str(task.title or "").lower()).strip("-")
        template = str(
            (repository.git_policy_json or {}).get("branchTemplate")
            or (repository.git_policy_json or {}).get("branchPattern")
            or "feature/{project_key}-{task_id}-{task_slug}"
        )
        branch = (
            template.replace("{project_key}", project_key)
            .replace("{task_id}", task_id)
            .replace("{task_key}", task_id)
            .replace("{task_slug}", slug or "task")
            .replace("{slug}", slug or "task")
            .replace("{date}", utcnow().strftime("%Y%m%d"))
        )
        branch = re.sub(r"[^A-Za-z0-9._/-]+", "-", branch)
        branch = re.sub(r"/+", "/", branch).strip("/.")
        if not branch or branch.endswith(".lock") or ".." in branch or "@{" in branch:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Git branch template produced an invalid ref",
            )
        return branch[:255]

    def _create_group_stage_runs(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        group: dict[str, Any],
        fallback_binding: TaskExecutionBinding,
        task: LoopItem,
        user_id: int,
    ) -> None:
        nodes = group["nodes"]
        active_nodes = nodes if group.get("execution") == "parallel" else nodes[:1]
        for node in active_nodes:
            self._create_node_stage_runs(
                db,
                run=run,
                group=group,
                node=node,
                fallback_binding=fallback_binding,
                task=task,
                user_id=user_id,
            )

    def _create_node_stage_runs(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        group: dict[str, Any],
        node: dict[str, Any],
        fallback_binding: TaskExecutionBinding,
        task: LoopItem,
        user_id: int,
    ) -> None:
        if node["type"] != "agent":
            stage = self._create_platform_stage_run(
                db,
                run=run,
                group=group,
                node=node,
            )
            if stage.status == StageStatus.QUEUED.value:
                self._evaluate_platform_stage(
                    db,
                    run=run,
                    stage=stage,
                    task=task,
                    user_id=user_id,
                )
            return
        actor = node.get("actor") or fallback_binding.target_snapshot
        actor_runs = self._expand_actor_runs(actor)
        max_parallel = (
            max(1, int(actor.get("maxParallelMembers", 1)))
            if actor.get("type") == "project_squad"
            else len(actor_runs)
        )
        for actor_index, resolved_actor in enumerate(actor_runs):
            self._create_agent_stage_run(
                db,
                run=run,
                group=group,
                node=node,
                actor=resolved_actor,
                actor_index=actor_index,
                task=task,
                user_id=user_id,
                queued=actor_index < max_parallel,
                squad_id=(
                    str(actor.get("id") or "")
                    if actor.get("type") == "project_squad"
                    else ""
                ),
                squad_max_parallel=max_parallel,
            )

    def _create_agent_stage_run(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        group: dict[str, Any],
        node: dict[str, Any],
        actor: dict[str, Any],
        actor_index: int,
        task: LoopItem,
        user_id: int,
        queued: bool,
        squad_id: str,
        squad_max_parallel: int,
    ) -> None:
        actor_type = str(actor.get("type") or "")
        actor_id = str(
            actor.get("id") or actor.get("teamId") or actor.get("team_id") or ""
        )
        node_key = node["key"]
        if actor_index:
            node_key = f"{node_key}:{actor_id}"
        workspace = self._run_workspace(db, run)
        stage = TaskStageRun(
            id=_id(),
            workflow_run_id=run.id,
            group_key=group["key"],
            node_key=node_key,
            node_type=node["type"],
            target_type=actor_type,
            target_id=actor_id,
            target_snapshot=copy.deepcopy(actor),
            execution_target_type=run.execution_target_type,
            execution_target_id=run.execution_target_id,
            status=(StageStatus.QUEUED.value if queued else StageStatus.PENDING.value),
            workspace_id=workspace.id if workspace else "",
            input_snapshot={
                "workflowNodeKey": node["key"],
                "workflowNode": copy.deepcopy(node),
                "inputArtifacts": node.get("input_artifacts", []),
                "requiredOutputs": node.get("required_outputs", []),
                "squadId": squad_id,
                "squadMaxParallel": squad_max_parallel,
                "workspace": self._workspace_snapshot(workspace),
            },
        )
        db.add(stage)
        db.flush()
        if queued:
            self._create_execution_for_stage(
                db,
                run=run,
                stage=stage,
                task=task,
                user_id=user_id,
            )

    @staticmethod
    def _create_execution_for_stage(
        db: Session,
        *,
        run: TaskWorkflowRun,
        stage: TaskStageRun,
        task: LoopItem,
        user_id: int,
    ) -> None:
        actor = stage.target_snapshot
        actor_type = stage.target_type
        actor_id = stage.target_id
        node = stage.input_snapshot.get("workflowNode") or {}
        target_device_id = run.execution_target_id
        if run.execution_target_type == "managed_container":
            target_device_id = f"managed-container:{target_device_id or 'default'}"
        execution = LoopItemExecution(
            loop_item_id=task.id,
            cloud_project_id=str(task.cloud_project_id or ""),
            agent_id=actor_id if actor_type == "project_agent" else "",
            actor_type=actor_type,
            actor_id=actor_id,
            actor_snapshot=copy.deepcopy(actor),
            execution_target_type=run.execution_target_type,
            execution_target_id=run.execution_target_id,
            execution_environment=(
                "cloud"
                if run.execution_target_type == "managed_container"
                or run.execution_target_snapshot.get("deviceType") == "cloud"
                else "local"
            ),
            execution_device_id=target_device_id,
            assigner_user_id=user_id,
            status="queued",
            priority_weight=priority_weight(task.priority),
            queued_at=utcnow(),
            workflow_run_id=run.id,
            stage_run_id=stage.id,
            attempt=stage.attempt,
            max_retries=int(node.get("max_retries", 1)),
        )
        db.add(execution)
        db.flush()
        stage.loop_item_execution_id = execution.id
        stage.status = StageStatus.QUEUED.value

    def _create_platform_stage_run(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        group: dict[str, Any],
        node: dict[str, Any],
    ) -> TaskStageRun:
        workspace = self._run_workspace(db, run)
        stage = TaskStageRun(
            id=_id(),
            workflow_run_id=run.id,
            group_key=group["key"],
            node_key=node["key"],
            node_type=node["type"],
            execution_target_type=run.execution_target_type,
            execution_target_id=run.execution_target_id,
            workspace_id=workspace.id if workspace else "",
            status=(
                StageStatus.WAITING_APPROVAL.value
                if node["type"] == "human_gate"
                else StageStatus.QUEUED.value
            ),
            input_snapshot={
                "workflowNodeKey": node["key"],
                "workflowNode": copy.deepcopy(node),
                "condition": node.get("condition"),
                "inputArtifacts": node.get("input_artifacts", []),
                "requiredOutputs": node.get("required_outputs", []),
                "workspace": self._workspace_snapshot(workspace),
            },
        )
        db.add(stage)
        db.flush()
        return stage

    def _evaluate_platform_stage(
        self,
        db: Session,
        *,
        run: TaskWorkflowRun,
        stage: TaskStageRun,
        task: LoopItem,
        user_id: int,
    ) -> None:
        if stage.node_type == "human_gate":
            return
        link = self._development_link(db, run)
        condition = str(stage.input_snapshot.get("condition") or "")
        passed = False
        failed = False
        failure_message = ""
        if stage.node_type == "complete":
            passed = True
        elif condition == "pr_exists":
            passed = bool(link and link.pull_request_id)
        elif condition == "ci_passed" or stage.node_type == "ci_gate":
            passed = bool(link and link.ci_state in {"success", "passed"})
            failed = bool(link and link.ci_state in {"failure", "failed", "cancelled"})
            failure_message = "Required CI checks did not pass"
        elif condition == "review_approved":
            passed = bool(link and link.review_decision == "approved")
            failed = bool(link and link.review_decision == "changes_requested")
            failure_message = "Pull request review requested changes"
        elif condition == "no_merge_conflict":
            passed = bool(link and link.mergeable_state in {"mergeable", "clean"})
            failed = bool(link and link.mergeable_state in {"conflicting", "dirty"})
            failure_message = "Pull request has merge conflicts"
        elif condition == "pr_merged" or stage.node_type == "merge":
            passed = bool(link and link.pull_request_state == "merged")
        elif condition == "all_required_tests_passed":
            passed = bool(link and link.ci_state in {"success", "passed"})
            failed = bool(link and link.ci_state in {"failure", "failed", "cancelled"})
            failure_message = "Required test checks did not pass"
        if not passed and not failed:
            stage.status = StageStatus.QUEUED.value
            return
        stage.completed_at = utcnow()
        stage.version += 1
        if failed:
            stage.status = StageStatus.FAILED.value
            stage.failure_code = f"{condition or stage.node_type}_failed"
            stage.failure_message = failure_message
        else:
            stage.status = StageStatus.PASSED.value
            stage.failure_code = ""
            stage.failure_message = ""
            stage.output_json = {
                "condition": condition or stage.node_type,
                "developmentLinkId": link.id if link else None,
            }
            if stage.node_type == "complete":
                task.status = "completed"
                task.completed_at = utcnow()
                task.version += 1
        self._advance_after_stage_terminal(
            db,
            run=run,
            stage=stage,
            task=task,
            user_id=user_id,
        )

    @staticmethod
    def _development_link(
        db: Session,
        run: TaskWorkflowRun,
    ) -> TaskDevelopmentLink | None:
        if not run.repository_binding_id:
            return None
        return (
            db.query(TaskDevelopmentLink)
            .filter(
                TaskDevelopmentLink.loop_item_id == run.loop_item_id,
                TaskDevelopmentLink.repository_binding_id == run.repository_binding_id,
            )
            .first()
        )

    @staticmethod
    def _run_workspace(
        db: Session,
        run: TaskWorkflowRun,
    ) -> TaskWorkspace | None:
        if not run.repository_binding_id:
            return None
        return (
            db.query(TaskWorkspace)
            .filter(
                TaskWorkspace.loop_item_id == run.loop_item_id,
                TaskWorkspace.repository_binding_id == run.repository_binding_id,
            )
            .first()
        )

    @staticmethod
    def _workspace_snapshot(workspace: TaskWorkspace | None) -> dict[str, Any]:
        if workspace is None:
            return {}
        return {
            "id": workspace.id,
            "kind": workspace.workspace_kind,
            "sourcePath": workspace.source_workspace_path,
            "path": workspace.workspace_path,
            "branchName": workspace.branch_name,
            "baseBranch": workspace.base_branch,
            "status": workspace.status,
        }

    @staticmethod
    def _expand_actor_runs(actor: dict[str, Any]) -> list[dict[str, Any]]:
        if actor.get("type") != "project_squad":
            return [copy.deepcopy(actor)]
        members = actor.get("members")
        if not isinstance(members, list) or not members:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Squad snapshot has no runnable members",
            )
        return [copy.deepcopy(member) for member in members]
