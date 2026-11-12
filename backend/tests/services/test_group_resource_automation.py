"""Automation uses its real Group owner and the original resource/queue paths."""

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, ProjectAutomationRule
from app.schemas.project_automation import ProjectAutomationCreate
from app.services.project_automations import project_automation_service
from tests.services.test_group_agent_resources import inline
from tests.services.test_thread_participation import make_group, person


def rule_values(agent_id):
    return ProjectAutomationCreate(
        name="Group rule",
        prompt="Check the shared work",
        trigger_type="manual",
        target_kind="agent",
        target_id=agent_id,
    )


def test_group_automation_persists_in_existing_rule_storage(test_db, test_user):
    group = make_group(test_db, test_user, [])
    agent = inline(test_db, test_user, group)
    view = project_automation_service.create(
        test_db, group.id, test_user.id, rule_values(agent.id)
    )
    stored = test_db.get(ProjectAutomationRule, view["id"])
    assert stored.cloud_project_id == group.id
    assert stored.resource_type == "automation_rule"
    assert test_db.get(CloudProject, group.id) is None
    assert "automatic_processing_rules" not in (group.metadata_json or {})
    assert [
        row["id"]
        for row in project_automation_service.list(test_db, group.id, test_user.id)
    ] == [view["id"]]


@pytest.mark.parametrize("role", ["Viewer", "Developer"])
def test_group_automation_configuration_requires_group_administration(
    test_db, test_user, role
):
    member = person(test_db, "group-rule-member")
    group = make_group(test_db, test_user, [(member, role)])
    agent = inline(test_db, test_user, group)
    with pytest.raises(HTTPException) as denied:
        project_automation_service.create(
            test_db, group.id, member.id, rule_values(agent.id)
        )
    assert denied.value.status_code == 403
    assert test_db.query(ProjectAutomationRule).count() == 0


def test_group_admin_cannot_delegate_someone_elses_private_agent(test_db, test_user):
    other = person(test_db, "other-group-admin")
    group = make_group(test_db, test_user, [(other, "Maintainer")])
    agent = inline(test_db, test_user, group, visibility="private")
    with pytest.raises(HTTPException) as denied:
        project_automation_service.create(
            test_db, group.id, other.id, rule_values(agent.id)
        )
    assert denied.value.status_code == 403
    assert test_db.query(ProjectAutomationRule).count() == 0
