# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persisted workflow contract for the two-user default-assistant E2E."""

from app.models.delivery import CloudProject, ProjectAutomationRule
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    instantiate_workflow,
)
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationWorkflowMigration,
)
from app.services import project_automations as project_automations_module
from app.services.project_automations import project_automation_service
from tests.utils.collaboration import authorize_project


def _deliverable(requirement_id: str, value_type: str = "text") -> dict:
    return {
        "id": requirement_id,
        "name": requirement_id.replace("_", " ").title(),
        "value_type": value_type,
    }


def _six_stage_workflow(owner_id: int, engineer_id: int) -> ProjectWorkflowDefinition:
    return ProjectWorkflowDefinition.model_validate(
        {
            "version": 7,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "approval_policy": "required",
            "assignee_roles": {
                "product": [{"assignee_type": "user", "assignee_id": str(owner_id)}],
                "design": [{"assignee_type": "user", "assignee_id": str(owner_id)}],
                "engineering": [
                    {"assignee_type": "user", "assignee_id": str(engineer_id)}
                ],
                "qa": [{"assignee_type": "user", "assignee_id": str(engineer_id)}],
                "pmo": [{"assignee_type": "user", "assignee_id": str(owner_id)}],
            },
            "nodes": [
                {
                    "id": "requirement_intake",
                    "name": "需求提出",
                    "execution_mode": "human",
                    "required_assignee_type": "user",
                    "required_assignee_id": str(owner_id),
                    "required_assignee_role": "product",
                    "required_deliverables": [
                        _deliverable("objective"),
                        _deliverable("scope"),
                        _deliverable("acceptance"),
                    ],
                },
                {
                    "id": "joint_review",
                    "name": "共同评审",
                    "execution_mode": "human",
                    "depends_on": ["requirement_intake"],
                    "dependency_context": {
                        "requirement_intake": ["final_result", "deliveries"]
                    },
                    "required_deliverables": [
                        _deliverable("design_review"),
                        _deliverable("engineering_review"),
                        _deliverable("qa_review"),
                    ],
                },
                {
                    "id": "development_preparation",
                    "name": "开发准备",
                    "execution_mode": "human",
                    "depends_on": ["joint_review"],
                    "dependency_context": {
                        "joint_review": ["final_result", "deliveries"]
                    },
                    "required_assignee_type": "user",
                    "required_assignee_id": str(owner_id),
                    "required_assignee_role": "product",
                    "required_deliverables": [
                        _deliverable("design_delivery"),
                        _deliverable("technical_plan"),
                        _deliverable("test_plan"),
                    ],
                },
                {
                    "id": "development_implementation",
                    "name": "开发实现",
                    "execution_mode": "human",
                    "depends_on": ["development_preparation"],
                    "dependency_context": {
                        "development_preparation": [
                            "final_result",
                            "deliveries",
                        ]
                    },
                    "required_assignee_type": "user",
                    "required_assignee_id": str(engineer_id),
                    "required_assignee_role": "engineering",
                    "required_deliverables": [
                        _deliverable("implementation"),
                        _deliverable("self_test"),
                        _deliverable("pull_request", "pull_request"),
                    ],
                },
                {
                    "id": "quality_acceptance",
                    "name": "质量验收",
                    "execution_mode": "human",
                    "depends_on": ["development_implementation"],
                    "dependency_context": {
                        "development_implementation": [
                            "final_result",
                            "deliveries",
                        ]
                    },
                    "required_assignee_type": "user",
                    "required_assignee_id": str(engineer_id),
                    "required_assignee_role": "qa",
                    "required_deliverables": [
                        _deliverable("qa_report"),
                        _deliverable("business_acceptance"),
                        _deliverable("visual_acceptance"),
                    ],
                },
                {
                    "id": "release_launch",
                    "name": "发布上线",
                    "execution_mode": "human",
                    "depends_on": ["quality_acceptance"],
                    "dependency_context": {
                        "quality_acceptance": ["final_result", "deliveries"]
                    },
                    "required_assignee_type": "user",
                    "required_assignee_id": str(owner_id),
                    "required_assignee_role": "product",
                    "required_deliverables": [
                        _deliverable("release_record"),
                        _deliverable("post_release_verification"),
                    ],
                },
            ],
        }
    )


def test_six_stage_workflow_preserves_stage_order_and_exact_owners():
    workflow = _six_stage_workflow(owner_id=7, engineer_id=8)

    assert [node.id for node in workflow.nodes] == [
        "requirement_intake",
        "joint_review",
        "development_preparation",
        "development_implementation",
        "quality_acceptance",
        "release_launch",
    ]
    assert workflow.nodes[0].required_assignee_id == "7"
    assert workflow.nodes[3].required_assignee_id == "8"
    assert workflow.nodes[4].required_deliverables[-1].value_type == "text"
    assert workflow.nodes[3].required_deliverables[-1].value_type == "pull_request"

    snapshot = instantiate_workflow(workflow)
    assert snapshot.nodes[0].status == "ready"
    assert all(node.status == "blocked" for node in snapshot.nodes[1:])


def test_migration_persists_the_private_six_stage_plan(test_db, test_user, monkeypatch):
    project = CloudProject(
        project_key="W0069",
        name="Two-user default-assistant workflow",
        created_by_user_id=test_user.id,
        storage_prefix="projects/w0069",
        metadata_json={"workflow_definition": {"nodes": []}},
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    monkeypatch.setattr(
        project_automations_module,
        "require_cloud_project_role",
        lambda *_args: None,
    )
    migration = ProjectAutomationWorkflowMigration(
        project_version=project.version,
        automation=ProjectAutomationCreate(
            name="W-0069 task.created",
            prompt="Start the first server-owned workflow stage.",
            trigger_type="event",
            event_type="task.created",
            event_config={"execution_target": "existing_issue"},
            target_kind="human",
            target_id=str(test_user.id),
            enabled=True,
        ),
        workflow_definition=_six_stage_workflow(
            owner_id=test_user.id,
            engineer_id=test_user.id + 1,
        ),
    )

    result = project_automation_service.migrate_workflow(
        test_db,
        str(project.id),
        test_user.id,
        migration,
    )

    test_db.refresh(project)
    rule = test_db.get(ProjectAutomationRule, result["workflow_automation_id"])
    assert rule is not None
    private_plan = rule.metadata_json["event_config"]["runtime_workflow_definition"]
    assert [node["id"] for node in private_plan["nodes"]] == [
        node.id for node in migration.workflow_definition.nodes
    ]
    assert private_plan["version"] == 7
    assert project.metadata_json["workflow_definition"]["nodes"] == []
    assert project.metadata_json["workflow_automation_id"] == str(rule.id)
