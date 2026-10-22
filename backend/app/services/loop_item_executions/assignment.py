"""Compile an authorized agent assignment separately from durable admission."""

from typing import TYPE_CHECKING, Any, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent, RuntimeProfile
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_executions.service import runtime_configuration_complete

if TYPE_CHECKING:
    from app.services.loop_item_executions.service import LoopItemExecutionService


def prepare_assignment(
    service: "LoopItemExecutionService",
    db: Session,
    *,
    loop_item_id: str,
    cloud_project_id: str,
    agent: ProjectChatAgent,
    assigner_user_id: int,
    environment: str,
    execution_device_id: Optional[str],
    priority: Optional[str],
    automation_context: dict[str, Any] | None = None,
    instruction: str | None = None,
) -> dict[str, Any]:
    """Resolve current execution requirements; callers own admission and persistence."""

    from app.services.project_chat.service import bot_config, compiled_bot_config

    inferred_context, _ = service._task_automation_context(db, loop_item_id)
    effective_context = (
        dict(automation_context) if automation_context is not None else inferred_context
    )
    effective_context.setdefault("dispatch_role", "executor")
    if instruction is not None:
        effective_context["execution_prompt"] = instruction
    persisted_config = bot_config(agent)
    mode = str(persisted_config.get("execution_mode") or "auto")
    runtime_source = str(effective_context.get("runtime_source") or "agent_default")
    runtime_profile_id = effective_context.get("runtime_profile_id")
    if runtime_source == "agent_default":
        runtime_profile_id = persisted_config.get("default_runtime_profile_id")
    runtime_profile = (
        db.get(RuntimeProfile, str(runtime_profile_id)) if runtime_profile_id else None
    )
    if runtime_profile is not None and runtime_profile.status != "active":
        runtime_profile = None
    task = service.resolve_task_context(
        db,
        execution=LoopItemExecution(
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
        ),
        user_id=assigner_user_id,
    )
    runtime_subject_user_id = int(
        effective_context.get("runtime_subject_user_id")
        or (task.assignee_user_id if task else 0)
        or (task.created_by_user_id if task else 0)
        or assigner_user_id
    )
    from app.services.collaboration_permissions import (
        collaboration_permission_service,
    )

    if not collaboration_permission_service.check(
        db, assigner_user_id, "execute", cloud_project_id
    ).allowed:
        raise HTTPException(403, "Insufficient permission to execute in this project")
    bound_team_id = persisted_config.get("wegent_team_id")
    if bound_team_id:
        from app.services.project_automation_domain import runnable_wegent_team

        runnable_wegent_team(
            db, assigner_user_id, int(bound_team_id), project_id=cloud_project_id
        )
    config = compiled_bot_config(
        db,
        agent,
        execution_user_id=runtime_subject_user_id,
    )
    runtime = str(config["runtime"])
    team_id = int(config["wegent_team_id"]) if runtime == "wegent" else None
    profile_metadata = (
        dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
    )
    configured_model = str(
        effective_context.get("model")
        or profile_metadata.get("model")
        or config.get("model")
        or ""
    )
    configured_model_type = (
        effective_context.get("model_type")
        or profile_metadata.get("model_type")
        or config.get("model_type")
    )
    configured_model_options = dict(
        effective_context.get("model_options")
        or profile_metadata.get("model_options")
        or config.get("model_options")
        or {}
    )
    owner_user_id = int(
        runtime_profile.user_id if runtime_profile else runtime_subject_user_id
    )
    from app.services.loop_item_executions.profile import (
        inherited_workflow_workspace_source,
    )

    inherited_workspace_source = inherited_workflow_workspace_source(effective_context)
    inherited_device_id = (
        inherited_workspace_source["deviceId"]
        if inherited_workspace_source is not None
        else None
    )
    device_id = (
        None
        if runtime == "wegent"
        else (
            str(
                inherited_device_id
                or effective_context.get("execution_device_id")
                or (runtime_profile.device_id if runtime_profile is not None else None)
                or config.get("execution_device_id")
                or execution_device_id
                or ""
            )
            or None
        )
    )
    if runtime == "wegent":
        selected_environment = "wegent"
    elif device_id and not config.get("execution_policy"):
        from app.services.loop_item_executions.profile import (
            wework_execution_environment,
        )

        selected_environment = wework_execution_environment(
            db,
            user_id=owner_user_id,
            execution_device_id=device_id,
        )
    else:
        selected_environment = str(environment or "local")
    runtime_selection = {
        "runtime_source": runtime_source,
        "runtime_profile_id": runtime_profile.id if runtime_profile else None,
        "runtime_profile_version": (
            runtime_profile.version if runtime_profile else None
        ),
        "model": configured_model or None,
        "model_type": configured_model_type,
        "model_options": configured_model_options,
        "capability_mode": config.get("capability_mode"),
        "workspace_policy": (profile_metadata.get("workspace_policy") or "project"),
    }
    if runtime != "wegent" and config.get("execution_policy"):
        from app.services.runner_routing import resolve_routing

        routing = resolve_routing(
            db,
            config=config,
            agent_id=agent.id,
            project_id=cloud_project_id,
            issue_id=loop_item_id,
            user_id=assigner_user_id,
            selection=effective_context.get("runner_selection"),
            automatic=bool(effective_context.get("run_id")),
        )
        runtime_selection["runner_routing"] = routing.snapshot()
        # Native selectors and the actual owner are materialized at claim time.
        runtime_selection.update(
            model=routing.model.model_id, model_type="runtime", model_options={}
        )
        configured_model = routing.model.model_id
        device_id = None
        owner_user_id = assigner_user_id
    workspace_binding_required = "workspace_binding" in effective_context
    waiting_runtime = runtime != "wegent" and not runtime_configuration_complete(
        execution_device_id=device_id,
        model=configured_model,
        require_model=config.get("capability_mode") != "follow_device",
        workspace_binding_required=workspace_binding_required,
        workspace_binding=effective_context.get("workspace_binding"),
    )
    return dict(
        loop_item_id=loop_item_id,
        cloud_project_id=cloud_project_id,
        executor_type="project_robot",
        owner_user_id=owner_user_id,
        agent_id=agent.id,
        team_id=team_id,
        assigner_user_id=assigner_user_id,
        environment=selected_environment,
        execution_device_id=device_id,
        priority=priority,
        automation_context=effective_context,
        requires_approval=mode == "manual_approval",
        runtime_selection=runtime_selection,
        waiting_runtime=waiting_runtime,
    )
