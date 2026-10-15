"""One authorization and capability resolver for collaboration runner routing."""

import json
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.runner_routing import (
    ExecutionPolicy,
    ModelIdentity,
    ModelPolicy,
    RunnerCatalog,
    RunnerModel,
    RunnerSelection,
)
from app.services.cloud_project_visibility import readable_workspace_ids
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device.identity import resolve_owned_device_alias
from app.services.device.runtime_route import runtime_device_route_id
from app.services.workspaces.storage import workspace_id_for_project


def routing_error(code: str, message: str) -> HTTPException:
    return HTTPException(422, {"error_code": code, "message": message})


def active_device(db: Session, environment_id: str) -> Kind | None:
    return (
        db.query(Kind)
        .filter_by(
            id=int(environment_id), kind="Device", namespace="default", is_active=True
        )
        .first()
    )


def device_grants(db: Session, entity_type: str, entity_id: str) -> set[int]:
    return {
        int(row.resource_id)
        for row in db.query(ResourceMember)
        .filter_by(
            resource_type="Device",
            entity_type=entity_type,
            entity_id=entity_id,
            status="approved",
        )
        .filter(ResourceMember.role.in_(("Owner", "Maintainer", "Developer")))
    }


def explicit_project_environment_ids(db: Session, project_id: str) -> set[int]:
    """A project grant cannot outlive the parent space's device grant."""
    workspace_id = workspace_id_for_project(db, project_id)
    if workspace_id is None:
        return set()
    return device_grants(db, "workspace", str(workspace_id)) & device_grants(
        db, "project", project_id
    )


def project_environment_ids(db: Session, project_id: str) -> set[int]:
    """Catalog all project devices without granting cross-binding execution."""
    return explicit_project_environment_ids(
        db, project_id
    ) | legacy_project_environment_ids(db, project_id)


def execution_environment_ids(
    db: Session, project_id: str, agent_id: str | None
) -> set[int]:
    explicit = explicit_project_environment_ids(db, project_id)
    if not agent_id:
        return explicit
    return explicit | legacy_project_environment_ids(db, project_id, agent_id=agent_id)


def legacy_project_environment_ids(
    db: Session, project_id: str, *, agent_id: str | None = None
) -> set[int]:
    """V1 owner-installed fixed device references are scoped resource consent."""
    project = db.get(CloudProject, str(project_id))
    if project is None or project.status != "active" or not project.workspace_id:
        return set()
    revoked = set((project.metadata_json or {}).get("legacy_device_revocations", []))
    ids = set()
    agents = db.query(ProjectChatAgent).filter(
        ProjectChatAgent.cloud_project_id == str(project_id),
        ProjectChatAgent.status == "active",
        loop_datetime_is_unset(ProjectChatAgent.deleted_at),
    )
    if agent_id is not None:
        agents = agents.filter(ProjectChatAgent.id == agent_id)
    for agent in agents:
        if (
            (agent.metadata_json or {}).get("authorization_version")
            or not agent.device_id
            or not agent.created_by_user_id
        ):
            continue
        device = resolve_owned_device_alias(
            db, user_id=agent.created_by_user_id, device_id=agent.device_id
        )
        if not device or not device.is_active or device.id in revoked:
            continue
        grants = db.query(ResourceMember).filter(
            ResourceMember.resource_type == "Device",
            ResourceMember.resource_id == device.id,
            or_(
                (ResourceMember.entity_type == "workspace")
                & (ResourceMember.entity_id == str(project.workspace_id)),
                (ResourceMember.entity_type == "project")
                & (ResourceMember.entity_id == str(project.id)),
            ),
        )
        if any(
            grant.status != "approved"
            or grant.role not in ("Owner", "Maintainer", "Developer")
            for grant in grants
        ):
            continue
        ids.add(device.id)
    return ids


def revoke_legacy_environment_bindings(
    db: Session, workspace_id: int, device_id: int
) -> None:
    projects = db.query(CloudProject).filter(CloudProject.workspace_id == workspace_id)
    for project in projects:
        if device_id in legacy_project_environment_ids(db, project.id):
            metadata = dict(project.metadata_json or {})
            metadata["legacy_device_revocations"] = sorted(
                set(metadata.get("legacy_device_revocations", [])) | {device_id}
            )
            project.metadata_json = metadata
            project.version += 1


def visible_environment_ids(
    db: Session, user_id: int, project_id: str | None = None
) -> set[int]:
    owned = {
        row.id
        for row in db.query(Kind).filter_by(
            user_id=user_id, namespace="default", kind="Device", is_active=True
        )
    }
    workspace_ids = {row.id for row in db.execute(readable_workspace_ids(user_id))}
    shared: set[int] = set()
    for workspace_id in workspace_ids:
        shared |= device_grants(db, "workspace", str(workspace_id))
    if project_id:
        shared |= project_environment_ids(db, project_id)
    return owned | shared


def catalog(device: Kind) -> RunnerCatalog:
    value = (device.json or {}).get("spec", {}).get("runnerCatalog")
    return RunnerCatalog.model_validate(value or {"models": []})


def matching_model(device: Kind, model: ModelIdentity) -> RunnerModel | None:
    if model.source == "cloud":
        return None
    return next(
        (
            item
            for item in catalog(device).models
            if (
                item.runtime == model.runtime
                and item.provider == model.provider
                and item.model_id == model.model_id
            )
        ),
        None,
    )


def supports_model(device: Kind, model: ModelIdentity) -> bool:
    if model.source != "cloud":
        return matching_model(device, model) is not None
    capabilities = catalog(device)
    # Persisted reports before runtime capability reporting retain their evidence.
    runtimes = set(capabilities.runtimes) | {
        item.runtime for item in capabilities.models
    }
    return model.runtime in runtimes


def save_catalog(db: Session, device: Kind, value: RunnerCatalog) -> None:
    # Preserve configuration changed while a capability report was in flight.
    db.refresh(device, attribute_names=["json"], with_for_update=True)
    payload = dict(device.json or {})
    spec = dict(payload.get("spec") or {})
    spec["runnerCatalog"] = value.model_dump()
    payload["spec"] = spec
    device.json = payload
    db.flush()


def issue_binding(db: Session, issue_id: str) -> str | None:
    from app.services.runner_history import historical_issue_binding

    issue = db.get(LoopItem, issue_id)
    return historical_issue_binding(db, issue) if issue else None


def default_environment(db: Session, user_id: int) -> Kind | None:
    user = db.get(User, user_id)
    preferences = json.loads(user.preferences or "{}") if user else {}
    device_id = preferences.get("default_execution_target")
    if not device_id:
        return None
    return resolve_owned_device_alias(db, user_id=user_id, device_id=device_id)


@dataclass(frozen=True)
class ResolvedRouting:
    policy: ExecutionPolicy
    model: ModelIdentity
    candidates: list[Kind]
    source: str
    model_source: str = "agent_fixed"

    def snapshot(self) -> dict[str, Any]:
        return {
            "version": 1,
            "execution_policy": self.policy.model_dump(),
            "model": self.model.model_dump(exclude_none=True),
            "source": self.source,
            "model_source": self.model_source,
        }


def resolve_routing(db: Session, **kwargs) -> ResolvedRouting:
    try:
        return _resolve_routing(db, **kwargs)
    except HTTPException as error:
        if isinstance(error.detail, dict) and error.detail.get("error_code") in {
            "RUNNER_SELECTION_REQUIRED",
            "RUNNER_MODEL_REQUIRED",
            "AUTOMATION_RUNNER_REQUIRED",
        }:
            config = kwargs["config"]
            ids = visible_environment_ids(db, kwargs["user_id"], kwargs["project_id"])
            allowed = execution_environment_ids(
                db, kwargs["project_id"], kwargs.get("agent_id")
            )
            devices = (
                db.query(Kind)
                .filter(
                    Kind.id.in_(ids),
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.is_active.is_(True),
                )
                .all()
            )
            policy = config["execution_policy"]
            bound = issue_binding(db, kwargs["issue_id"])
            if (
                bound
                and policy["mode"] == "user_select"
                and not kwargs.get("automatic")
            ):
                policy = {"mode": "fixed", "environment_id": bound}
            environments = []
            from app.services.runner_cloud_models import cloud_model_catalog

            for device in devices:
                spec = (device.json or {}).get("spec") or {}
                workspace = spec.get("workspaceOwnerId")
                environments.append(
                    {
                        "id": str(device.id),
                        "device_key": runtime_device_route_id(device),
                        "name": spec.get("displayName") or device.name,
                        "owner_type": "workspace" if workspace else "user",
                        "owner_id": str(workspace or device.user_id),
                        "status": "unknown",
                        "project_authorized": device.id in allowed,
                        "models": [
                            model.model_dump() for model in catalog(device).models
                        ],
                        "runtimes": catalog(device).runtimes,
                    }
                )
            error.detail["runner_selection_request"] = {
                "runtime": config["runtime"],
                "execution_policy": policy,
                "model_policy": config["model_policy"],
                "environments": environments,
                "cloud_models": cloud_model_catalog(db, kwargs["user_id"]),
                "cloud_only": config["execution_policy"]["mode"] != "fixed",
                "automatic": bool(kwargs.get("automatic")),
            }
        raise


def _resolve_routing(
    db: Session,
    *,
    config: dict,
    project_id: str,
    issue_id: str,
    user_id: int,
    selection: dict | None,
    automatic: bool = False,
    agent_id: str | None = None,
) -> ResolvedRouting:
    if not config.get("model_policy"):
        raise routing_error(
            "RUNNER_CONFIGURATION_REQUIRED",
            "Review the agent execution environment and model configuration",
        )
    policy = ExecutionPolicy.model_validate(config["execution_policy"])
    model_policy = ModelPolicy.model_validate(config["model_policy"])
    selected = RunnerSelection.model_validate(selection or {})
    bound_id = issue_binding(db, issue_id)
    source = policy.mode
    if policy.mode == "user_select":
        policy, source = _user_policy(db, user_id, selected, bound_id, automatic)
    elif selected.execution_policy and selected.execution_policy != policy:
        raise routing_error("RUNNER_POLICY_FIXED", "The agent's runner policy is fixed")
    candidates = _candidates(db, policy, project_id, user_id, agent_id)
    if bound_id:
        candidates = [item for item in candidates if str(item.id) == bound_id]
        if not candidates:
            raise routing_error(
                "ISSUE_RUNNER_CONFLICT",
                "The Issue's runner does not satisfy this policy or is no longer authorized",
            )
    model = _resolve_model(
        model_policy,
        selected,
        candidates,
        config["runtime"],
        automatic,
        allow_native_default=ExecutionPolicy.model_validate(
            config["execution_policy"]
        ).mode
        == "fixed",
    )
    if model.source == "cloud":
        from app.services.runner_cloud_models import require_cloud_model

        require_cloud_model(db, user_id, model)
    elif model.source == "native" and config["execution_policy"]["mode"] != "fixed":
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE", "Local models require a fixed environment"
        )
    candidates = [item for item in candidates if supports_model(item, model)]
    if not candidates:
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE",
            "No authorized environment supports the selected model; choose an environment or repair its model configuration",
        )
    return ResolvedRouting(
        policy,
        model,
        candidates,
        source,
        (
            "agent_fixed"
            if model_policy.mode == "fixed"
            else "execution_selection" if selected.model else "environment_default"
        ),
    )


def _user_policy(
    db: Session,
    user_id: int,
    selected: RunnerSelection,
    bound_id: str | None,
    automatic: bool,
) -> tuple[ExecutionPolicy, str]:
    if selected.execution_policy and selected.execution_policy.mode != "user_select":
        return selected.execution_policy, "execution_selection"
    if automatic:
        raise routing_error(
            "AUTOMATION_RUNNER_REQUIRED",
            "Configure the automation's runner policy before enabling it",
        )
    if bound_id:
        return ExecutionPolicy(mode="fixed", environment_id=bound_id), "issue_binding"
    device = default_environment(db, user_id)
    if device:
        return (
            ExecutionPolicy(mode="fixed", environment_id=str(device.id)),
            "personal_default",
        )
    raise routing_error(
        "RUNNER_SELECTION_REQUIRED",
        "Select an execution environment or configure your personal default",
    )


def _candidates(
    db: Session,
    policy: ExecutionPolicy,
    project_id: str,
    user_id: int,
    agent_id: str | None = None,
) -> list[Kind]:
    try:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
    except HTTPException as error:
        raise routing_error(
            "RUNNER_PROJECT_ACCESS_REVOKED",
            "The triggering user no longer has permission to execute in the project",
        ) from error
    ids = execution_environment_ids(db, project_id, agent_id)
    if policy.mode == "fixed":
        ids &= {int(policy.environment_id)}
    devices = (
        db.query(Kind)
        .filter(
            Kind.id.in_(ids),
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
        )
        .all()
    )
    if not devices:
        raise routing_error(
            "RUNNER_ENVIRONMENT_UNAVAILABLE",
            "No execution environment is authorized for this selection",
        )
    return devices


def _resolve_model(
    policy: ModelPolicy,
    selection: RunnerSelection,
    candidates: list[Kind],
    runtime: str,
    automatic: bool,
    allow_native_default: bool = True,
) -> ModelIdentity:
    model = policy.model if policy.mode == "fixed" else selection.model
    if policy.mode == "fixed" and selection.model and selection.model != policy.model:
        raise routing_error("RUNNER_MODEL_FIXED", "The agent's model is fixed")
    if model is None and not automatic and candidates and allow_native_default:
        defaults = [
            next(
                (
                    item
                    for item in catalog(device).models
                    if item.runtime == runtime and item.is_default
                ),
                None,
            )
            for device in candidates
        ]
        identities = {
            (item.runtime, item.provider, item.model_id)
            for item in defaults
            if item is not None
        }
        if all(defaults) and len(identities) == 1:
            model = defaults[0]
    if model is None:
        raise routing_error(
            "RUNNER_MODEL_REQUIRED", "Select a model before starting this execution"
        )
    if model.runtime != runtime:
        raise routing_error(
            "RUNNER_RUNTIME_MISMATCH", "The model does not support the agent's runtime"
        )
    return ModelIdentity.model_validate(
        model.model_dump(
            include={"runtime", "provider", "model_id", "source", "cloud_model"}
        )
    )


def eligible_runner(db: Session, execution: Any, device: Kind) -> bool:
    from app.services.collaboration_revocation import execution_authorized

    if not execution_authorized(db, execution):
        return False
    snapshot = execution.runtime_selection["runner_routing"]
    try:
        bound_id = issue_binding(db, execution.loop_item_id)
    except HTTPException:
        return False
    if bound_id and bound_id != str(device.id):
        return False
    routes = [
        (execution.agent_id, snapshot),
        *execution.runtime_selection.get("group_runner_requirements", {}).items(),
    ]
    for agent_id, route in routes:
        try:
            members = _candidates(
                db,
                ExecutionPolicy.model_validate(route["execution_policy"]),
                execution.cloud_project_id,
                execution.assigner_user_id,
                agent_id,
            )
            model = ModelIdentity.model_validate(route["model"])
            if model.source == "cloud":
                from app.services.runner_cloud_models import require_cloud_model

                require_cloud_model(db, execution.assigner_user_id, model)
            if device.id not in {item.id for item in members} or not supports_model(
                device, model
            ):
                return False
        except HTTPException:
            return False
    return True


def claim_routing(db: Session, execution: Any, device: Kind) -> bool:
    """Lock the Issue before checking affinity; commit with the execution CAS."""
    snapshot = execution.runtime_selection.get("runner_routing")
    issue = (
        db.query(LoopItem)
        .filter_by(id=execution.loop_item_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    if issue is None:
        return False
    try:
        bound = issue_binding(db, issue.id)
    except HTTPException:
        return False
    if bound and bound != str(device.id):
        return False
    if snapshot is not None and not eligible_runner(db, execution, device):
        return False
    return _bind_issue_in_claim(db, issue, execution, device)


def _bind_issue_in_claim(
    db: Session, issue: LoopItem, execution: Any, device: Kind
) -> bool:
    """Both historical and routed claims share one durable affinity lock."""
    from app.models.loop_item_execution import LoopItemExecution

    scope = getattr(execution, "execution_scope", "")
    if (
        scope
        and db.query(LoopItemExecution.id)
        .filter(
            LoopItemExecution.execution_scope == scope,
            LoopItemExecution.status.in_(["claimed", "running", "cancel_requested"]),
        )
        .with_for_update()
        .first()
    ):
        return False
    if not (issue.metadata_json or {}).get("runner_binding"):
        metadata = case(
            (
                func.lower(func.json_type(LoopItem.metadata_json)) == "object",
                LoopItem.metadata_json,
            ),
            else_=func.json_object(),
        )
        changed = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == issue.id,
                LoopItem.version == issue.version,
                or_(
                    func.json_extract(metadata, "$.runner_binding").is_(None),
                    func.lower(
                        func.json_type(func.json_extract(metadata, "$.runner_binding"))
                    )
                    == "null",
                ),
            )
            .update(
                {
                    LoopItem.metadata_json: func.json_set(
                        metadata,
                        "$.runner_binding",
                        func.json_object("environment_id", str(device.id)),
                    ),
                },
                synchronize_session=False,
            )
        )
        if changed != 1:
            db.refresh(issue, with_for_update=True)
            return issue_binding(db, issue.id) == str(device.id)
        db.refresh(issue, with_for_update=True)
    return True


def bind_claimed_runner(db: Session, execution: Any, device: Kind) -> None:
    snapshot = execution.runtime_selection.get("runner_routing")
    if snapshot is None:
        return
    issue = db.get(LoopItem, execution.loop_item_id)
    if issue_binding(db, issue.id) != str(device.id):
        raise routing_error(
            "ISSUE_RUNNER_CONFLICT", "Issue affinity changed before the claim completed"
        )
    from app.services.runner_cloud_models import execution_model_values

    model_id, model_type, model_options, account = execution_model_values(
        db,
        execution.assigner_user_id,
        device,
        ModelIdentity.model_validate(snapshot["model"]),
    )
    intent = dict(execution.execution_intent)
    selection = dict(execution.runtime_selection)
    selection.update(
        {
            "model": model_id,
            "model_type": model_type,
            "model_options": model_options,
            "resolved_environment_id": str(device.id),
            "account_label": account,
        }
    )
    intent["runtime_selection"] = selection
    # Resolve credentials at execution; persisted rules contain only identities.
    request = dict(intent.get("runtime_request") or {})
    if request:
        request.update(
            {
                "deviceId": runtime_device_route_id(device),
                "modelId": model_id,
                "modelType": model_type,
                "modelOptions": model_options,
                "modelSelection": {
                    "modelName": model_id,
                    "modelType": model_type,
                    "options": model_options,
                },
            }
        )
        request.pop("modelConfig", None)
        intent["runtime_request"] = request
    execution.execution_payload = json.dumps(intent)
    execution.executor_owner_user_id = device.user_id
    db.flush()


def validate_agent_policies(
    db: Session,
    *,
    user_id: int,
    policy: ExecutionPolicy | None,
    model_policy: ModelPolicy | None,
    runtime: str | None = None,
    project_id: str | None = None,
) -> None:
    """Creation and dispatch use the same grants and stable model matching."""
    if policy is None and model_policy is None:
        return
    if policy is None or model_policy is None:
        raise routing_error(
            "RUNNER_CONFIGURATION_REQUIRED",
            "Configure both environment and model policies",
        )
    if runtime is not None and runtime not in {"codex", "claude_code"}:
        raise routing_error(
            "RUNNER_RUNTIME_MISMATCH", "Runner policies require a native executor"
        )
    ids = (
        explicit_project_environment_ids(db, project_id)
        if project_id
        else visible_environment_ids(db, user_id)
    )
    if policy.mode == "fixed":
        ids &= {int(policy.environment_id)}
    elif policy.mode == "project_pool" and project_id:
        ids &= explicit_project_environment_ids(db, project_id)
    candidates = (
        db.query(Kind)
        .filter(
            Kind.id.in_(ids),
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
        )
        .all()
    )
    if policy.mode == "fixed" and not candidates:
        raise routing_error(
            "RUNNER_ENVIRONMENT_UNAVAILABLE",
            "The selected environment is not authorized",
        )
    if model_policy.mode == "fixed":
        if runtime is not None and model_policy.model.runtime != runtime:
            raise routing_error(
                "RUNNER_RUNTIME_MISMATCH",
                "The selected model does not support the executor",
            )
        if model_policy.model.source == "cloud":
            from app.services.runner_cloud_models import require_cloud_model

            require_cloud_model(db, user_id, model_policy.model)
            if policy.mode != "fixed":
                return
        if model_policy.model.source == "native" and policy.mode != "fixed":
            raise routing_error(
                "RUNNER_MODEL_UNAVAILABLE", "Local models require a fixed environment"
            )
        if not any(supports_model(device, model_policy.model) for device in candidates):
            raise routing_error(
                "RUNNER_MODEL_UNAVAILABLE",
                "No authorized environment supports the selected model; select another model",
            )


def resolve_group_routing(
    db: Session,
    *,
    group: dict,
    project_id: str,
    issue_id: str,
    user_id: int,
    selection: dict | None,
    automatic: bool = False,
) -> dict:
    """A collaboration group shares one Issue runner but keeps member models."""
    from app.models.delivery import ProjectChatAgent
    from app.services.project_chat.service import bot_config, compiled_bot_config

    agents = (
        db.query(ProjectChatAgent)
        .filter_by(cloud_project_id=project_id, status="active")
        .all()
    )
    routes = {}
    intersection = None
    for reference in [group.get("leader"), *(group.get("members") or [])]:
        if not isinstance(reference, dict) or reference.get("kind") != "agent":
            continue
        member_id = str(reference["id"])
        agent = next(
            (
                row
                for row in agents
                if str(row.id) == member_id
                or str(bot_config(row).get("wegent_team_id")) == member_id
            ),
            None,
        )
        if agent is None:
            raise routing_error(
                "RUNNER_CONFIGURATION_REQUIRED", "A group member is unavailable"
            )
        config = compiled_bot_config(db, agent, execution_user_id=user_id)
        if not config.get("execution_policy"):
            continue
        choices = {
            key: value
            for key, value in (selection or {}).items()
            if (
                key == "execution_policy"
                and config["execution_policy"]["mode"] == "user_select"
                or key == "model"
                and config["model_policy"]["mode"] == "user_select"
            )
        }
        route = resolve_routing(
            db,
            config=config,
            agent_id=agent.id,
            project_id=project_id,
            issue_id=issue_id,
            user_id=user_id,
            selection=choices,
            automatic=automatic,
        )
        routes[agent.id] = route.snapshot()
        candidates = {device.id for device in route.candidates}
        intersection = candidates if intersection is None else intersection & candidates
    if routes and not intersection:
        raise routing_error(
            "ISSUE_RUNNER_CONFLICT",
            "No authorized runner satisfies all group members' environment and model policies",
        )
    return routes


def profile_for_runner(
    db: Session, profile: Any, execution: Any, snapshot: dict | None = None
) -> Any:
    from dataclasses import replace

    from app.schemas.project_chat import ProjectChatWorkspaceBindingView

    device = active_device(db, execution.runtime_selection["resolved_environment_id"])
    requirements = snapshot or execution.runtime_selection["runner_routing"]
    from app.services.runner_cloud_models import execution_model_values

    model_id, model_type, options, _account = execution_model_values(
        db,
        execution.assigner_user_id,
        device,
        ModelIdentity.model_validate(requirements["model"]),
    )
    return replace(
        profile,
        owner_user_id=device.user_id,
        model=model_id,
        model_type=model_type,
        model_options=options,
        local_project_id=0,
        # Runner selection does not bind a code project. Project preparation
        # supplies its own workspace when the project has a repository config.
        workspace_binding_override=ProjectChatWorkspaceBindingView(
            type="standalone", status="ready"
        ),
    )
