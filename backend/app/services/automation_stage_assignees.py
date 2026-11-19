# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validate an automation's exact stage target before creating its carrier."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.user import User
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    ProjectWorkflowDefinition,
    instantiate_workflow,
)
from app.services.stage_assignees import validate_stage_assignee


@dataclass(frozen=True)
class AutomationAssignee:
    assignee_type: str
    assignee_id: str
    workflow: IssueWorkflowInstance | None

    def creation_fields(self) -> dict[str, Any]:
        field = {
            "user": "assignee_user_id",
            "agent": "assignee_agent_id",
            "team": "assignee_team_id",
            "group": "assignee_group_id",
        }.get(self.assignee_type)
        if field is None:
            raise RuntimeError("The automatic-processing target is invalid")
        return {field: self.assignee_id, "workflow": self.workflow}


def project_agent_for_target(
    db: Session, *, project_id: str, member_id: str
) -> ProjectChatAgent | None:
    rows = (
        db.query(ProjectChatAgent)
        .filter(
            ProjectChatAgent.cloud_project_id == project_id,
            ProjectChatAgent.status == "active",
        )
        .all()
    )
    return next(
        (
            agent
            for agent in rows
            if str(agent.id) == member_id
            or (
                member_id.isdigit()
                and isinstance(agent.metadata_json, dict)
                and agent.metadata_json.get("wegent_team_id") == int(member_id)
            )
        ),
        None,
    )


def carrier_workflow(
    db: Session, *, project: CloudProject, rule: ProjectAutomationRule, owner: User
) -> IssueWorkflowInstance | None:
    event_config = (rule.metadata_json or {}).get("event_config") or {}
    raw = event_config.get("runtime_workflow_definition")
    if not isinstance(raw, dict):
        raw = (project.metadata_json or {}).get("workflow_definition")
    if not isinstance(raw, dict):
        return None
    definition = ProjectWorkflowDefinition.model_validate(raw)
    if definition.stage_mode != "dag" and definition.advancement_policy != "ai":
        return None
    workflow = instantiate_workflow(definition)
    if workflow.advancement_policy == "ai" and workflow.ai_automation_rule_id:
        coordinator = db.get(ProjectAutomationRule, workflow.ai_automation_rule_id)
        if coordinator is not None:
            from app.services.issue_execution_configuration import (
                project_automation_execution_config,
            )

            workflow.execution_config = project_automation_execution_config(
                db, coordinator, issue_creator_user_id=owner.id
            )
    return workflow


def preflight_automation_assignee(
    db: Session,
    *,
    project: CloudProject,
    rule: ProjectAutomationRule,
    run: ProjectAutomationRun,
    owner: User,
    dispatch_target: dict[str, Any],
) -> AutomationAssignee:
    """Use the same target and workflow snapshot as the eventual assignment."""
    kind = str(dispatch_target.get("kind") or "")
    identity = str(dispatch_target.get("id") or "")
    target_type = {"human": "user", "collaboration_group": "group"}.get(kind, kind)
    if kind == "agent":
        agent = project_agent_for_target(
            db, project_id=str(project.id), member_id=identity
        )
        target_type = "agent" if agent is not None else "team"
        identity = agent.id if agent is not None else identity
    workflow = (
        carrier_workflow(db, project=project, rule=rule, owner=owner)
        if not run.task_id
        else None
    )
    external = bool(run.task_id) and project.task_provider in {"github", "gitlab"}
    if external:
        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        _, item = external_loop_item_provider.assignment_stage_context(
            db, str(run.task_id), owner.id
        )
    else:
        item = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == run.task_id, LoopItem.cloud_project_id == str(project.id)
            )
            .with_for_update()
            .populate_existing()
            .one_or_none()
            if run.task_id
            else None
        )
    if item is None:
        item = LoopItem(
            id=run.task_id or f"{project.project_key}-{project.next_item_number}",
            cloud_project_id=str(project.id),
            version=1,
            metadata_json=(
                {"workflow": workflow.model_dump(mode="json")} if workflow else {}
            ),
        )
    validate_stage_assignee(
        db,
        project=project,
        item=item,
        assignee_type=target_type,
        assignee_id=identity,
        allow_stage_advance=bool(run.task_id) and not external,
        actor_user_id=owner.id,
    )
    return AutomationAssignee(target_type, identity, workflow)
