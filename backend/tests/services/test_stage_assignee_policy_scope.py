# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit targets apply by default; named pilot stages require enrollment."""

from copy import deepcopy

import pytest
from fastapi import HTTPException

from app.schemas.issue_workflow import ProjectWorkflowDefinition, instantiate_workflow
from app.services.stage_assignees import (
    STAGE_ASSIGNEE_FLAG,
    stage_assignee_enforcement_enabled,
    stage_assignee_policy_enabled,
    validate_stage_assignee,
)
from tests.services.test_stage_assignees import stage_scenario  # noqa: F401


@pytest.mark.parametrize("name", ["需求提出", "质量验收"])
@pytest.mark.parametrize("selection", ["tags", "node", "unknown_pointer"])
def test_unconfigured_named_stage_preserves_legacy_assignment(
    stage_scenario, name, selection
):
    s = stage_scenario
    metadata = {"tags": [name]}
    if selection != "tags":
        metadata["workflow"] = {
            "current_stage_id": "legacy" if selection == "node" else "missing",
            "nodes": [{"id": "legacy", "name": name}],
        }

    assert (
        validate_stage_assignee(
            s.db,
            project=s.project,
            item=s.issue,
            assignee_type="group",
            assignee_id="legacy-target",
            metadata=metadata,
            allow_stage_advance=True,
        )
        == metadata
    )
    assert not s.db.new


@pytest.mark.parametrize("name", ["需求提出", "质量验收"])
@pytest.mark.parametrize("target_kind", ["exact", "role"])
def test_explicit_named_stage_target_is_enforced_without_pilot_flag(
    stage_scenario, name, target_kind
):
    s = stage_scenario
    node = {"id": "stage", "name": name}
    workflow = {"current_stage_id": "stage", "nodes": [node]}
    if target_kind == "exact":
        node.update(required_assignee_type="user", required_assignee_id=str(s.owner.id))
    else:
        node["required_assignee_role"] = "qa"
        workflow["assignee_roles"] = {
            "qa": [{"assignee_type": "user", "assignee_id": str(s.owner.id)}]
        }
    metadata = {"workflow": workflow}
    checked = dict(
        project=s.project,
        item=s.issue,
        metadata=metadata,
        assignee_type="user",
        allow_stage_advance=True,
    )

    assert (
        validate_stage_assignee(s.db, assignee_id=str(s.owner.id), **checked)
        == metadata
    )
    with pytest.raises(HTTPException) as error:
        validate_stage_assignee(s.db, assignee_id="9999999", **checked)
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["expected_assignee"] == {
        "assignee_type": "user",
        "assignee_id": str(s.owner.id),
    }
    assert metadata["workflow"]["current_stage_id"] == "stage"
    assert "stage_assignee_history" not in metadata


def test_project_enrollment_preserves_existing_workflow_snapshot_scope(stage_scenario):
    s = stage_scenario
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "feature_flags": {STAGE_ASSIGNEE_FLAG: True},
            "nodes": [{"id": "intro", "name": "需求提出"}],
        }
    )
    s.project.metadata_json = {"workflow_definition": definition.model_dump()}
    legacy = {"workflow": {"nodes": [{"id": "intro", "name": "需求提出"}]}}
    newly_applied = {"workflow": instantiate_workflow(definition).model_dump()}

    assert stage_assignee_policy_enabled(s.project, {})
    assert not stage_assignee_policy_enabled(s.project, legacy)
    assert stage_assignee_enforcement_enabled(s.project, legacy)
    assert stage_assignee_policy_enabled(s.project, newly_applied)
    assert newly_applied["workflow"]["feature_flags"] == {STAGE_ASSIGNEE_FLAG: True}

    disabled = deepcopy(newly_applied)
    disabled["workflow"]["feature_flags"][STAGE_ASSIGNEE_FLAG] = False
    assert not stage_assignee_policy_enabled(s.project, disabled)
    assert not stage_assignee_enforcement_enabled(s.project, disabled)

    s.project.metadata_json = {
        "workflow_definition": {"feature_flags": {STAGE_ASSIGNEE_FLAG: False}}
    }
    assert not stage_assignee_policy_enabled(s.project, newly_applied)
    assert not stage_assignee_enforcement_enabled(s.project, newly_applied)


def test_legacy_snapshot_cannot_inherit_a_later_project_fixed_owner_rule(
    stage_scenario,
):
    s = stage_scenario
    s.project.metadata_json = {
        "workflow_definition": {"feature_flags": {STAGE_ASSIGNEE_FLAG: True}}
    }
    legacy = {
        "workflow": {
            "current_stage_id": "intro",
            "nodes": [{"id": "intro", "name": "需求提出"}],
        }
    }
    assert (
        validate_stage_assignee(
            s.db,
            project=s.project,
            item=s.issue,
            metadata=legacy,
            assignee_type="user",
            assignee_id=str(s.owner.id),
        )
        == legacy
    )
