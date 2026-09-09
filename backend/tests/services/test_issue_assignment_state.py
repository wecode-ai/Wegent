from copy import deepcopy

import pytest

from app.schemas.issue_assignment import IssueAssignmentDecision
from app.services.issue_assignment_errors import IssueAssignmentConflict
from app.services.issue_assignment_state import decide_assignment, finish_assignment


@pytest.fixture
def experience():
    return {
        "advancement_policy": "ai",
        "orchestration_status": "planning",
        "initial_stage_id": "design",
        "intent": "Ship an accessible checkout",
        "nodes": [
            {
                "id": "design",
                "status": "blocked",
                "execution_mode": "robot",
                "depends_on": [],
            },
            {
                "id": "develop",
                "status": "blocked",
                "execution_mode": "robot",
                "depends_on": ["design"],
            },
            {
                "id": "release",
                "status": "blocked",
                "execution_mode": "robot",
                "depends_on": ["develop"],
            },
        ],
    }


def assign(version=0, request_id="first", **overrides):
    return IssueAssignmentDecision(
        **{
            "request_id": request_id,
            "expected_assignment_version": version,
            "action": "assign_role",
            "node_id": "release",
            "instruction": "Deploy the approved checkout",
            "reason": "Design and implementation already exist",
            **overrides,
        }
    )


def test_skip_then_return_to_development_preserves_goal_and_reference_graph(experience):
    original = deepcopy(experience)
    released = decide_assignment(experience, assign())
    assert released["current_stage_id"] == "release"
    assert released["nodes"][0]["status"] == "blocked"
    done = finish_assignment(released, "first", "Found a checkout defect")
    returned = decide_assignment(done, assign(1, "second", node_id="develop"))
    assert returned["current_stage_id"] == "develop"
    assert returned["initial_stage_id"] == "design"
    assert returned["intent"] == original["intent"]
    assert experience == original
    assert returned["nodes"][2]["status"] == "completed"


def test_completion_depends_on_issue_requirements_not_all_nodes(experience):
    result = decide_assignment(
        experience, assign(action="complete", node_id=None, instruction="")
    )
    assert result["orchestration_status"] == "completed"
    assert all(node["status"] == "blocked" for node in result["nodes"])


def test_human_assignment_outside_graph_waits_for_result(experience):
    result = decide_assignment(
        experience, assign(action="assign_user", node_id=None, assignee_user_id=7)
    )
    assert result["current_stage_id"] is None
    assert result["orchestration_status"] == "waiting_human"
    with pytest.raises(ValueError, match="assigned person"):
        decide_assignment(result, assign(1, "second"))
    resumed = finish_assignment(result, "first", "Release approved")
    assert resumed["orchestration_status"] == "planning"


def test_human_role_resolves_member(experience):
    experience["nodes"][2].update(execution_mode="human", assignee_user_id=7)
    result = decide_assignment(experience, assign())
    assert result["assignment"]["assignee_user_id"] == 7


def test_duplicate_assignment_is_idempotent_but_reused_id_is_rejected(experience):
    result = decide_assignment(experience, assign())
    assert decide_assignment(result, assign()) is result
    with pytest.raises(ValueError, match="reused"):
        decide_assignment(result, assign(node_id="develop"))


def test_stale_decision_and_result_cannot_override_current_assignment(experience):
    done = finish_assignment(
        decide_assignment(experience, assign()), "first", "Needs rework"
    )
    with pytest.raises(ValueError, match="changed"):
        decide_assignment(done, assign(0, "second"))
    current = decide_assignment(done, assign(1, "second", node_id="develop"))
    with pytest.raises(ValueError, match="earlier"):
        finish_assignment(current, "first", "Late release result")


def test_execute_without_graph(experience):
    experience["nodes"] = []
    result = decide_assignment(experience, assign(action="execute", node_id=None))
    assert result["assignment"]["status"] == "dispatching"
    assert result["nodes"] == []


@pytest.mark.parametrize("wrong_version", [13, 14, 15])
def test_workflow_version_is_not_the_assignment_version(experience, wrong_version):
    experience.update(version=13, assignment_version=1)
    original = deepcopy(experience)
    with pytest.raises(IssueAssignmentConflict) as caught:
        decide_assignment(experience, assign(wrong_version))
    assert caught.value.detail == {
        "code": "assignment_version_conflict",
        "message": (
            "The Issue assignment changed. Read get_board_item again and reconsider "
            "the decision using workflow.assignment_version; never guess or increment versions."
        ),
        "next_action": "read_issue",
        "expected_assignment_version": wrong_version,
        "current_assignment_version": 1,
    }
    assert experience == original
    result = decide_assignment(experience, assign(experience["assignment_version"]))
    assert result["assignment_version"] == 2


@pytest.mark.parametrize(
    "status,code",
    [
        ("paused", "automation_paused"),
        ("completed", "automation_completed"),
        ("waiting_human", "waiting_human"),
    ],
)
def test_inactive_state_requires_ending_turn_instead_of_version_retries(
    experience, status, code
):
    experience.update(orchestration_status=status, assignment_version=1)
    with pytest.raises(IssueAssignmentConflict) as caught:
        decide_assignment(experience, assign(13))
    assert caught.value.detail["code"] == code
    assert caught.value.detail["next_action"] == "end_turn"
    assert "current_assignment_version" not in caught.value.detail


def test_running_assignment_requires_callback(experience):
    running = decide_assignment(experience, assign())
    with pytest.raises(IssueAssignmentConflict) as caught:
        decide_assignment(running, assign(1, "second"))
    assert caught.value.detail["code"] == "assignment_running"
    assert caught.value.detail["next_action"] == "end_turn"


def test_ambiguous_version_field_is_rejected():
    from pydantic import ValidationError

    payload = assign().model_dump()
    payload["expected_version"] = payload.pop("expected_assignment_version")
    with pytest.raises(ValidationError) as caught:
        IssueAssignmentDecision.model_validate(payload)
    assert {error["loc"] for error in caught.value.errors()} == {
        ("expected_version",),
        ("expected_assignment_version",),
    }


def test_unknown_role_rejected(experience):
    with pytest.raises(ValueError, match="not in"):
        decide_assignment(experience, assign(node_id="unknown"))


def test_paused_result_is_retained_without_advancing():
    workflow = {
        "advancement_policy": "ai",
        "orchestration_status": "paused",
        "current_stage_id": "release",
        "nodes": [{"id": "release", "status": "running"}],
        "assignment": {"id": "work", "status": "running", "node_id": "release"},
    }
    result = finish_assignment(workflow, "work", "Deployment verified")
    assert result["orchestration_status"] == "paused"
    assert result["assignment"]["result"] == "Deployment verified"
    assert result["nodes"][0]["status"] == "completed"
