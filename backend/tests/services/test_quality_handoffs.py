"""Quality transitions keep stage, ownership, audit and notices transactional."""

from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    ProjectIncomingEvent,
    ProjectIncomingHook,
)
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.issue_assignments import issue_assignment_service
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_event_polling import EventPollingError, GitHubEventPoller
from app.services.project_event_sources import (
    NormalizedProjectEvent,
    normalize_webhook_events,
    normalized_event_identity,
)
from app.services.project_incoming_hooks import project_incoming_hook_service
from app.services.project_quality_snapshot import collect_quality_snapshot
from app.services.quality_handoffs import process_quality_event, submit_quality_review
from tests.utils.collaboration import authorize_project

PR = "https://github.com/acme/app/pull/12"


@pytest.fixture
def quality_scenario(test_db, test_user):
    project = CloudProject(
        public_id=str(uuid4()),
        project_key=f"QUALITY{uuid4().hex[:6].upper()}",
        name="Quality",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    users = {}
    for role, name in {
        "engineering": "hongyu9",
        "qa": "yunpeng7",
        "product": "jiangyang7",
        "ui": "wenbo17",
        "pmo": "zhongwei9",
    }.items():
        user = User(user_name=name, password_hash="fixture", is_active=True)
        test_db.add(user)
        test_db.flush()
        test_db.add(
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=int(project.id),
                entity_type="user",
                entity_id=str(user.id),
                role="Maintainer",
                status="approved",
            )
        )
        users[role] = user
    workflow = {
        "version": 1,
        "current_stage_id": "build",
        "nodes": [
            {"id": "build", "name": "开发实现"},
            {"id": "quality", "name": "质量验收", "required_assignee_role": "qa"},
            {"id": "release", "name": "发布上线"},
        ],
        "assignee_roles": {
            role: [{"assignee_type": "user", "assignee_id": str(user.id)}]
            for role, user in users.items()
        },
    }
    project.metadata_json = {"workflow_definition": deepcopy(workflow)}
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        title="Quality work",
        status="in_progress",
        created_by_user_id=test_user.id,
        assignee_user_id=users["engineering"].id,
        metadata_json={
            "workflow": workflow,
            "tags": ["开发实现"],
            "badges": [{"icon": "git-pull-request", "url": PR}],
        },
    )
    test_db.add(item)
    test_db.flush()
    return SimpleNamespace(
        db=test_db, project=project, item=item, users=users, actor=test_user
    )


def observation(s, *, head="head-1", event_type="change_request.updated", **changes):
    snapshot = {
        "url": PR,
        "head_sha": head,
        "complete": True,
        "draft": False,
        "state": "OPEN",
        "mergeable": "MERGEABLE",
        "required_checks": [
            {"name": "unit", "conclusion": "SUCCESS", "head_sha": head}
        ],
    }
    snapshot.update(changes)
    return ProjectAutomationEvent(
        event_type=event_type,
        project_id=str(s.project.id),
        subject_id="acme/app#12",
        subject_type="change_request",
        source="github",
        actor_user_id=s.actor.id,
        payload={
            "subject": {"url": PR, "head_commit": head},
            "quality_snapshot": snapshot,
        },
    )


def review(s, role, key, **changes):
    values = {
        "decision": "no_objection",
        "evidence": [f"report:{role}"],
        "idempotency_key": key,
        "pr_head_sha": "head-1",
    }
    values.update(changes)
    return submit_quality_review(
        s.db,
        project=s.project,
        item=s.item,
        user_id=s.users[role].id,
        review=values,
        issue_version=s.item.version,
    )


def test_green_pr_handoff_is_atomic_and_idempotent(quality_scenario):
    s = quality_scenario
    original = deepcopy(s.item.metadata_json)
    assert process_quality_event(s.db, observation(s)) == 1
    s.db.flush()
    assert s.item.status == "in_review"
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"
    assert s.item.metadata_json["tags"] == ["质量验收"]
    assert s.item.assignee_user_id == s.users["qa"].id
    assert original["workflow"]["current_stage_id"] == "build"
    assert (
        s.db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == s.users["qa"].id,
            WeworkNotification.kind == "assignment",
        )
        .count()
        == 1
    )
    before = (
        s.item.version,
        s.db.query(LoopItemComment).count(),
        s.db.query(WeworkNotification).count(),
    )
    assert process_quality_event(s.db, observation(s)) == 0
    s.db.flush()
    assert before == (
        s.item.version,
        s.db.query(LoopItemComment).count(),
        s.db.query(WeworkNotification).count(),
    )


def test_qa_product_ui_review_handoffs_replay_without_side_effects(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    first = review(s, "qa", "qa-approval")
    assert s.item.assignee_user_id == s.users["product"].id
    s.db.flush()
    version = s.item.version
    replay = submit_quality_review(
        s.db,
        project=s.project,
        item=s.item,
        user_id=s.users["qa"].id,
        review={
            "decision": "no_objection",
            "evidence": ["report:qa"],
            "idempotency_key": "qa-approval",
            "pr_head_sha": "head-1",
        },
        issue_version=version - 1,
    )
    assert replay == first
    assert s.item.version == version
    review(s, "product", "product-approval")
    assert s.item.assignee_user_id == s.users["ui"].id
    review(s, "ui", "visual-approval")
    assert s.item.metadata_json["quality_handoff"]["acceptance_complete"] is True
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"


@pytest.mark.parametrize(
    "changes, reason",
    [
        ({"mergeable": "CONFLICTING"}, "pr_merge_conflict"),
        (
            {"required_checks": [{"name": "unit", "conclusion": "FAILURE"}]},
            "pr_checks_failed",
        ),
        (
            {"required_checks": [{"name": "unit", "conclusion": "CANCELLED"}]},
            "pr_checks_failed",
        ),
        (
            {"required_checks": [{"name": "unit", "conclusion": "TIMED_OUT"}]},
            "pr_checks_failed",
        ),
    ],
)
def test_failed_pr_returns_engineering_without_regressing_quality(
    quality_scenario, changes, reason
):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    process_quality_event(s.db, observation(s, head="head-2", **changes))
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["quality_blocked"] is True
    assert handoff["reason_code"] == reason
    s.db.flush()
    notices = s.db.query(WeworkNotification).count()
    process_quality_event(s.db, observation(s, head="head-2", **changes))
    assert s.db.query(WeworkNotification).count() == notices
    process_quality_event(s.db, observation(s, head="head-3"))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"] is False
    # Late events from a superseded head cannot take ownership back.
    process_quality_event(s.db, observation(s, head="head-2", **changes))
    assert s.item.assignee_user_id == s.users["qa"].id


def test_no_qa_permission_waits_without_retaining_engineering(quality_scenario):
    s = quality_scenario
    s.users["qa"].is_active = False
    s.db.flush()
    process_quality_event(s.db, observation(s))
    s.db.flush()
    assert s.item.assignee_user_id is None
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"
    assert s.item.metadata_json["quality_handoff"]["waiting_assignee"] is True
    assert issue_assignment_service.active_for_issue(s.db, s.item.id) == []
    assert s.db.query(WeworkNotification).count() > 0


@pytest.mark.parametrize(
    "changes",
    [
        {"complete": False},
        {"draft": True},
        {"mergeable": "UNKNOWN"},
        {"required_checks": [{"conclusion": "PENDING"}]},
    ],
)
def test_incomplete_draft_unknown_or_pending_never_enters_quality(
    quality_scenario, changes
):
    s = quality_scenario
    process_quality_event(s.db, observation(s, **changes))
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "build"
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert s.db.query(LoopItemComment).count() == 0


def test_new_pending_head_blocks_previous_owner_review(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    version = s.item.version
    notices = s.db.query(WeworkNotification).count()
    process_quality_event(
        s.db, observation(s, head="head-2", required_checks=[{"conclusion": "PENDING"}])
    )
    s.db.flush()
    assert s.item.version == version + 1
    assert s.db.query(WeworkNotification).count() > notices
    assert (
        s.db.query(LoopItemComment)
        .filter(LoopItemComment.description == "Quality handoff: pr_checks_pending")
        .count()
        == 1
    )
    with pytest.raises(HTTPException) as error:
        review(s, "qa", "stale-approval")
    assert error.value.detail["reason_code"] == "quality_blocked"


def test_shared_pr_updates_each_issue_and_multiple_prs_wait_for_all(quality_scenario):
    s = quality_scenario
    second = LoopItem(
        id=f"{s.project.project_key}-2",
        cloud_project_id=str(s.project.id),
        title="Second",
        status="in_progress",
        created_by_user_id=s.actor.id,
        assignee_user_id=s.users["engineering"].id,
        metadata_json=deepcopy(s.item.metadata_json),
    )
    s.db.add(second)
    s.db.flush()
    assert process_quality_event(s.db, observation(s)) == 2
    assert second.assignee_user_id == s.users["qa"].id


def test_multiple_required_prs_wait_until_every_head_is_ready(quality_scenario):
    s = quality_scenario
    second_url = "https://github.com/acme/app/pull/13"
    metadata = deepcopy(s.item.metadata_json)
    metadata["badges"].append({"icon": "git-pull-request", "url": second_url})
    s.item.metadata_json = metadata
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["engineering"].id
    second = observation(s, head="other-head")
    second.payload["subject"]["url"] = second_url
    second.payload["quality_snapshot"]["url"] = second_url
    assert process_quality_event(s.db, second) == 1
    assert s.item.assignee_user_id == s.users["qa"].id, s.item.metadata_json
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {
        PR: "head-1",
        second_url: "other-head",
    }


def test_same_head_pending_then_green_recovers_quality(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    process_quality_event(
        s.db, observation(s, required_checks=[{"conclusion": "PENDING"}])
    )
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"] is True
    process_quality_event(s.db, observation(s))
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"] is False


def test_known_optional_failed_check_does_not_steal_qa_ownership(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    event = observation(s, event_type="change_request.checks_failed", complete=False)
    event.payload["check"] = {"name": "optional-check", "conclusion": "failure"}
    assert process_quality_event(s.db, event) == 0
    assert s.item.assignee_user_id == s.users["qa"].id


@pytest.mark.parametrize(
    "event_type", ["change_request.merge_conflict", "change_request.checks_failed"]
)
def test_complete_current_snapshot_overrides_an_older_head_event(
    quality_scenario, event_type
):
    s = quality_scenario
    event = observation(s, event_type=event_type, head="head-2")
    event.payload["subject"]["head_commit"] = "head-1"
    event.payload["conclusion"] = "FAILURE"
    process_quality_event(s.db, event)
    assert s.item.assignee_user_id == s.users["qa"].id
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"] is False


def test_waiting_qa_recovers_after_access_is_restored(quality_scenario):
    """Active members receive asynchronous work without a device heartbeat."""
    s = quality_scenario
    s.users["qa"].is_active = False
    s.db.flush()
    process_quality_event(s.db, observation(s))
    s.users["qa"].is_active = True
    s.db.flush()
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert s.item.metadata_json["quality_handoff"]["waiting_assignee"] is False


def test_initial_handoff_uses_exact_qa_node_target_without_role_mapping(
    quality_scenario,
):
    s = quality_scenario
    metadata = deepcopy(s.item.metadata_json)
    workflow = metadata["workflow"]
    workflow.pop("assignee_roles")
    workflow["nodes"][1].update(
        {
            "required_assignee_type": "user",
            "required_assignee_id": str(s.users["qa"].id),
        }
    )
    s.item.metadata_json = metadata
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert s.item.metadata_json["quality_handoff"]["waiting_assignee"] is False


@pytest.mark.asyncio
async def test_webhook_cannot_inject_a_complete_quality_snapshot(quality_scenario):
    s = quality_scenario
    hook = ProjectIncomingHook(
        cloud_project_id=str(s.project.id),
        name="Webhook",
        status="active",
        source="github",
        created_by_user_id=s.actor.id,
        metadata_json={
            "source_type": "github",
            "collection_mode": "webhook",
            "resource": {
                "resource_type": "repository",
                "instance_url": "https://github.com",
                "path": "acme/app",
                "external_id": "1",
            },
        },
    )
    s.db.add(hook)
    s.db.flush()
    event = ProjectIncomingEvent(
        parent_id=hook.id,
        cloud_project_id=str(s.project.id),
        status="processing",
        created_by_user_id=s.actor.id,
        metadata_json={
            "collection_mode": "webhook",
            "headers": {"x-github-event": "pull_request"},
            "payload": {
                "quality_snapshot": observation(s).payload["quality_snapshot"],
                "repository": {
                    "id": 1,
                    "full_name": "acme/app",
                    "html_url": "https://github.com/acme/app",
                },
                "pull_request": {
                    "number": 12,
                    "html_url": PR,
                    "mergeable": True,
                    "head": {"sha": "head-1"},
                },
            },
        },
    )
    s.db.add(event)
    s.db.flush()
    await project_incoming_hook_service._process_claimed_event(s.db, event.id)
    assert event.status == "ignored"
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert "quality_handoff" not in s.item.metadata_json


def test_quality_assignment_and_notices_rollback_together(quality_scenario):
    s = quality_scenario
    with s.db.begin_nested() as transaction:
        process_quality_event(s.db, observation(s))
        s.db.flush()
        assert s.db.query(WeworkNotification).count() > 0
        transaction.rollback()
    s.db.refresh(s.item)
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "build"
    assert s.db.query(LoopItemComment).count() == 0
    assert s.db.query(WeworkNotification).count() == 0


def test_other_reviewer_and_conflicting_idempotency_are_rejected(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    with pytest.raises(HTTPException) as error:
        review(s, "product", "wrong-person")
    assert error.value.status_code == 403
    review(s, "qa", "qa-pass")
    with pytest.raises(HTTPException) as error:
        review(s, "qa", "qa-pass", evidence=["different-report"])
    assert error.value.detail["reason_code"] == "quality_review_idempotency_conflict"


def test_flag_disabled_and_other_project_have_no_effect(quality_scenario):
    s = quality_scenario
    metadata = deepcopy(s.item.metadata_json)
    metadata["workflow"]["feature_flags"] = {"collab.enforceStageAssignee.v1": False}
    s.item.metadata_json = metadata
    assert process_quality_event(s.db, observation(s)) == 0
    assert s.item.assignee_user_id == s.users["engineering"].id


def test_project_kill_switch_overrides_an_enabled_issue_snapshot(quality_scenario):
    s = quality_scenario
    issue_metadata = deepcopy(s.item.metadata_json)
    issue_metadata["workflow"]["feature_flags"] = {
        "collab.enforceStageAssignee.v1": True
    }
    s.item.metadata_json = issue_metadata
    metadata = deepcopy(s.project.metadata_json)
    metadata["workflow_definition"]["feature_flags"] = {
        "collab.enforceStageAssignee.v1": False
    }
    s.project.metadata_json = metadata
    assert process_quality_event(s.db, observation(s)) == 0
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert "quality_handoff" not in s.item.metadata_json


def test_tag_only_issue_uses_explicit_project_policy(quality_scenario):
    s = quality_scenario
    metadata = deepcopy(s.item.metadata_json)
    metadata.pop("workflow")
    s.item.metadata_json = metadata
    project_metadata = deepcopy(s.project.metadata_json)
    project_metadata["workflow_definition"].pop("current_stage_id")
    s.project.metadata_json = project_metadata
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"


def test_missing_pmo_notifies_effective_maintainers(quality_scenario):
    s = quality_scenario
    s.users["pmo"].is_active = False
    s.db.flush()
    process_quality_event(s.db, observation(s))
    s.db.flush()
    assert (
        s.db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == s.actor.id,
            WeworkNotification.title == "Issue quality status",
        )
        .count()
        == 1
    )


def test_updated_event_identity_distinguishes_pending_and_green_same_head():
    def event(conclusion):
        return NormalizedProjectEvent(
            event_type="change_request.updated",
            source_type="github",
            resource={},
            subject={"id": "acme/app#12", "head_commit": "same-head"},
            payload={
                "raw_event": "pull_request",
                "quality_snapshot": {
                    "head_sha": "same-head",
                    "required_checks": [{"name": "unit", "conclusion": conclusion}],
                },
            },
        )

    assert normalized_event_identity(event("PENDING")) != normalized_event_identity(
        event("SUCCESS")
    )
    assert normalized_event_identity(event("SUCCESS")) == normalized_event_identity(
        event("SUCCESS")
    )


def test_healthy_open_pr_does_not_reclaim_release_ownership(quality_scenario):
    s = quality_scenario
    metadata = deepcopy(s.item.metadata_json)
    metadata["workflow"]["current_stage_id"] = "release"
    metadata["tags"] = ["发布上线"]
    s.item.metadata_json = metadata
    s.item.assignee_user_id = s.users["product"].id
    s.item.status = "in_review"
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["product"].id
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "release"
    assert s.item.status == "in_review"
    assert s.db.query(LoopItemComment).count() == 0


def test_merge_event_does_not_mark_technical_quality_blocked(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    before = deepcopy(s.item.metadata_json)
    assert (
        process_quality_event(
            s.db, observation(s, event_type="change_request.merged", complete=False)
        )
        == 0
    )
    assert s.item.metadata_json == before
    assert s.item.assignee_user_id == s.users["qa"].id


@pytest.mark.asyncio
async def test_collector_filters_optional_checks_and_binds_complete_snapshot_to_head():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=[])
        assert request.method == "POST"
        return httpx.Response(
            200,
            json={
                "data": {
                    "repository": {
                        "pullRequest": {
                            "url": PR,
                            "headRefOid": "head-1",
                            "isDraft": False,
                            "state": "OPEN",
                            "mergeable": "MERGEABLE",
                            "baseRefName": "main",
                            "baseRef": {"branchProtectionRule": None},
                            "commits": {
                                "nodes": [
                                    {
                                        "commit": {
                                            "oid": "head-1",
                                            "statusCheckRollup": {
                                                "contexts": {
                                                    "pageInfo": {"hasNextPage": False},
                                                    "nodes": [
                                                        {
                                                            "name": "required",
                                                            "isRequired": True,
                                                            "conclusion": "SUCCESS",
                                                        },
                                                        {
                                                            "name": "optional",
                                                            "isRequired": False,
                                                            "conclusion": "FAILURE",
                                                        },
                                                    ],
                                                }
                                            },
                                        }
                                    }
                                ]
                            },
                        }
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await collect_quality_snapshot(
            client,
            api_base="https://api.github.com",
            repository="acme/app",
            number=12,
            headers={},
            repository_payload={
                "id": 1,
                "full_name": "acme/app",
                "html_url": "https://github.com/acme/app",
            },
        )
    snapshot = result.payload["quality_snapshot"]
    assert snapshot["complete"] is True
    assert snapshot["required_checks"] == [
        {
            "name": "required",
            "conclusion": "SUCCESS",
            "status": None,
            "head_sha": "head-1",
        }
    ]
    events = normalize_webhook_events("github", result.payload, result.headers)
    assert events[0].event_type == "change_request.updated"
    assert events[0].payload["quality_snapshot"] == snapshot


def graph_snapshot(*, head="head-1", contexts=None, required=None):
    return {
        "data": {
            "repository": {
                "pullRequest": {
                    "url": PR,
                    "headRefOid": head,
                    "isDraft": False,
                    "state": "OPEN",
                    "mergeable": "MERGEABLE",
                    "baseRefName": "main",
                    "baseRef": {
                        "branchProtectionRule": {"requiredStatusChecks": required or []}
                    },
                    "commits": {
                        "nodes": [
                            {
                                "commit": {
                                    "oid": head,
                                    "statusCheckRollup": (
                                        {
                                            "contexts": contexts,
                                        }
                                        if contexts is not None
                                        else None
                                    ),
                                }
                            }
                        ]
                    },
                }
            }
        }
    }


async def collect_fixture(handler):
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await collect_quality_snapshot(
            client,
            api_base="https://api.github.com",
            repository="acme/app",
            number=12,
            headers={},
            repository_payload={"id": 1, "full_name": "acme/app"},
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("via_rules", [False, True])
async def test_not_yet_reported_required_check_stays_pending(via_rules):
    def handler(request):
        if request.method == "GET":
            return httpx.Response(
                200,
                json=(
                    [
                        {
                            "type": "required_status_checks",
                            "parameters": {
                                "required_status_checks": [
                                    {"context": "missing-check"}
                                ],
                            },
                        }
                    ]
                    if via_rules
                    else []
                ),
            )
        return httpx.Response(
            200,
            json=graph_snapshot(
                required=(
                    [] if via_rules else [{"context": "missing-check", "app": None}]
                ),
                contexts={"nodes": [], "pageInfo": {"hasNextPage": False}},
            ),
        )

    result = await collect_fixture(handler)
    assert (
        result.payload["quality_snapshot"]["required_checks"][0]["conclusion"]
        == "PENDING"
    )


@pytest.mark.asyncio
async def test_unknown_rollup_does_not_hide_a_required_check():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json=[])
        return httpx.Response(
            200, json=graph_snapshot(required=[{"context": "required", "app": None}])
        )

    result = await collect_fixture(handler)
    assert (
        result.payload["quality_snapshot"]["required_checks"][0]["conclusion"]
        == "PENDING"
    )


@pytest.mark.asyncio
async def test_snapshot_rejects_head_change_during_check_pagination():
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json=graph_snapshot(
                head="head-1" if calls == 1 else "head-2",
                contexts={
                    "nodes": [],
                    "pageInfo": {"hasNextPage": True, "endCursor": "next"},
                },
            ),
        )

    with pytest.raises(EventPollingError, match="head changed"):
        await collect_fixture(handler)


@pytest.mark.asyncio
async def test_unknown_branch_rules_fail_closed():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(403, json={"message": "Forbidden"})
        return httpx.Response(
            200,
            json=graph_snapshot(
                contexts={"nodes": [], "pageInfo": {"hasNextPage": False}}
            ),
        )

    with pytest.raises(EventPollingError, match="rules are unavailable"):
        await collect_fixture(handler)


@pytest.mark.asyncio
@pytest.mark.parametrize("health_sweep", [False, True])
@pytest.mark.parametrize(
    "failed_endpoint,status_code", [("graphql", 503), ("rules", 403)]
)
async def test_quality_proof_failure_preserves_conflict_checks_and_comments(
    health_sweep, failed_endpoint, status_code
):
    pull = {
        "number": 12,
        "html_url": PR,
        "state": "open",
        "draft": False,
        "head": {"sha": "head-1"},
        "mergeable": False,
        "mergeable_state": "dirty",
    }

    def handler(request):
        path = request.url.path
        if path == "/graphql":
            if failed_endpoint == "graphql":
                return httpx.Response(status_code)
            return httpx.Response(200, json=graph_snapshot())
        if "/rules/branches/" in path:
            return httpx.Response(status_code)
        if path.endswith("/pulls"):
            return httpx.Response(200, json=[pull])
        if path.endswith("/pulls/12"):
            return httpx.Response(200, json=pull)
        if path.endswith("/check-runs"):
            return httpx.Response(
                200,
                json={
                    "check_runs": [
                        {
                            "id": 7,
                            "status": "completed",
                            "conclusion": "failure",
                            "name": "unit",
                        }
                    ]
                },
            )
        if path.endswith("/issues/12/comments"):
            return httpx.Response(200, json=[{"id": 8, "body": "Comment retained"}])
        if path.endswith("/reviews") or path.endswith("/comments"):
            return httpx.Response(200, json=[])
        raise AssertionError(f"Unexpected request: {request.url}")

    poller = GitHubEventPoller()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        kwargs = dict(
            client=client,
            api_base="https://api.github.com",
            repository="acme/app",
            headers={},
        )
        if health_sweep:
            changes = await poller._open_pull_health_sweep_inputs(
                **kwargs, seen_numbers=set()
            )
        else:
            changes = await poller._pull_inputs(**kwargs, pull=pull, cutoff=None)
    identities = {change.identity for change in changes}
    assert "pull_request:12:conflict:head-1" in identities
    assert "check_run:7:failure:head-1" in identities
    if not health_sweep:
        assert "issue_comment:8" in identities
    snapshots = [
        value.payload["quality_snapshot"]
        for value in changes
        if "quality_snapshot" in value.payload
    ]
    assert snapshots
    assert all(value["complete"] is False for value in snapshots)
    assert all(
        value["reason_code"] == "quality_observation_unavailable" for value in snapshots
    )
