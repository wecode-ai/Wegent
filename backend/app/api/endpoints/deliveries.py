# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated project TODO and delivery endpoints."""

import logging

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import (
    get_current_user,
    get_current_user_jwt_apikey_tasktoken,
)
from app.models.delivery import (
    Delivery,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRule,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.delivery import (
    CloudTaskContextResponse,
    DeliveryAssetAccessResponse,
    DeliveryAssetResponse,
    DeliveryCreate,
    DeliveryDetailResponse,
    DeliveryFinalize,
    DeliveryListResponse,
    DeliveryResponse,
    LoopItemAttachmentAccessResponse,
    LoopItemAttachmentResponse,
    LoopItemCollaboratorCreate,
    LoopItemCollaboratorResponse,
    LoopItemCommentCreate,
    LoopItemCommentResponse,
    LoopItemCreate,
    LoopItemListResponse,
    LoopItemPageResponse,
    LoopItemReorder,
    LoopItemResponse,
    LoopItemTaskBind,
    LoopItemTaskBindingResponse,
    LoopItemUpdate,
    MyWorkItemResponse,
    MyWorkListResponse,
)
from app.schemas.issue_workflow import (
    WorkflowNodeDecisionRequest,
    WorkflowPlanSubmit,
    WorkflowPlanView,
    WorkflowTaskOutcomeSubmit,
)
from app.services.cloud_projects import cloud_project_service
from app.services.delivery import delivery_service
from app.services.issue_workflow_decision import issue_workflow_decision_service
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_status_history import (
    is_processing_status,
    project_status_transition,
)
from app.services.loop_items import loop_item_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import (
    loop_item_attachment_provider_router,
    loop_item_provider_router,
)
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import (
    project_automation_processor,
    project_automation_service,
)
from app.services.project_board_snapshot import project_board_snapshot_service
from app.services.workflow_stage_context import workflow_stage_context_resolver

router = APIRouter()
logger = logging.getLogger(__name__)
ACTIVE_MANAGER_RUN_STATUSES = {
    "pending",
    "queued",
    "waiting_device",
    "running",
    "cancel_requested",
}


def _loop_item_response(
    db: Session, item: object, current_user: User
) -> LoopItemResponse:
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, current_user.id)
    )


def _automation_selection_error(
    *,
    code: str,
    message: str,
    candidates: list[ProjectAutomationRule] | None = None,
) -> HTTPException:
    detail: dict[str, object] = {"code": code, "message": message}
    if candidates is not None:
        detail["candidates"] = [
            {
                "id": str(rule.id),
                "name": rule.title,
                "description": rule.description or "",
            }
            for rule in candidates
        ]
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


def _selected_event_automation_id(
    db: Session,
    event: ProjectAutomationEvent,
    *,
    requested_id: str | None,
    bound_rule_id: str = "",
) -> str | None:
    matching_rules = project_automation_processor.matching_rules(db, event)
    if requested_id:
        selected_rule = next(
            (rule for rule in matching_rules if str(rule.id) == requested_id),
            None,
        )
        if selected_rule is None or (bound_rule_id and bound_rule_id != requested_id):
            raise _automation_selection_error(
                code="automation_selection_stale",
                message="The selected automation no longer matches this Issue",
            )
        return requested_id
    if bound_rule_id:
        return next(
            (str(rule.id) for rule in matching_rules if str(rule.id) == bound_rule_id),
            None,
        )
    if len(matching_rules) > 1:
        raise _automation_selection_error(
            code="automation_selection_required",
            message="Multiple automations match this Issue",
            candidates=matching_rules,
        )
    return str(matching_rules[0].id) if matching_rules else None


def _delivery_response(db: Session, delivery: Delivery) -> DeliveryResponse:
    return DeliveryResponse.model_validate(
        {
            **delivery.__dict__,
            "assets": delivery_service.list_assets(db, delivery.id),
            "fulfillments": delivery_service.fulfillment_values(delivery),
        }
    )


def _publish_workflow_plan_changed(
    db: Session,
    *,
    item_id: str,
    user_id: int,
    reason: str,
) -> None:
    item = db.get(LoopItem, item_id, populate_existing=True)
    if item is None:
        return
    publish_loop_item_changed(
        db,
        item=item,
        reason=reason,
        actor_user_id=user_id,
    )


def _schedule_workflow_plan_executions(
    db: Session,
    plan: WorkflowPlanView,
) -> None:
    from app.services.board_team_execution import (
        schedule_board_robot_execution_by_id,
        workflow_plan_execution_ids,
    )

    execution_ids = workflow_plan_execution_ids(db, plan)
    db.rollback()
    for execution_id in execution_ids:
        try:
            schedule_board_robot_execution_by_id(execution_id)
        except Exception:
            logger.exception(
                "Workflow plan execution scheduling failed execution_id=%s",
                execution_id,
            )


def _approve_and_dispatch_workflow_plan(
    db: Session,
    *,
    item_id: str,
    user: User,
) -> WorkflowPlanView:
    plan = issue_workflow_planning_service.approve(
        db,
        issue_id=item_id,
        user_id=user.id,
    )
    _schedule_workflow_plan_executions(db, plan)
    refreshed = issue_workflow_planning_service.get(
        db,
        issue_id=item_id,
        user_id=user.id,
    )
    if refreshed is None:
        raise RuntimeError("Approved workflow plan is unavailable")
    return refreshed


async def _dispatch_workflow_manager(
    db: Session,
    *,
    item_id: str,
    user: User,
) -> None:
    item = db.get(LoopItem, item_id)
    if item is None:
        raise ValueError("Issue not found")
    project = cloud_project_service.get(
        db,
        int(str(item.cloud_project_id)),
        user.id,
    )
    await issue_workflow_start_service.start(
        db,
        item=item,
        project=project,
        user_id=user.id,
    )


async def _cancel_workflow_manager(
    db: Session,
    *,
    plan: WorkflowPlanView,
    user: User,
) -> bool:
    manager_run = issue_workflow_planning_service.manager_automation_run(
        db,
        workflow_run_id=plan.run_id,
    )
    if manager_run is None or manager_run.status not in ACTIVE_MANAGER_RUN_STATUSES:
        return False
    result = await project_automation_service.cancel_run(
        db,
        str(manager_run.cloud_project_id),
        str(manager_run.id),
        user.id,
    )
    return str(result.get("status") or "") in ACTIVE_MANAGER_RUN_STATUSES


def _workflow_manager_is_active(db: Session, plan: WorkflowPlanView) -> bool:
    manager_run = issue_workflow_planning_service.manager_automation_run(
        db,
        workflow_run_id=plan.run_id,
    )
    return manager_run is not None and manager_run.status in ACTIVE_MANAGER_RUN_STATUSES


@router.get("/cloud-work-items/my-work", response_model=MyWorkListResponse)
def list_my_work(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MyWorkListResponse:
    items = loop_item_service.list_my_work(db, current_user.id)
    return MyWorkListResponse(
        items=[MyWorkItemResponse.model_validate(item) for item in items]
    )


@router.get(
    "/loop-items/{item_id}/collaborators",
    response_model=list[LoopItemCollaboratorResponse],
)
def list_loop_item_collaborators(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[LoopItemCollaboratorResponse]:
    collaborators = loop_item_service.list_collaborators(db, item_id, current_user.id)
    return [
        LoopItemCollaboratorResponse.model_validate(collaborator)
        for collaborator in collaborators
    ]


@router.post(
    "/loop-items/{item_id}/collaborators",
    response_model=LoopItemCollaboratorResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_collaborator(
    item_id: str,
    values: LoopItemCollaboratorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemCollaboratorResponse:
    collaborator = loop_item_service.add_collaborator(
        db, item_id, values.user_id, current_user.id
    )
    return LoopItemCollaboratorResponse.model_validate(collaborator)


@router.delete(
    "/loop-items/{item_id}/collaborators/{collaborator_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_loop_item_collaborator(
    item_id: str,
    collaborator_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    loop_item_service.remove_collaborator(
        db, item_id, collaborator_user_id, current_user.id
    )


@router.get("/runtime-tasks/loop-item", response_model=LoopItemResponse)
def find_runtime_task_loop_item(
    device_id: str = Query(min_length=1),
    task_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    item = loop_item_service.find_for_runtime_task(
        db, current_user.id, device_id, task_id
    )
    return _loop_item_response(db, item, current_user)


@router.get("/runtime-tasks/cloud-context", response_model=CloudTaskContextResponse)
def find_runtime_task_cloud_context(
    device_id: str = Query(min_length=1),
    task_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudTaskContextResponse:
    binding, project, item = loop_item_service.find_cloud_context(
        db, current_user.id, device_id, task_id
    )
    return CloudTaskContextResponse.model_validate(
        {
            **binding.__dict__,
            "workflow_node_id": binding.workflow_node_id,
            "project": {
                **project.__dict__,
                "current_user_id": current_user.id,
                "current_user_name": current_user.user_name,
                "access_role": cloud_project_service.access(
                    db, project.id, current_user.id
                ).role,
            },
            "loop_item": (
                loop_item_service.response_values(db, item, current_user.id)
                if item is not None
                else None
            ),
        }
    )


@router.post(
    "/cloud-projects/{project_id}/tasks",
    response_model=LoopItemTaskBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
def bind_cloud_project_task(
    project_id: int,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemTaskBindingResponse:
    binding = loop_item_service.bind_project_task(
        db, project_id, values, current_user.id
    )
    return LoopItemTaskBindingResponse.model_validate(binding)


@router.get(
    "/loop-items/{item_id}/workflow-nodes/{workflow_node_id}/input-context",
    response_model=dict,
)
def get_workflow_stage_input_context(
    item_id: str,
    workflow_node_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> dict:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    item = loop_item_service.get(db, item_id, current_user.id)
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == item_id,
            LoopItemTaskBinding.task_user_id == current_user.id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .order_by(LoopItemTaskBinding.linked_at.desc())
        .all()
    )
    stage_binding = next(
        (
            candidate
            for candidate in binding
            if candidate.workflow_node_id == workflow_node_id
        ),
        None,
    )
    if stage_binding is not None:
        snapshot = workflow_stage_context_resolver.binding_snapshot(stage_binding)
        if snapshot is not None:
            return snapshot
    return workflow_stage_context_resolver.resolve(
        db,
        item=item,
        target_node_id=workflow_node_id,
    )


@router.delete("/runtime-tasks/cloud-context", status_code=status.HTTP_204_NO_CONTENT)
def unbind_runtime_task_cloud_context(
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    loop_item_service.unbind_cloud_context(db, values, current_user.id)


@router.get(
    "/cloud-projects/{project_id}/loop-items",
    response_model=LoopItemListResponse,
)
def list_loop_items(
    project_id: int,
    assignee_type: str | None = Query(default=None),
    assignee_id: str | None = Query(default=None),
    execution_state: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemListResponse:
    _, items = project_board_snapshot_service.list_item_views(
        db,
        project_id,
        current_user.id,
        assignee_type=assignee_type,
        assignee_id=assignee_id,
        execution_state=execution_state,
    )
    return LoopItemListResponse(items=items)


@router.get(
    "/cloud-projects/{project_id}/loop-item-pages",
    response_model=LoopItemPageResponse,
)
def list_loop_item_page(
    project_id: int,
    item_status: str = Query(alias="status", max_length=32),
    parent_id: str | None = Query(default=None, max_length=64),
    cursor: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=10, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemPageResponse:
    items, next_cursor = external_loop_item_provider.list_page(
        db,
        project_id,
        current_user.id,
        item_status=item_status,
        parent_id=parent_id,
        cursor=cursor,
        limit=limit,
    )
    item_ids = [str(item["id"]) for item in items]
    bindings = loop_item_service.list_project_task_bindings(
        db,
        project_id,
        current_user.id,
        item_ids=item_ids,
    )
    return LoopItemPageResponse(
        items=[LoopItemResponse.model_validate(item) for item in items],
        task_bindings=[
            LoopItemTaskBindingResponse.model_validate(binding) for binding in bindings
        ],
        next_cursor=next_cursor,
    )


@router.post(
    "/cloud-projects/{project_id}/loop-items",
    response_model=LoopItemResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_loop_item(
    project_id: int,
    values: LoopItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemResponse:
    """Create a board task using a user JWT, personal API key, or task token."""

    project = cloud_project_service.get(db, project_id, current_user.id)
    event_payload = values.model_dump(
        mode="json",
        exclude={"automation_rule_id"},
    )
    event_payload["status"] = values.status or "inbox"
    event = ProjectAutomationEvent(
        event_type="task.created",
        project_id=str(project.id),
        subject_id="",
        source=project.task_provider,
        actor_user_id=current_user.id,
        payload=event_payload,
    )
    project_metadata = (
        project.metadata_json if isinstance(project.metadata_json, dict) else {}
    )
    project_workflow = project_metadata.get("workflow_definition")
    explicit_workflow = values.workflow
    has_bound_workflow = (
        explicit_workflow is not None
        and (
            explicit_workflow.stage_mode == "dag"
            or explicit_workflow.advancement_policy == "ai"
        )
    ) or (
        isinstance(project_workflow, dict)
        and (
            project_workflow.get("stage_mode") == "dag"
            or project_workflow.get("advancement_policy") == "ai"
        )
    )
    if has_bound_workflow:
        if values.automation_rule_id:
            raise _automation_selection_error(
                code="automation_selection_stale",
                message="The selected automation no longer matches this Issue",
            )
        selected_automation_id = None
    else:
        selected_automation_id = _selected_event_automation_id(
            db,
            event,
            requested_id=values.automation_rule_id,
        )

    created = loop_item_provider_router.create(db, project, current_user, values)
    response = LoopItemResponse.model_validate(created.values)

    try:
        if not has_bound_workflow and selected_automation_id:
            await project_automation_processor.process(
                db,
                ProjectAutomationEvent(
                    event_type="task.created",
                    project_id=str(project.id),
                    subject_id=str(created.values["id"]),
                    source=project.task_provider,
                    actor_user_id=current_user.id,
                    payload=response.model_dump(mode="json"),
                ),
                automation_id=selected_automation_id,
            )
    except Exception:
        db.rollback()
        logger.exception(
            "Project automation processing failed after task creation "
            "project=%s task=%s",
            project.id,
            created.values.get("id"),
        )
    if created.internal_item is not None:
        db.refresh(created.internal_item)
        if issue_workflow_start_service.should_start_after_creation(
            created.internal_item,
            project,
        ):
            await issue_workflow_start_service.start(
                db,
                item=created.internal_item,
                project=project,
                user_id=current_user.id,
            )
            db.refresh(created.internal_item)
        if created.internal_item.assignee_agent_id:
            from app.services.board_team_execution import (
                dispatch_board_team_assignment,
            )

            await dispatch_board_team_assignment(
                db,
                item=created.internal_item,
                user=current_user,
            )
            db.refresh(created.internal_item)
        if project.task_provider in {"github", "gitlab"}:
            return LoopItemResponse.model_validate(
                external_loop_item_provider.get(
                    db,
                    str(created.values["id"]),
                    current_user.id,
                )
            )
        return _loop_item_response(db, created.internal_item, current_user)
    return response


@router.post(
    "/cloud-projects/{project_id}/loop-items/reorder",
    response_model=LoopItemListResponse,
)
def reorder_loop_items(
    project_id: int,
    values: LoopItemReorder,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemListResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    if project.task_provider in {"github", "gitlab"}:
        return LoopItemListResponse(
            items=[
                LoopItemResponse.model_validate(item)
                for item in external_loop_item_provider.list(
                    db, project_id, current_user.id
                )
            ]
        )
    items = loop_item_service.reorder(db, project_id, current_user.id, values)
    return LoopItemListResponse(
        items=[_loop_item_response(db, item, current_user) for item in items]
    )


@router.get("/loop-items/{item_id}", response_model=LoopItemResponse)
def get_loop_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        return LoopItemResponse.model_validate(
            external_loop_item_provider.get(db, item_id, current_user.id)
        )
    item = loop_item_service.get(db, item_id, current_user.id)
    return _loop_item_response(db, item, current_user)


@router.post("/loop-items/{item_id}/read", response_model=LoopItemResponse)
def mark_loop_item_read(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "External provider tasks do not support Wegent read state",
        )
    item = loop_item_service.mark_read(db, item_id, current_user.id)
    return _loop_item_response(db, item, current_user)


@router.post(
    "/loop-items/{item_id}/workflow-nodes/{workflow_node_id}/decision",
    response_model=LoopItemResponse,
)
def decide_loop_item_workflow_node(
    item_id: str,
    workflow_node_id: str,
    values: WorkflowNodeDecisionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    item = issue_workflow_decision_service.decide(
        db,
        item_id=item_id,
        workflow_node_id=workflow_node_id,
        values=values,
        user_id=current_user.id,
    )
    publish_loop_item_changed(
        db,
        item=item,
        reason="workflow_decision",
        actor_user_id=current_user.id,
    )
    return _loop_item_response(db, item, current_user)


@router.get(
    "/loop-items/{item_id}/workflow-plan",
    response_model=WorkflowPlanView | None,
)
def get_loop_item_workflow_plan(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView | None:
    try:
        return issue_workflow_planning_service.get(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan",
    response_model=WorkflowPlanView,
)
async def submit_loop_item_workflow_plan(
    item_id: str,
    values: WorkflowPlanSubmit,
    automation_run_id: str = Header(
        default="",
        alias="X-Wegent-Automation-Run-ID",
        include_in_schema=False,
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkflowPlanView:
    try:
        plan = (
            project_automation_execution.submit_manager_workflow_plan(
                db,
                run_id=automation_run_id,
                issue_id=item_id,
                user_id=current_user.id,
                values=values,
            )
            if automation_run_id
            else issue_workflow_planning_service.submit(
                db,
                issue_id=item_id,
                user_id=current_user.id,
                values=values,
            )
        )
        if plan.approval_policy == "automatic":
            plan = _approve_and_dispatch_workflow_plan(
                db,
                item_id=item_id,
                user=current_user,
            )
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_submitted",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan/approve",
    response_model=WorkflowPlanView,
)
async def approve_loop_item_workflow_plan(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView:
    try:
        plan = _approve_and_dispatch_workflow_plan(
            db,
            item_id=item_id,
            user=current_user,
        )
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_approved",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan/pause",
    response_model=WorkflowPlanView,
)
async def pause_loop_item_workflow_plan(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView:
    try:
        current = issue_workflow_planning_service.get(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        if current is not None:
            await _cancel_workflow_manager(db, plan=current, user=current_user)
        plan = issue_workflow_planning_service.pause(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_paused",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan/resume",
    response_model=WorkflowPlanView,
)
async def resume_loop_item_workflow_plan(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView:
    try:
        current = issue_workflow_planning_service.get(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        if current is not None and _workflow_manager_is_active(db, current):
            raise ValueError("The AI manager is still stopping")
        plan = issue_workflow_planning_service.resume(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        if plan.status == "planning":
            await _dispatch_workflow_manager(db, item_id=item_id, user=current_user)
        elif plan.status == "running":
            _schedule_workflow_plan_executions(db, plan)
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_resumed",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan/replan",
    response_model=WorkflowPlanView,
)
async def replan_loop_item_workflow_plan(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView:
    try:
        current = issue_workflow_planning_service.get(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        if current is not None:
            stopping = await _cancel_workflow_manager(
                db,
                plan=current,
                user=current_user,
            )
            if stopping:
                raise ValueError("The AI manager is still stopping")
        plan = issue_workflow_planning_service.replan(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        await _dispatch_workflow_manager(db, item_id=item_id, user=current_user)
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_replanned",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-plan/review",
    response_model=WorkflowPlanView,
)
async def approve_loop_item_workflow_review(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> WorkflowPlanView:
    try:
        plan = issue_workflow_planning_service.approve_review(
            db,
            issue_id=item_id,
            user_id=current_user.id,
        )
        if plan.status == "planning":
            await _dispatch_workflow_manager(db, item_id=item_id, user=current_user)
        _publish_workflow_plan_changed(
            db,
            item_id=item_id,
            user_id=current_user.id,
            reason="workflow_plan_reviewed",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/loop-items/{item_id}/workflow-outcome",
    response_model=WorkflowPlanView,
)
async def report_loop_item_workflow_outcome(
    item_id: str,
    values: WorkflowTaskOutcomeSubmit,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> WorkflowPlanView:
    try:
        plan = issue_workflow_planning_service.report_outcome(
            db,
            child_id=item_id,
            user_id=current_user.id,
            values=values,
        )
        if values.verdict == "needs_rework" and plan.status == "planning":
            await _dispatch_workflow_manager(
                db,
                item_id=plan.issue_id,
                user=current_user,
            )
        _publish_workflow_plan_changed(
            db,
            item_id=plan.issue_id,
            user_id=current_user.id,
            reason="workflow_outcome_reported",
        )
        return plan
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.patch("/loop-items/{item_id}", response_model=LoopItemResponse)
async def update_loop_item(
    item_id: str,
    values: LoopItemUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        response = external_loop_item_provider.update(
            db, item_id, current_user.id, values
        )
        if values.assignee_agent_id:
            from app.services.board_team_execution import dispatch_board_team_assignment

            item = db.get(LoopItem, item_id)
            if item is None:
                raise RuntimeError("External robot assignment index is unavailable")
            await dispatch_board_team_assignment(db, item=item, user=current_user)
            from app.tasks.robot_queue_tasks import consume_queues_background

            background_tasks.add_task(consume_queues_background)
            response = external_loop_item_provider.get(db, item_id, current_user.id)
        return LoopItemResponse.model_validate(response)
    existing = loop_item_service.get(db, item_id, current_user.id)
    previous_status = existing.status
    project = cloud_project_service.get(
        db,
        int(existing.cloud_project_id),
        current_user.id,
    )
    selected_automation_id: str | None = None
    requested_status = (
        values.status
        if "status" in values.model_fields_set and values.status is not None
        else previous_status
    )
    requested_transition = project_status_transition(
        project,
        previous_status=previous_status,
        current_status=requested_status,
    )
    if requested_status != previous_status and requested_transition.entered_processing:
        event_payload = _loop_item_response(
            db,
            existing,
            current_user,
        ).model_dump(mode="json")
        event_payload["previous_status"] = previous_status
        event_payload["status"] = requested_status
        if "priority" in values.model_fields_set and values.priority is not None:
            event_payload["priority"] = values.priority
        if "tags" in values.model_fields_set and values.tags is not None:
            event_payload["tags"] = values.tags
        event = ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(existing.cloud_project_id),
            subject_id=str(existing.id),
            source="board",
            actor_user_id=current_user.id,
            payload=event_payload,
        )
        item_metadata = (
            existing.metadata_json if isinstance(existing.metadata_json, dict) else {}
        )
        workflow_binding = item_metadata.get("workflow_automation")
        bound_rule_id = (
            str(workflow_binding.get("rule_id") or "")
            if isinstance(workflow_binding, dict)
            else ""
        )
        selected_automation_id = _selected_event_automation_id(
            db,
            event,
            requested_id=values.automation_rule_id,
            bound_rule_id=bound_rule_id,
        )

    item = loop_item_service.update(db, item_id, current_user.id, values)
    issue_workflow_planning_service.sync_from_child(
        db,
        child_id=item.id,
        commit=True,
    )
    workflow_updated = "workflow" in values.model_fields_set
    status_changed = (
        "status" in values.model_fields_set and previous_status != item.status
    )
    status_transition = project_status_transition(
        project,
        previous_status=previous_status,
        current_status=item.status,
    )
    entered_processing = status_changed and status_transition.entered_processing
    should_start_workflow = selected_automation_id is None and (
        entered_processing
        or (workflow_updated and is_processing_status(project, item.status))
    )
    logger.info(
        "[issue-workflow-start] update item=%s project=%s previous_status=%s "
        "status=%s workflow_updated=%s should_start=%s fields=%s",
        item.id,
        item.cloud_project_id,
        previous_status,
        item.status,
        workflow_updated,
        should_start_workflow,
        sorted(values.model_fields_set),
    )
    if should_start_workflow:
        await issue_workflow_start_service.start(
            db,
            item=item,
            project=project,
            user_id=current_user.id,
        )
        db.refresh(item)
    if item.assignee_agent_id and "assignee_agent_id" in values.model_fields_set:
        from app.services.board_team_execution import dispatch_board_team_assignment

        await dispatch_board_team_assignment(db, item=item, user=current_user)
        from app.tasks.robot_queue_tasks import consume_queues_background

        background_tasks.add_task(consume_queues_background)
        db.refresh(item)
    elif item.assignee_agent_id and (
        "execution_config" in values.model_fields_set or entered_processing
    ):
        item = loop_item_service.refresh_agent_execution_configuration(
            db,
            item=item,
            user_id=current_user.id,
        )
        from app.services.board_team_execution import dispatch_board_team_assignment

        await dispatch_board_team_assignment(db, item=item, user=current_user)
        from app.tasks.robot_queue_tasks import consume_queues_background

        background_tasks.add_task(consume_queues_background)
        db.refresh(item)
    if status_changed:
        item_metadata_before_automation = (
            item.metadata_json if isinstance(item.metadata_json, dict) else {}
        )
        workflow_before_automation = item_metadata_before_automation.get("workflow")
        try:
            dispatched_automations = await project_automation_processor.process(
                db,
                ProjectAutomationEvent(
                    event_type="task.status_changed",
                    project_id=str(item.cloud_project_id),
                    subject_id=str(item.id),
                    source="board",
                    actor_user_id=current_user.id,
                    payload={
                        **_loop_item_response(db, item, current_user).model_dump(
                            mode="json"
                        ),
                        "previous_status": previous_status,
                    },
                ),
                automation_id=selected_automation_id,
            )
            db.refresh(item)
            item_metadata_after_automation = (
                item.metadata_json if isinstance(item.metadata_json, dict) else {}
            )
            workflow_after_automation = item_metadata_after_automation.get("workflow")
            workflow_nodes = (
                workflow_after_automation.get("nodes")
                if isinstance(workflow_after_automation, dict)
                else []
            )
            logger.info(
                "[project-automation-routing] status update item=%s project=%s "
                "previous_status=%s status=%s dispatched=%s workflow_before=%s "
                "workflow_after=%s node_ids=%s node_statuses=%s",
                item.id,
                item.cloud_project_id,
                previous_status,
                item.status,
                dispatched_automations,
                isinstance(workflow_before_automation, dict),
                isinstance(workflow_after_automation, dict),
                [node.get("id") for node in workflow_nodes if isinstance(node, dict)],
                [
                    node.get("status")
                    for node in workflow_nodes
                    if isinstance(node, dict)
                ],
            )
        except Exception:
            db.rollback()
            logger.exception(
                "Project automation processing failed after task status change "
                "project=%s task=%s previous_status=%s status=%s",
                item.cloud_project_id,
                item.id,
                previous_status,
                item.status,
            )
    publish_loop_item_changed(
        db,
        item=item,
        reason="user_update",
        actor_user_id=current_user.id,
    )
    return _loop_item_response(db, item, current_user)


@router.delete("/loop-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_loop_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    if external_loop_item_provider.is_external_item(db, item_id):
        external_loop_item_provider.archive(db, item_id, current_user.id)
        return
    loop_item_service.delete(db, item_id, current_user.id)


@router.post(
    "/loop-items/{item_id}/comments",
    response_model=LoopItemCommentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_comment(
    item_id: str,
    values: LoopItemCommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemCommentResponse:
    return LoopItemCommentResponse.model_validate(
        external_loop_item_provider.add_comment(
            db, item_id, current_user.id, values.body
        )
    )


@router.get(
    "/loop-items/{item_id}/attachments",
    response_model=list[LoopItemAttachmentResponse],
)
def list_loop_item_attachments(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> list[LoopItemAttachmentResponse]:
    attachments = loop_item_attachment_provider_router.list(
        db, item_id, current_user.id
    )
    return [LoopItemAttachmentResponse.model_validate(item) for item in attachments]


@router.post(
    "/loop-items/{item_id}/attachments",
    response_model=LoopItemAttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_attachment(
    item_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemAttachmentResponse:
    attachment = loop_item_attachment_provider_router.add(
        db,
        item_id,
        current_user.id,
        file.filename or "attachment",
        file.content_type or "application/octet-stream",
        file.file,
        settings.DELIVERY_MAX_ASSET_SIZE_MB * 1024 * 1024,
    )
    return LoopItemAttachmentResponse.model_validate(attachment)


@router.get(
    "/loop-item-attachments/{attachment_id}/access",
    response_model=LoopItemAttachmentAccessResponse,
)
def access_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemAttachmentAccessResponse:
    loop_item_attachment_provider_router.require_access(
        db, attachment_id, current_user.id
    )
    return LoopItemAttachmentAccessResponse(
        url=f"wegent://attachments/{attachment_id}",
        expires_in_seconds=0,
    )


@router.get("/loop-item-attachments/{attachment_id}/content")
def read_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> Response:
    content, content_type, filename = loop_item_attachment_provider_router.content(
        db, attachment_id, current_user.id
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.delete(
    "/loop-item-attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    loop_item_attachment_provider_router.delete(db, attachment_id, current_user.id)


@router.get(
    "/loop-items/{item_id}/tasks",
    response_model=list[LoopItemTaskBindingResponse],
)
def list_loop_item_tasks(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> list[LoopItemTaskBindingResponse]:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    bindings = loop_item_service.list_task_bindings(db, item_id, current_user.id)
    return [LoopItemTaskBindingResponse.model_validate(binding) for binding in bindings]


@router.delete(
    "/loop-items/{item_id}/tasks",
    status_code=status.HTTP_204_NO_CONTENT,
)
def unbind_loop_item_task(
    item_id: str,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    loop_item_service.unbind_task(db, item_id, values, current_user.id)


@router.post(
    "/loop-items/{item_id}/tasks",
    response_model=LoopItemTaskBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
def bind_loop_item_task(
    item_id: str,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemTaskBindingResponse:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    binding = loop_item_service.bind_task(db, item_id, values, current_user.id)
    return LoopItemTaskBindingResponse.model_validate(binding)


@router.post(
    "/loop-items/{item_id}/deliveries",
    response_model=DeliveryResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_delivery(
    item_id: str,
    values: DeliveryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryResponse:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    delivery = delivery_service.create_delivery(db, item_id, current_user.id, values)
    return _delivery_response(db, delivery)


@router.post(
    "/deliveries/{delivery_id}/assets",
    response_model=DeliveryAssetResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_delivery_asset(
    delivery_id: str,
    file: UploadFile = File(...),
    relative_path: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryAssetResponse:
    asset = delivery_service.add_asset(
        db,
        delivery_id,
        current_user.id,
        relative_path,
        file.filename or relative_path,
        file.content_type or "application/octet-stream",
        file.file,
    )
    return DeliveryAssetResponse.model_validate(asset)


@router.get(
    "/delivery-assets/{asset_id}/access",
    response_model=DeliveryAssetAccessResponse,
)
def access_delivery_asset(
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryAssetAccessResponse:
    return DeliveryAssetAccessResponse(
        url=delivery_service.access_asset_url(db, asset_id, current_user.id)
    )


@router.get("/delivery-assets/{asset_id}/content")
def read_delivery_asset(
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    content, content_type, filename = delivery_service.read_asset_content(
        db, asset_id, current_user.id
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.delete("/deliveries/{delivery_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard_delivery_draft(
    delivery_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> None:
    delivery_service.discard_draft(db, delivery_id, current_user.id)


@router.post("/deliveries/{delivery_id}/finalize", response_model=DeliveryResponse)
async def finalize_delivery(
    delivery_id: str,
    values: DeliveryFinalize | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryResponse:
    draft = delivery_service.get_delivery(db, delivery_id, current_user.id)
    item = loop_item_service.get(db, draft.loop_item_id, current_user.id)
    ready_before = issue_workflow_start_service.ready_robot_stage_ids(item)
    delivery = delivery_service.finalize(
        db,
        delivery_id,
        current_user.id,
        values or DeliveryFinalize(),
    )
    db.refresh(item)
    newly_ready = (
        issue_workflow_start_service.ready_robot_stage_ids(item) - ready_before
    )
    if newly_ready:
        started = await issue_workflow_start_service.continue_ready_stages(
            db,
            item=item,
            user_id=current_user.id,
            stage_ids=newly_ready,
        )
        if started:
            db.refresh(delivery)
    return _delivery_response(db, delivery)


@router.get("/loop-items/{item_id}/deliveries", response_model=DeliveryListResponse)
def list_deliveries(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryListResponse:
    deliveries = delivery_service.list_deliveries(db, item_id, current_user.id)
    return DeliveryListResponse(
        items=[_delivery_response(db, item) for item in deliveries]
    )


@router.get("/deliveries/{delivery_id}", response_model=DeliveryDetailResponse)
def get_delivery(
    delivery_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> DeliveryDetailResponse:
    delivery = delivery_service.get_delivery(db, delivery_id, current_user.id)
    response = _delivery_response(db, delivery)
    return DeliveryDetailResponse(
        **response.model_dump(),
        markdown=delivery_service.read_markdown(delivery),
        chat=delivery_service.read_chat(delivery),
    )
