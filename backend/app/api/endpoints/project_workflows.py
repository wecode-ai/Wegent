# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project AI-development workflow endpoints."""

from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.project_workflow import (
    ConfigurationValidationView,
    ProjectAgentSquadCreate,
    ProjectAgentSquadUpdate,
    ProjectAgentSquadView,
    ProjectWorkflowAutomationCreate,
    ProjectWorkflowAutomationRunRequest,
    ProjectWorkflowAutomationRunView,
    ProjectWorkflowAutomationSecretView,
    ProjectWorkflowAutomationUpdate,
    ProjectWorkflowAutomationView,
    PullRequestCreate,
    PullRequestMerge,
    RepositoryBindingCreate,
    RepositoryBindingUpdate,
    RepositoryBindingView,
    RepositoryProviderEventInput,
    RepositoryProviderEventView,
    RepositoryWebhookSecretView,
    SquadRoutePreviewInput,
    SquadRoutePreviewView,
    TaskDevelopmentView,
    TaskExecutionBindingUpsert,
    TaskExecutionBindingView,
    WorkflowAction,
    WorkflowArtifactCreate,
    WorkflowArtifactView,
    WorkflowDefinitionCreate,
    WorkflowDefinitionUpdate,
    WorkflowDefinitionView,
    WorkflowRunDetailView,
    WorkflowRunStart,
    WorkflowRunView,
)
from app.services.project_workflows import project_workflow_service

router = APIRouter()


@router.get(
    "/{project_id}/agent-squads",
    response_model=list[ProjectAgentSquadView],
)
def list_agent_squads(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectAgentSquadView]:
    return project_workflow_service.list_squads(
        db,
        project_id=project_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/agent-squads",
    response_model=ProjectAgentSquadView,
    status_code=status.HTTP_201_CREATED,
)
def create_agent_squad(
    project_id: int,
    values: ProjectAgentSquadCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAgentSquadView:
    return project_workflow_service.create_squad(
        db,
        project_id=project_id,
        user_id=current_user.id,
        request=values,
    )


@router.patch(
    "/{project_id}/agent-squads/{squad_id}",
    response_model=ProjectAgentSquadView,
)
def update_agent_squad(
    project_id: int,
    squad_id: str,
    values: ProjectAgentSquadUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAgentSquadView:
    return project_workflow_service.update_squad(
        db,
        project_id=project_id,
        squad_id=squad_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/agent-squads/{squad_id}/preview-route",
    response_model=SquadRoutePreviewView,
)
def preview_agent_squad_route(
    project_id: int,
    squad_id: str,
    values: SquadRoutePreviewInput,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SquadRoutePreviewView:
    return project_workflow_service.preview_squad_route(
        db,
        project_id=project_id,
        squad_id=squad_id,
        user_id=current_user.id,
        request=values,
    )


@router.get(
    "/{project_id}/repositories",
    response_model=list[RepositoryBindingView],
)
def list_repository_bindings(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RepositoryBindingView]:
    return project_workflow_service.list_repositories(
        db,
        project_id=project_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/repositories",
    response_model=RepositoryBindingView,
    status_code=status.HTTP_201_CREATED,
)
def create_repository_binding(
    project_id: int,
    values: RepositoryBindingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RepositoryBindingView:
    return project_workflow_service.create_repository(
        db,
        project_id=project_id,
        user_id=current_user.id,
        request=values,
    )


@router.patch(
    "/{project_id}/repositories/{binding_id}",
    response_model=RepositoryBindingView,
)
def update_repository_binding(
    project_id: int,
    binding_id: str,
    values: RepositoryBindingUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RepositoryBindingView:
    return project_workflow_service.update_repository(
        db,
        project_id=project_id,
        binding_id=binding_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/repositories/{binding_id}/webhook/rotate",
    response_model=RepositoryWebhookSecretView,
)
def rotate_repository_webhook_secret(
    project_id: int,
    binding_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RepositoryWebhookSecretView:
    return project_workflow_service.rotate_repository_webhook_secret(
        db,
        project_id=project_id,
        binding_id=binding_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/repositories/{binding_id}/validate",
    response_model=ConfigurationValidationView,
)
def validate_repository_binding(
    project_id: int,
    binding_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ConfigurationValidationView:
    return project_workflow_service.validate_repository(
        db,
        project_id=project_id,
        binding_id=binding_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/repositories/{binding_id}/provider-events",
    response_model=RepositoryProviderEventView,
)
def submit_repository_provider_event(
    project_id: int,
    binding_id: str,
    values: RepositoryProviderEventInput,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RepositoryProviderEventView:
    return project_workflow_service.process_repository_provider_event(
        db,
        project_id=project_id,
        binding_id=binding_id,
        user_id=current_user.id,
        request=values,
    )


@router.get(
    "/{project_id}/workflows",
    response_model=list[WorkflowDefinitionView],
)
def list_workflow_definitions(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[WorkflowDefinitionView]:
    return project_workflow_service.list_workflows(
        db,
        project_id=project_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/workflows",
    response_model=WorkflowDefinitionView,
    status_code=status.HTTP_201_CREATED,
)
def create_workflow_definition(
    project_id: int,
    values: WorkflowDefinitionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowDefinitionView:
    return project_workflow_service.create_workflow(
        db,
        project_id=project_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/workflows/validate",
    response_model=ConfigurationValidationView,
)
def validate_workflow_definition(
    project_id: int,
    values: WorkflowDefinitionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ConfigurationValidationView:
    return project_workflow_service.validate_workflow(
        db,
        project_id=project_id,
        user_id=current_user.id,
        request=values,
    )


@router.patch(
    "/{project_id}/workflows/{workflow_id}",
    response_model=WorkflowDefinitionView,
)
def update_workflow_definition(
    project_id: int,
    workflow_id: str,
    values: WorkflowDefinitionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowDefinitionView:
    return project_workflow_service.update_workflow(
        db,
        project_id=project_id,
        workflow_id=workflow_id,
        user_id=current_user.id,
        request=values,
    )


@router.get(
    "/{project_id}/workflow-automations",
    response_model=list[ProjectWorkflowAutomationView],
)
def list_project_workflow_automations(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectWorkflowAutomationView]:
    return project_workflow_service.list_automations(
        db,
        project_id=project_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/workflow-automations",
    response_model=ProjectWorkflowAutomationView,
    status_code=status.HTTP_201_CREATED,
)
def create_project_workflow_automation(
    project_id: int,
    values: ProjectWorkflowAutomationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectWorkflowAutomationView:
    return project_workflow_service.create_automation(
        db,
        project_id=project_id,
        user_id=current_user.id,
        request=values,
    )


@router.patch(
    "/{project_id}/workflow-automations/{automation_id}",
    response_model=ProjectWorkflowAutomationView,
)
def update_project_workflow_automation(
    project_id: int,
    automation_id: str,
    values: ProjectWorkflowAutomationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectWorkflowAutomationView:
    return project_workflow_service.update_automation(
        db,
        project_id=project_id,
        automation_id=automation_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/workflow-automations/{automation_id}/webhook/rotate",
    response_model=ProjectWorkflowAutomationSecretView,
)
def rotate_project_workflow_automation_webhook(
    project_id: int,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectWorkflowAutomationSecretView:
    return project_workflow_service.rotate_automation_webhook_secret(
        db,
        project_id=project_id,
        automation_id=automation_id,
        user_id=current_user.id,
    )


@router.get(
    "/{project_id}/workflow-automations/{automation_id}/runs",
    response_model=list[ProjectWorkflowAutomationRunView],
)
def list_project_workflow_automation_runs(
    project_id: int,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectWorkflowAutomationRunView]:
    return project_workflow_service.list_automation_runs(
        db,
        project_id=project_id,
        automation_id=automation_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/workflow-automations/{automation_id}/run",
    response_model=ProjectWorkflowAutomationRunView,
    status_code=status.HTTP_201_CREATED,
)
def run_project_workflow_automation(
    project_id: int,
    automation_id: str,
    values: ProjectWorkflowAutomationRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectWorkflowAutomationRunView:
    return project_workflow_service.run_automation(
        db,
        project_id=project_id,
        automation_id=automation_id,
        user_id=current_user.id,
        request=values,
    )


@router.get(
    "/{project_id}/loop-items/{item_id}/execution-binding",
    response_model=TaskExecutionBindingView | None,
)
def get_task_execution_binding(
    project_id: int,
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TaskExecutionBindingView | None:
    return project_workflow_service.get_task_binding(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
    )


@router.put(
    "/{project_id}/loop-items/{item_id}/execution-binding",
    response_model=TaskExecutionBindingView,
)
def upsert_task_execution_binding(
    project_id: int,
    item_id: str,
    values: TaskExecutionBindingUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TaskExecutionBindingView:
    return project_workflow_service.upsert_task_binding(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
        request=values,
    )


@router.get(
    "/{project_id}/loop-items/{item_id}/workflow/runs",
    response_model=list[WorkflowRunView],
)
def list_task_workflow_runs(
    project_id: int,
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[WorkflowRunView]:
    return project_workflow_service.list_task_runs(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/start",
    response_model=WorkflowRunView,
    status_code=status.HTTP_201_CREATED,
)
def start_task_workflow(
    project_id: int,
    item_id: str,
    values: WorkflowRunStart,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunView:
    return project_workflow_service.start_task_workflow(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
        idempotency_key=values.idempotency_key,
        trigger_message_id=values.trigger_message_id,
    )


@router.get(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}",
    response_model=WorkflowRunDetailView,
)
def get_task_workflow_run(
    project_id: int,
    item_id: str,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunDetailView:
    return project_workflow_service.get_run_detail(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        user_id=current_user.id,
    )


@router.get(
    "/{project_id}/loop-items/{item_id}/development",
    response_model=list[TaskDevelopmentView],
)
def get_task_development(
    project_id: int,
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TaskDevelopmentView]:
    return project_workflow_service.get_task_development(
        db,
        project_id=project_id,
        item_id=item_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/development/{development_id}/pull-request",
    response_model=TaskDevelopmentView,
    status_code=status.HTTP_201_CREATED,
)
def create_task_pull_request(
    project_id: int,
    item_id: str,
    development_id: str,
    values: PullRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TaskDevelopmentView:
    return project_workflow_service.create_pull_request(
        db,
        project_id=project_id,
        item_id=item_id,
        development_id=development_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/development/{development_id}/refresh",
    response_model=TaskDevelopmentView,
)
def refresh_task_pull_request(
    project_id: int,
    item_id: str,
    development_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TaskDevelopmentView:
    return project_workflow_service.refresh_pull_request(
        db,
        project_id=project_id,
        item_id=item_id,
        development_id=development_id,
        user_id=current_user.id,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/development/{development_id}/merge",
    response_model=TaskDevelopmentView,
)
def merge_task_pull_request(
    project_id: int,
    item_id: str,
    development_id: str,
    values: PullRequestMerge,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TaskDevelopmentView:
    return project_workflow_service.merge_pull_request(
        db,
        project_id=project_id,
        item_id=item_id,
        development_id=development_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}"
    "/stages/{stage_id}/artifacts",
    response_model=WorkflowArtifactView,
    status_code=status.HTTP_201_CREATED,
)
def submit_task_workflow_artifact(
    project_id: int,
    item_id: str,
    run_id: str,
    stage_id: str,
    values: WorkflowArtifactCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowArtifactView:
    return project_workflow_service.submit_stage_artifact(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        stage_id=stage_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}"
    "/stages/{stage_id}/approve",
    response_model=WorkflowRunDetailView,
)
def approve_task_workflow_stage(
    project_id: int,
    item_id: str,
    run_id: str,
    stage_id: str,
    values: WorkflowAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunDetailView:
    return project_workflow_service.approve_stage(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        stage_id=stage_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}"
    "/stages/{stage_id}/reject",
    response_model=WorkflowRunDetailView,
)
def reject_task_workflow_stage(
    project_id: int,
    item_id: str,
    run_id: str,
    stage_id: str,
    values: WorkflowAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunDetailView:
    return project_workflow_service.reject_stage(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        stage_id=stage_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}"
    "/stages/{stage_id}/retry",
    response_model=WorkflowRunDetailView,
)
def retry_task_workflow_stage(
    project_id: int,
    item_id: str,
    run_id: str,
    stage_id: str,
    values: WorkflowAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunDetailView:
    return project_workflow_service.retry_stage(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        stage_id=stage_id,
        user_id=current_user.id,
        request=values,
    )


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow/runs/{run_id}/cancel",
    response_model=WorkflowRunDetailView,
)
def cancel_task_workflow_run(
    project_id: int,
    item_id: str,
    run_id: str,
    values: WorkflowAction,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowRunDetailView:
    detail, executions = project_workflow_service.cancel_run(
        db,
        project_id=project_id,
        item_id=item_id,
        run_id=run_id,
        user_id=current_user.id,
        request=values,
    )
    if executions:
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, executions)
    return detail
