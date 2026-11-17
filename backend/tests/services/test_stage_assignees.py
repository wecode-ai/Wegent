"""Stage constraints preserve target identity and current authorization."""

from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.stage_assignees import (
    STAGE_ASSIGNEE_FLAG,
    resolve_role_assignee,
    validate_stage_assignee,
)
from tests.utils.agent_resources import create_runnable_wegent_team
from tests.utils.collaboration import (
    authorize_project,
    authorize_project_agent,
    authorize_resource,
)


@pytest.fixture
def stage_scenario(test_db: Session, test_user: User) -> SimpleNamespace:
    project = CloudProject(
        public_id=str(uuid4()),
        project_key=f"STAGE{uuid4().hex[:6].upper()}",
        name="Stage constraints",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        title="Stage work",
        created_by_user_id=test_user.id,
        assignee_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "current_stage_id": "build",
                "nodes": [
                    {
                        "id": "build",
                        "name": "开发实现",
                        "required_assignee_type": "user",
                        "required_assignee_id": str(test_user.id),
                    }
                ],
            }
        },
    )
    test_db.add(issue)
    test_db.flush()
    return SimpleNamespace(db=test_db, project=project, issue=issue, owner=test_user)


@pytest.fixture
def pilot_policy(stage_scenario):
    s = stage_scenario
    s.project.metadata_json = {
        "workflow_definition": {"feature_flags": {STAGE_ASSIGNEE_FLAG: True}}
    }
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["feature_flags"] = {STAGE_ASSIGNEE_FLAG: True}
    s.issue.metadata_json = metadata
    s.db.flush()


def validate(s: SimpleNamespace, **kwargs) -> dict:
    return validate_stage_assignee(
        s.db,
        project=s.project,
        item=s.issue,
        assignee_type=kwargs.pop("assignee_type", "user"),
        assignee_id=kwargs.pop("assignee_id", str(s.owner.id)),
        **kwargs,
    )


def test_wrong_target_is_structured_and_creates_no_records(stage_scenario):
    s = stage_scenario
    original = deepcopy(s.issue.metadata_json)
    with pytest.raises(HTTPException) as error:
        validate(s, assignee_id="99999999")
    assert error.value.status_code == 422
    assert error.value.detail == {
        "reason_code": "stage_assignee_mismatch",
        "issue_version": s.issue.version,
        "stage_id": "build",
        "expected_assignee": {"assignee_type": "user", "assignee_id": str(s.owner.id)},
        "actual_assignee": {"assignee_type": "user", "assignee_id": "99999999"},
        "reason": "Stage requires another assignee",
    }
    assert s.issue.metadata_json == original
    assert s.db.query(LoopItemComment).count() == 0
    assert s.db.query(LoopItemExecution).count() == 0


def test_human_alias_and_username_resolve_to_the_same_person(stage_scenario):
    s = stage_scenario
    result = validate(s, assignee_type="human", assignee_id=s.owner.user_name)
    assert result == s.issue.metadata_json
    assert result is not s.issue.metadata_json
    assert not s.db.new


def test_inactive_required_user_is_rejected_without_reassignment(stage_scenario):
    s = stage_scenario
    s.owner.is_active = False
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s)
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["reason"] == "Required assignee lost project access"
    assert s.issue.assignee_user_id == s.owner.id


def test_revoked_project_membership_rejects_the_exact_user(stage_scenario):
    s = stage_scenario
    s.project.membership_mode = "explicit"
    s.db.get(Kind, s.project.workspace_id).user_id = 0
    s.db.query(ResourceMember).filter_by(
        resource_type="CloudProject", resource_id=int(s.project.id), entity_type="user"
    ).delete(synchronize_session=False)
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s)
    assert error.value.detail["reason"] == "Required assignee lost project access"


@pytest.mark.parametrize("target_type", ["agent", "team"])
def test_exact_target_type_is_checked_before_assignment_canonicalization(
    stage_scenario, target_type
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["nodes"][0].update(
        required_assignee_type=target_type, required_assignee_id="same-identity"
    )
    with pytest.raises(HTTPException) as error:
        validate(
            s,
            metadata=metadata,
            assignee_type="team" if target_type == "agent" else "agent",
            assignee_id="same-identity",
        )
    assert error.value.detail["expected_assignee"]["assignee_type"] == target_type


def test_agent_permission_revocation_is_rechecked(stage_scenario):
    s = stage_scenario
    agent = ProjectChatAgent(
        id="stage-agent",
        cloud_project_id=str(s.project.id),
        name="Stage Agent",
        created_by_user_id=s.owner.id,
        status="active",
        metadata_json={},
    )
    authorize_project_agent(s.db, agent)
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["nodes"][0].update(
        required_assignee_type="agent", required_assignee_id=agent.id
    )
    assert (
        validate(s, metadata=metadata, assignee_type="agent", assignee_id=agent.id)
        == metadata
    )
    s.db.query(ResourceMember).filter_by(
        resource_type="Workspace", entity_type="project_agent", entity_id=agent.id
    ).update({"status": "rejected"}, synchronize_session=False)
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, assignee_type="agent", assignee_id=agent.id)
    assert error.value.detail["reason"] == "Required assignee lost project access"


@pytest.mark.parametrize("target_type", ["agent", "team"])
def test_explicit_engineering_role_accepts_authorized_nonhuman_targets(
    stage_scenario, target_type
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    node = metadata["workflow"]["nodes"][0]
    node.pop("required_assignee_type")
    node.pop("required_assignee_id")
    node["required_assignee_role"] = "engineering"
    team = (
        create_runnable_wegent_team(
            s.db, user_id=s.owner.id, name_prefix="engineering-role"
        )
        if target_type == "team"
        else None
    )
    agent = ProjectChatAgent(
        id="engineering-agent",
        cloud_project_id=str(s.project.id),
        name="Engineering agent",
        created_by_user_id=s.owner.id,
        status="active",
        metadata_json={"wegent_team_id": team.id} if team else {},
    )
    authorize_project_agent(s.db, agent)
    if team:
        authorize_resource(s.db, s.project, team)
    target_id = str(team.id) if team else agent.id
    metadata["workflow"]["assignee_roles"] = {
        "engineering": [{"assignee_type": target_type, "assignee_id": target_id}]
    }

    assert (
        validate(s, metadata=metadata, assignee_type=target_type, assignee_id=target_id)
        == metadata
    )
    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, assignee_type=target_type, assignee_id="wrong")
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    if team:
        team.is_active = False
    else:
        agent.status = "inactive"
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, assignee_type=target_type, assignee_id=target_id)
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"


@pytest.mark.parametrize("disabled", [False, True])
def test_unconstrained_or_disabled_stage_preserves_legacy_behavior(
    stage_scenario, disabled
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    if disabled:
        metadata["workflow"]["feature_flags"] = {STAGE_ASSIGNEE_FLAG: False}
    else:
        metadata["workflow"]["nodes"][0].pop("required_assignee_type")
        metadata["workflow"]["nodes"][0].pop("required_assignee_id")
    assert (
        validate(s, metadata=metadata, assignee_type="group", assignee_id="other")
        == metadata
    )


def test_project_can_disable_enforcement_for_an_older_issue_snapshot(stage_scenario):
    s = stage_scenario
    s.project.metadata_json = {
        "workflow_definition": {"feature_flags": {STAGE_ASSIGNEE_FLAG: False}}
    }
    assert (
        validate(s, assignee_type="group", assignee_id="other") == s.issue.metadata_json
    )


def test_unknown_stage_cannot_bypass_the_current_constraint(stage_scenario):
    with pytest.raises(HTTPException) as error:
        validate(stage_scenario, stage_id="unknown")
    assert error.value.detail["reason"] == "Workflow stage does not exist"


@pytest.mark.parametrize("requested_stage", [None, "build"])
def test_unknown_current_stage_cannot_disable_constraints(
    stage_scenario, requested_stage
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["current_stage_id"] = "missing"
    original = deepcopy(metadata)

    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, stage_id=requested_stage)

    assert error.value.status_code == 422
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["issue_version"] == s.issue.version
    assert error.value.detail["stage_id"] == "missing"
    assert error.value.detail["actual_assignee"] == {
        "assignee_type": "user",
        "assignee_id": str(s.owner.id),
    }
    assert error.value.detail["reason"] == "Workflow stage does not exist"
    assert metadata == original
    assert not s.db.new


@pytest.mark.parametrize("ready_status", [None, "ready"])
def test_multiple_constrained_roots_require_an_explicit_stage(
    stage_scenario, ready_status
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    workflow = metadata["workflow"]
    workflow.pop("current_stage_id")
    workflow["nodes"][0]["status"] = ready_status
    workflow["nodes"].append(
        {
            "id": "parallel",
            "name": "Parallel work",
            "status": ready_status,
            "required_assignee_type": "user",
            "required_assignee_id": "other",
        }
    )

    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata)

    assert error.value.status_code == 422
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["stage_id"] is None
    assert error.value.detail["expected_assignee"] == {
        "assignee_type": "stage",
        "assignee_id": None,
    }
    assert error.value.detail["reason"] == "Workflow stage selection is required"
    assert validate(s, metadata=metadata, stage_id="build") == metadata


def test_unconstrained_parallel_root_cannot_hide_a_required_target(stage_scenario):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"].pop("current_stage_id")
    metadata["workflow"]["nodes"].append(
        {
            "id": "free",
            "name": "Unconstrained work",
        }
    )

    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, assignee_id="other")

    assert error.value.detail["reason"] == "Workflow stage selection is required"
    assert (
        validate(s, metadata=metadata, stage_id="free", assignee_id="other") == metadata
    )


@pytest.mark.parametrize("current_stage", [None, "missing"])
def test_unconstrained_legacy_workflows_retain_stage_selection_behavior(
    stage_scenario, current_stage
):
    s = stage_scenario
    metadata = {
        "workflow": {
            "current_stage_id": current_stage,
            "nodes": [
                {"id": "first", "name": "First"},
                {"id": "second", "name": "Second"},
            ],
        }
    }

    assert (
        validate(s, metadata=metadata, assignee_type="group", assignee_id="legacy")
        == metadata
    )


def test_completed_root_is_not_selected_alongside_the_only_ready_stage(stage_scenario):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"].pop("current_stage_id")
    metadata["workflow"]["nodes"][0]["status"] = "ready"
    metadata["workflow"]["nodes"].append(
        {
            "id": "old",
            "name": "Previous work",
            "status": "completed",
            "required_assignee_type": "user",
            "required_assignee_id": "former-owner",
        }
    )

    assert validate(s, metadata=metadata) == metadata
    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, assignee_id="other")
    assert error.value.detail["stage_id"] == "build"


@pytest.mark.usefixtures("pilot_policy")
def test_introduction_owner_change_returns_atomic_review_metadata(stage_scenario):
    s = stage_scenario
    s.owner.user_name = "jiangyang7"
    s.db.flush()
    metadata = {
        "tags": ["需求提出", "P0"],
        "workflow": {
            "version": 2,
            "feature_flags": {STAGE_ASSIGNEE_FLAG: True},
            "current_stage_id": "intro",
            "nodes": [
                {"id": "intro", "name": "需求提出"},
                {"id": "review", "name": "共同评审"},
            ],
        },
    }
    with pytest.raises(HTTPException):
        validate(s, metadata=metadata, assignee_type="group", assignee_id="group-1")
    result = validate(
        s,
        metadata=metadata,
        assignee_type="group",
        assignee_id="group-1",
        allow_stage_advance=True,
        actor_user_id=s.owner.id,
    )
    assert result["workflow"]["current_stage_id"] == "review"
    assert result["workflow"]["version"] == 3
    assert result["tags"] == ["P0", "共同评审"]
    assert result["stage_assignee_history"][-1]["actor_user_id"] == s.owner.id
    assert metadata["workflow"]["current_stage_id"] == "intro"


@pytest.mark.usefixtures("pilot_policy")
def test_missing_common_review_snapshot_rejects_owner_change(stage_scenario):
    s = stage_scenario
    metadata = {
        "workflow": {
            "feature_flags": {STAGE_ASSIGNEE_FLAG: True},
            "current_stage_id": "intro",
            "nodes": [{"id": "intro", "name": "需求提出"}],
        }
    }
    with pytest.raises(HTTPException) as error:
        validate(
            s,
            metadata=metadata,
            assignee_type="group",
            assignee_id="group-1",
            allow_stage_advance=True,
        )
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert "missing" in error.value.detail["reason"]


@pytest.mark.parametrize("exact_target", [False, True])
@pytest.mark.parametrize("review_role", ["product", "ui"])
@pytest.mark.usefixtures("pilot_policy")
def test_quality_substep_overrides_initial_target_with_configured_reviewer(
    stage_scenario, exact_target, review_role
):
    s = stage_scenario
    metadata = {
        "quality_handoff": {
            "required_assignee_role": review_role,
            "pr_heads": {
                "https://github.com/acme/app/pull/12": {
                    "complete": True,
                    "head_sha": "head-1",
                    "draft": False,
                    "state": "OPEN",
                    "mergeable": "MERGEABLE",
                    "required_checks": [],
                }
            },
        },
        "badges": [
            {"icon": "git-pull-request", "url": "https://github.com/acme/app/pull/12"}
        ],
        "workflow": {
            "feature_flags": {STAGE_ASSIGNEE_FLAG: True},
            "current_stage_id": "quality",
            "assignee_roles": {
                review_role: [
                    {"assignee_type": "user", "assignee_id": s.owner.user_name}
                ]
            },
            "nodes": [
                {"id": "quality", "name": "质量验收", "required_assignee_role": "qa"}
            ],
        },
    }
    if exact_target:
        node = metadata["workflow"]["nodes"][0]
        node.pop("required_assignee_role")
        node.update(required_assignee_type="user", required_assignee_id="initial-qa")
    s.issue.metadata_json = deepcopy(metadata)
    s.db.flush()
    assert validate(s, metadata=metadata) == metadata
    metadata["quality_handoff"]["required_assignee_role"] = "engineering"
    s.issue.metadata_json = deepcopy(metadata)
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata)
    assert error.value.detail["expected_assignee"] == {
        "assignee_type": "role",
        "assignee_id": "engineering",
    }


def test_role_targets_use_only_explicit_fallbacks(stage_scenario):
    s = stage_scenario
    metadata = {
        "workflow": {
            "assignee_roles": {
                "qa": [
                    {"assignee_type": "user", "assignee_id": "missing-user"},
                    {"assignee_type": "user", "assignee_id": str(s.owner.id)},
                ]
            }
        }
    }
    assert resolve_role_assignee(
        s.db, project=s.project, metadata=metadata, role="qa"
    ) == {"assignee_type": "user", "assignee_id": str(s.owner.id)}
    assert (
        resolve_role_assignee(s.db, project=s.project, metadata=metadata, role="ui")
        is None
    )


@pytest.mark.parametrize("target_mode", ["stage", "metadata"])
@pytest.mark.usefixtures("pilot_policy")
def test_manual_quality_entry_requires_a_complete_pr_snapshot(
    stage_scenario, target_mode
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["nodes"].append({"id": "quality", "name": "质量验收"})
    stage_id = "quality" if target_mode == "stage" else None
    if target_mode == "metadata":
        metadata["workflow"]["current_stage_id"] = "quality"

    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata, stage_id=stage_id)

    assert error.value.status_code == 409
    assert error.value.detail == {
        "reason_code": "quality_pr_snapshot_required",
        "issue_version": s.issue.version,
    }
    assert s.issue.metadata_json["workflow"]["current_stage_id"] == "build"
    assert not s.db.new


@pytest.mark.parametrize("handoff_role", [None, "qa"])
@pytest.mark.usefixtures("pilot_policy")
def test_quality_exact_target_takes_precedence_over_the_qa_role_mapping(
    stage_scenario, handoff_role
):
    s = stage_scenario
    url = "https://github.com/acme/app/pull/12"
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["current_stage_id"] = "quality"
    metadata["workflow"]["nodes"] = [
        {
            "id": "quality",
            "name": "质量验收",
            "required_assignee_type": "user",
            "required_assignee_id": s.owner.user_name,
        }
    ]
    metadata["workflow"]["assignee_roles"] = {
        "qa": [{"assignee_type": "user", "assignee_id": "different-qa"}],
    }
    metadata["badges"] = [{"icon": "git-pull-request", "url": url}]
    metadata["quality_handoff"] = {
        "pr_heads": {
            url: {
                "complete": True,
                "head_sha": "head-1",
                "draft": False,
                "state": "OPEN",
                "mergeable": "MERGEABLE",
                "required_checks": [],
            }
        }
    }
    if handoff_role:
        metadata["quality_handoff"]["required_assignee_role"] = handoff_role
    s.issue.metadata_json = deepcopy(metadata)
    s.db.flush()

    assert validate(s) == metadata
    with pytest.raises(HTTPException) as error:
        validate(s, assignee_id="different-qa")
    assert error.value.detail["expected_assignee"] == {
        "assignee_type": "user",
        "assignee_id": str(s.owner.id),
    }
    assert not s.db.new


@pytest.mark.usefixtures("pilot_policy")
def test_manual_quality_entry_uses_the_trusted_observed_head(stage_scenario):
    s = stage_scenario
    url = "https://github.com/acme/app/pull/12"
    metadata = deepcopy(s.issue.metadata_json)
    metadata["workflow"]["nodes"].append({"id": "quality", "name": "质量验收"})
    metadata["workflow"]["assignee_roles"] = {
        "qa": [{"assignee_type": "user", "assignee_id": str(s.owner.id)}]
    }
    metadata["badges"] = [{"icon": "git-pull-request", "url": url}]
    metadata["quality_handoff"] = {
        "pr_heads": {
            url: {
                "complete": True,
                "head_sha": "current-head",
                "draft": False,
                "state": "OPEN",
                "mergeable": "MERGEABLE",
                "required_checks": [
                    {
                        "name": "unit",
                        "conclusion": "SUCCESS",
                        "head_sha": "current-head",
                    }
                ],
            }
        }
    }
    s.issue.metadata_json = deepcopy(metadata)
    s.db.flush()
    metadata["workflow"]["current_stage_id"] = "quality"

    assert validate(s, metadata=metadata) == metadata
    assert s.issue.metadata_json["workflow"]["current_stage_id"] == "build"


@pytest.mark.parametrize(
    "field", ["pr_heads", "required_assignee_role", "resolved_assignee"]
)
def test_request_cannot_replace_server_quality_observations(stage_scenario, field):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["quality_handoff"] = {field: "forged"}

    with pytest.raises(HTTPException) as error:
        validate(s, metadata=metadata)

    assert error.value.status_code == 422
    assert error.value.detail["reason_code"] == "quality_handoff_server_managed"
    assert "quality_handoff" not in s.issue.metadata_json


@pytest.mark.parametrize("source", ["issue_owner", "configured", "pilot"])
@pytest.mark.usefixtures("pilot_policy")
def test_engineering_role_uses_the_same_owner_order_as_quality_events(
    stage_scenario, source
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata["quality_handoff"] = {"required_assignee_role": "engineering"}
    if source == "issue_owner":
        metadata["owner"] = {"eng": s.owner.user_name}
        metadata["workflow"]["assignee_roles"] = {
            "engineering": [{"assignee_type": "user", "assignee_id": "other"}]
        }
    elif source == "configured":
        metadata["workflow"]["assignee_roles"] = {
            "engineering": [{"assignee_type": "user", "assignee_id": s.owner.user_name}]
        }
    else:
        s.owner.user_name = "hongyu9"
    s.issue.metadata_json = deepcopy(metadata)
    s.db.flush()

    assert validate(s) == metadata
    s.owner.is_active = False
    s.db.flush()
    with pytest.raises(HTTPException) as error:
        validate(s)
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
