"""Explicitly resume a historical Issue with a reviewed experience snapshot."""

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    loop_datetime_is_unset,
)
from app.schemas.issue_workflow import ProjectWorkflowDefinition, instantiate_workflow
from app.services.issue_workflow_planning import issue_workflow_planning_service
from shared.telemetry.decorators import trace_async


def available_experiences(db: Session, *, issue_id: str, user_id: int) -> list[dict]:
    issue = issue_workflow_planning_service._issue(db, issue_id, user_id)
    rules = (
        db.query(ProjectAutomationRule)
        .filter(
            ProjectAutomationRule.cloud_project_id == issue.cloud_project_id,
            loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
        )
        .all()
    )
    return [
        {"id": rule.id, "name": rule.title}
        for rule in rules
        if ((rule.metadata_json or {}).get("event_config") or {})
        .get("wework_flow", {})
        .get("version")
        == 3
    ]


@trace_async()
async def adopt_experience(
    db: Session,
    *,
    issue_id: str,
    user_id: int,
    automation_id: str,
    intent: str,
) -> dict:
    from app.services.issue_assignments import write_assignment
    from app.services.issue_workflow_start import issue_workflow_start_service
    from app.services.loop_item_events import publish_loop_item_changed
    from app.services.project_automations import project_automation_service

    issue = issue_workflow_planning_service._issue(
        db, issue_id, user_id, for_update=True
    )
    previous = issue_workflow_planning_service._workflow(issue)
    if not previous.get("migration_required"):
        raise ValueError("This Issue already uses experience assignment")
    rule = project_automation_service._rule(db, issue.cloud_project_id, automation_id)
    config = (rule.metadata_json or {}).get("event_config") or {}
    if (config.get("wework_flow") or {}).get("version") != 3:
        raise ValueError("Save the automation with an explicit advancement mode first")
    project_automation_service._validate_workflow_definition(config)
    definition = ProjectWorkflowDefinition.model_validate(
        config["runtime_workflow_definition"]
    )
    workflow = instantiate_workflow(definition)
    workflow.intent = intent.strip()
    workflow.coordinator_user_id = user_id
    if not workflow.intent:
        raise ValueError("Describe the current Issue goal before continuing")
    metadata = dict(issue.metadata_json or {})
    metadata.pop("workflow_automation", None)
    metadata["experience_migration"] = {
        **metadata.get("experience_migration", {}),
        "previous_workflow": previous,
        "adopted": True,
    }
    issue.metadata_json = metadata
    issue.status = "in_progress"
    issue.assignee_user_id = None
    issue.assignee_agent_id = ""
    write_assignment(db, issue, workflow.model_dump(mode="json"), workflow.intent)
    db.commit()
    project = db.get(CloudProject, issue.cloud_project_id)
    await issue_workflow_start_service.start(
        db, item=issue, project=project, user_id=user_id
    )
    publish_loop_item_changed(
        db, item=issue, reason="experience_adopted", actor_user_id=user_id
    )
    return issue_workflow_planning_service._workflow(issue)
