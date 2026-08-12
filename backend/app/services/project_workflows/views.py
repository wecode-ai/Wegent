# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Response projections for project development workflow records."""

import copy
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.project_workflow import (
    EPOCH_TIME,
    ProjectAgentSquad,
    ProjectRepositoryBinding,
    ProjectWorkflowDefinition,
    RepositoryProviderEvent,
    TaskDevelopmentCheck,
    TaskDevelopmentLink,
    TaskDevelopmentReviewThread,
    TaskExecutionBinding,
    TaskStageRun,
    TaskWorkflowArtifact,
    TaskWorkflowRun,
    TaskWorkspace,
)
from app.schemas.project_workflow import (
    DevelopmentCheckView,
    DevelopmentReviewThreadView,
    ExecutionTargetRef,
    ProjectAgentSquadView,
    RepositoryBindingView,
    RepositoryProviderEventView,
    StageRunView,
    TaskDevelopmentView,
    TaskExecutionBindingView,
    TaskWorkspaceView,
    WorkflowArtifactView,
    WorkflowDefinitionView,
    WorkflowRunDetailView,
    WorkflowRunView,
)


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=UTC).isoformat()


def _optional_text(value: str) -> str | None:
    return value or None


def _optional_iso(value: datetime) -> str | None:
    return None if value == EPOCH_TIME else _iso(value)


class WorkflowViewMixin:
    """Build stable API views without mixing projection code into orchestration."""

    @staticmethod
    def _squad_view(row: ProjectAgentSquad) -> ProjectAgentSquadView:
        return ProjectAgentSquadView(
            id=row.id,
            project_id=row.cloud_project_id,
            name=row.name,
            leader_agent_id=row.leader_agent_id,
            member_agent_ids=list(row.member_agent_ids),
            routing_instructions=row.routing_instructions,
            max_parallel_members=row.max_parallel_members,
            status=row.status,
            created_by_user_id=row.created_by_user_id,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _repository_view(row: ProjectRepositoryBinding) -> RepositoryBindingView:
        target = None
        if row.execution_target_id or row.execution_target_type == "managed_container":
            target = ExecutionTargetRef(
                type=row.execution_target_type,
                id=_optional_text(row.execution_target_id),
            )
        return RepositoryBindingView(
            id=row.id,
            project_id=row.cloud_project_id,
            provider=row.provider,
            repository_identity=row.repository_identity,
            repository_url=row.repository_url,
            default_branch=row.default_branch,
            local_project_id=row.local_project_id or None,
            default_execution_target=target,
            has_credential=bool(row.credential_ref),
            webhook_configured=bool(row.webhook_secret_ciphertext),
            workspace_policy=row.workspace_policy_json,
            git_policy=row.git_policy_json,
            provider_settings=row.provider_settings_json,
            status=row.status,
            created_by_user_id=row.created_by_user_id,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @classmethod
    def _development_view(
        cls,
        db: Session,
        row: TaskDevelopmentLink,
    ) -> TaskDevelopmentView:
        workspace = (
            db.get(TaskWorkspace, row.workspace_id) if row.workspace_id else None
        )
        checks = (
            db.query(TaskDevelopmentCheck)
            .filter(TaskDevelopmentCheck.development_link_id == row.id)
            .order_by(TaskDevelopmentCheck.name.asc())
            .all()
        )
        review_threads = (
            db.query(TaskDevelopmentReviewThread)
            .filter(TaskDevelopmentReviewThread.development_link_id == row.id)
            .order_by(
                TaskDevelopmentReviewThread.status.asc(),
                TaskDevelopmentReviewThread.updated_at.desc(),
            )
            .all()
        )
        return TaskDevelopmentView(
            id=row.id,
            item_id=row.loop_item_id,
            repository_binding_id=row.repository_binding_id,
            workspace=cls._workspace_view(workspace) if workspace else None,
            branch_name=row.branch_name,
            base_branch=row.base_branch,
            head_commit=_optional_text(row.head_commit),
            provider=row.provider,
            pull_request_id=_optional_text(row.pull_request_id),
            pull_request_number=row.pull_request_number or None,
            pull_request_url=_optional_text(row.pull_request_url),
            pull_request_state=_optional_text(row.pull_request_state),
            draft=bool(row.draft),
            mergeable_state=_optional_text(row.mergeable_state),
            review_decision=_optional_text(row.review_decision),
            ci_state=_optional_text(row.ci_state),
            merged_commit=_optional_text(row.merged_commit),
            checks=[
                DevelopmentCheckView(
                    id=check.id,
                    provider_check_id=check.provider_check_id,
                    name=check.name,
                    status=check.status,
                    conclusion=_optional_text(check.conclusion),
                    details_url=_optional_text(check.details_url),
                    started_at=_optional_iso(check.started_at),
                    completed_at=_optional_iso(check.completed_at),
                    updated_at=_iso(check.updated_at),
                )
                for check in checks
            ],
            review_threads=[
                DevelopmentReviewThreadView(
                    id=thread.id,
                    provider_thread_id=thread.provider_thread_id,
                    provider_comment_id=_optional_text(thread.provider_comment_id),
                    path=_optional_text(thread.path),
                    line=thread.line or None,
                    side=_optional_text(thread.side),
                    author=_optional_text(thread.author),
                    body=thread.body,
                    url=_optional_text(thread.url),
                    status=thread.status,
                    review_state=_optional_text(thread.review_state),
                    created_at=_iso(thread.created_at),
                    updated_at=_iso(thread.updated_at),
                )
                for thread in review_threads
            ],
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _workspace_view(row: TaskWorkspace) -> TaskWorkspaceView:
        return TaskWorkspaceView(
            id=row.id,
            item_id=row.loop_item_id,
            repository_binding_id=row.repository_binding_id,
            execution_target=ExecutionTargetRef(
                type=row.execution_target_type,
                id=_optional_text(row.execution_target_id),
            ),
            source_workspace_path=_optional_text(row.source_workspace_path),
            workspace_path=_optional_text(row.workspace_path),
            workspace_kind=row.workspace_kind,
            branch_name=row.branch_name,
            base_branch=row.base_branch,
            head_commit=_optional_text(row.head_commit),
            status=row.status,
            cleanup_policy=row.cleanup_policy,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _provider_event_view(
        row: RepositoryProviderEvent,
    ) -> RepositoryProviderEventView:
        return RepositoryProviderEventView(
            id=row.id,
            repository_binding_id=row.repository_binding_id,
            provider_event_id=row.provider_event_id,
            event_type=row.event_type,
            delivery_id=row.delivery_id,
            processing_status=row.processing_status,
        )

    @staticmethod
    def _workflow_snapshot(row: ProjectWorkflowDefinition) -> dict[str, Any]:
        return {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "triggerMode": row.trigger_mode,
            "repositoryBindingId": _optional_text(row.repository_binding_id),
            "stages": copy.deepcopy(row.stages_json),
            "failurePolicy": row.failure_policy,
            "version": row.version,
        }

    @classmethod
    def _workflow_view(
        cls,
        row: ProjectWorkflowDefinition,
    ) -> WorkflowDefinitionView:
        snapshot = cls._workflow_snapshot(row)
        return WorkflowDefinitionView(
            id=row.id,
            project_id=row.cloud_project_id,
            name=row.name,
            description=row.description,
            trigger_mode=row.trigger_mode,
            repository_binding_id=_optional_text(row.repository_binding_id),
            stages=snapshot["stages"],
            failure_policy=row.failure_policy,
            is_default=bool(row.is_default),
            status=row.status,
            created_by_user_id=row.created_by_user_id,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _binding_view(row: TaskExecutionBinding) -> TaskExecutionBindingView:
        return TaskExecutionBindingView(
            id=row.id,
            item_id=row.loop_item_id,
            target_type=row.target_type,
            target_id=row.target_id,
            target_snapshot=row.target_snapshot,
            repository_binding_id=_optional_text(row.repository_binding_id),
            execution_target=ExecutionTargetRef(
                type=row.execution_target_type,
                id=_optional_text(row.execution_target_id),
            ),
            workspace_mode=row.workspace_mode,
            created_by_user_id=row.created_by_user_id,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _run_view(row: TaskWorkflowRun) -> WorkflowRunView:
        return WorkflowRunView(
            id=row.id,
            item_id=row.loop_item_id,
            workflow_definition_id=_optional_text(row.workflow_definition_id),
            status=row.status,
            current_group_key=_optional_text(row.current_group_key),
            trigger_message_id=_optional_text(row.trigger_message_id),
            repository_binding_id=_optional_text(row.repository_binding_id),
            execution_target=ExecutionTargetRef(
                type=row.execution_target_type,
                id=_optional_text(row.execution_target_id),
            ),
            execution_target_snapshot=row.execution_target_snapshot,
            failure_code=_optional_text(row.failure_code),
            failure_message=_optional_text(row.failure_message),
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _stage_view(row: TaskStageRun) -> StageRunView:
        return StageRunView(
            id=row.id,
            workflow_run_id=row.workflow_run_id,
            group_key=row.group_key,
            node_key=row.node_key,
            node_type=row.node_type,
            target_type=_optional_text(row.target_type),
            target_id=_optional_text(row.target_id),
            target_snapshot=row.target_snapshot,
            execution_target=ExecutionTargetRef(
                type=row.execution_target_type,
                id=_optional_text(row.execution_target_id),
            ),
            status=row.status,
            attempt=row.attempt,
            loop_item_execution_id=row.loop_item_execution_id or None,
            runtime_instance_id=_optional_text(row.runtime_instance_id),
            runtime_task_id=_optional_text(row.runtime_task_id),
            workspace_id=_optional_text(row.workspace_id),
            input_snapshot=row.input_snapshot,
            output=row.output_json,
            failure_code=_optional_text(row.failure_code),
            failure_message=_optional_text(row.failure_message),
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _artifact_view(row: TaskWorkflowArtifact) -> WorkflowArtifactView:
        return WorkflowArtifactView(
            id=row.id,
            workflow_run_id=row.workflow_run_id,
            stage_run_id=row.stage_run_id,
            artifact_type=row.artifact_type,
            schema_version=row.schema_version,
            content=row.content_json,
            object_key=_optional_text(row.object_key),
            sha256=_optional_text(row.sha256),
            created_at=_iso(row.created_at),
        )

    @classmethod
    def _run_detail_view(
        cls,
        db: Session,
        row: TaskWorkflowRun,
    ) -> WorkflowRunDetailView:
        stages = (
            db.query(TaskStageRun)
            .filter(TaskStageRun.workflow_run_id == row.id)
            .order_by(TaskStageRun.created_at.asc(), TaskStageRun.attempt.asc())
            .all()
        )
        artifacts = (
            db.query(TaskWorkflowArtifact)
            .filter(TaskWorkflowArtifact.workflow_run_id == row.id)
            .order_by(TaskWorkflowArtifact.created_at.asc())
            .all()
        )
        return WorkflowRunDetailView(
            **cls._run_view(row).model_dump(),
            stages=[cls._stage_view(stage) for stage in stages],
            artifacts=[cls._artifact_view(artifact) for artifact in artifacts],
        )
