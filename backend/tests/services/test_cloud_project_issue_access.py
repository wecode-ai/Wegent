# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    IssueAction,
    issue_permissions,
    required_issue_update_actions,
)


def _access(role: BaseRole) -> CloudProjectAccess:
    return CloudProjectAccess(project=SimpleNamespace(), role=role)


def test_issue_permissions_separate_execution_from_governance() -> None:
    developer = issue_permissions(
        _access(BaseRole.Developer),
        issue_creator_user_id=1,
        assignee_user_id=2,
        issue_status="in_progress",
        user_id=2,
    )

    assert developer.edit_content
    assert developer.execute
    assert developer.handoff
    assert developer.submit_review
    assert not developer.assign
    assert not developer.complete
    assert not developer.reopen


def test_reporter_can_comment_without_editing_or_executing() -> None:
    reporter = issue_permissions(
        _access(BaseRole.Reporter),
        issue_creator_user_id=1,
        assignee_user_id=None,
        issue_status="pending",
        user_id=3,
    )

    assert reporter.comment
    assert not reporter.edit_content
    assert not reporter.claim
    assert not reporter.execute


def test_agent_assigned_issue_cannot_be_claimed_as_unassigned() -> None:
    developer = issue_permissions(
        _access(BaseRole.Developer),
        issue_creator_user_id=1,
        assignee_user_id=None,
        has_assignee=True,
        issue_status="pending",
        user_id=2,
    )

    assert not developer.claim


def test_unassigned_issue_can_only_be_self_claimed_by_developer() -> None:
    actions = required_issue_update_actions(
        changed_fields={"assignee_user_id"},
        current_assignee_user_id=None,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="pending",
        requested_assignee_user_id=2,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status=None,
        user_id=2,
    )

    assert actions == {IssueAction.CLAIM}


def test_blank_internal_agent_id_does_not_block_self_claim() -> None:
    actions = required_issue_update_actions(
        changed_fields={"assignee_user_id"},
        current_assignee_user_id=None,
        current_assignee_agent_id="",
        current_assignee_team_id=None,
        current_status="pending",
        requested_assignee_user_id=2,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status=None,
        user_id=2,
    )

    assert actions == {IssueAction.CLAIM}


def test_explicit_empty_assignee_fields_do_not_turn_self_claim_into_assignment() -> (
    None
):
    actions = required_issue_update_actions(
        changed_fields={
            "assignee_user_id",
            "assignee_agent_id",
            "assignee_team_id",
        },
        current_assignee_user_id=None,
        current_assignee_agent_id="",
        current_assignee_team_id=None,
        current_status="pending",
        requested_assignee_user_id=2,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status=None,
        user_id=2,
    )

    assert actions == {IssueAction.CLAIM}


def test_assigning_another_user_requires_project_governance() -> None:
    actions = required_issue_update_actions(
        changed_fields={"assignee_user_id"},
        current_assignee_user_id=None,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="pending",
        requested_assignee_user_id=3,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status=None,
        user_id=2,
    )

    assert actions == {IssueAction.ASSIGN}


def test_assignee_can_handoff_and_submit_for_review() -> None:
    actions = required_issue_update_actions(
        changed_fields={"assignee_user_id", "status"},
        current_assignee_user_id=2,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="in_progress",
        requested_assignee_user_id=3,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status="in_review",
        user_id=2,
    )

    assert actions == {IssueAction.HANDOFF, IssueAction.SUBMIT_REVIEW}


def test_complete_and_reopen_are_distinct_governance_actions() -> None:
    complete = required_issue_update_actions(
        changed_fields={"status"},
        current_assignee_user_id=2,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="in_review",
        requested_assignee_user_id=None,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status="completed",
        user_id=2,
    )
    reopen = required_issue_update_actions(
        changed_fields={"status"},
        current_assignee_user_id=2,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="completed",
        requested_assignee_user_id=None,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status="in_progress",
        user_id=2,
    )

    assert complete == {IssueAction.COMPLETE}
    assert reopen == {IssueAction.REOPEN}


def test_noop_update_requires_no_action() -> None:
    actions = required_issue_update_actions(
        changed_fields={"assignee_user_id", "status"},
        current_assignee_user_id=2,
        current_assignee_agent_id=None,
        current_assignee_team_id=None,
        current_status="in_progress",
        requested_assignee_user_id=2,
        requested_assignee_agent_id=None,
        requested_assignee_team_id=None,
        requested_status="in_progress",
        user_id=2,
    )

    assert actions == set()
