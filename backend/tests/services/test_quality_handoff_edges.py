"""Quality observations preserve complete evidence and unresolved rejections."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, ProjectIncomingEvent, ProjectIncomingHook
from app.models.wework_notification import WeworkNotification
from app.services.project_event_polling import PolledInput
from app.services.project_event_polling_service import project_event_polling_service
from app.services.project_quality_snapshot import observe_quality_snapshot
from app.services.quality_handoffs import (
    process_quality_event,
    require_quality_snapshot,
)
from app.services.stage_assignees import validate_stage_assignee
from tests.services.test_quality_handoffs import (  # noqa: F401
    PR,
    graph_snapshot,
    observation,
    quality_scenario,
    review,
)

OTHER_PR = "https://github.com/acme/app/pull/13"
ENTERPRISE_PR = "https://github.example.com/acme/app/pull/12"


def _link(s, url):
    metadata = deepcopy(s.item.metadata_json)
    metadata["badges"].append({"icon": "git-pull-request", "url": url})
    s.item.metadata_json = metadata


def _event(s, *, url=PR, **changes):
    event = observation(s, **changes)
    event.payload["subject"]["url"] = url
    event.payload["quality_snapshot"]["url"] = url
    return event


def _counts(s):
    s.db.flush()
    return s.item.version, s.db.query(WeworkNotification).count()


def _persist_observation(s, hook, event):
    snapshot = event.payload["quality_snapshot"]
    return project_event_polling_service._persist_page(
        s.db,
        hook_id=hook.id,
        source_type="github",
        inputs=(
            PolledInput(
                identity=f"pull_request:12:quality:{snapshot['head_sha']}:{snapshot['observed_at']}",
                title="Quality evidence",
                payload={"quality_snapshot": snapshot},
                headers={},
            ),
        ),
        next_cursor={},
    )


def _complete(s):
    process_quality_event(s.db, observation(s))
    for role in ("qa", "product", "ui"):
        review(s, role, f"{role}-accepted")
    assert s.item.metadata_json["quality_handoff"]["acceptance_complete"]


def test_first_failed_pr_assigns_engineering_when_another_pr_has_no_snapshot(
    quality_scenario,
):
    s = quality_scenario
    _link(s, OTHER_PR)
    process_quality_event(
        s.db,
        observation(s, required_checks=[{"name": "unit", "conclusion": "FAILURE"}]),
    )
    assert s.item.assignee_user_id == s.users["engineering"].id

    assert s.item.metadata_json["workflow"]["current_stage_id"] == "build"
    assert s.item.metadata_json["quality_handoff"]["reason_code"] == "pr_checks_failed"


def test_manual_quality_entry_waits_for_each_unverified_linked_pr(quality_scenario):
    s = quality_scenario
    _link(s, OTHER_PR)
    process_quality_event(
        s.db,
        observation(s, head_verified=True, observed_at="2026-11-17T12:00:10Z"),
    )
    process_quality_event(
        s.db,
        observation(
            s,
            head="head-2",
            complete=False,
            head_verified=False,
            observed_at="2026-11-17T12:00:12Z",
        ),
    )
    process_quality_event(
        s.db,
        _event(
            s,
            url=OTHER_PR,
            head="other-head",
            head_verified=True,
            observed_at="2026-11-17T12:00:13Z",
        ),
    )
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "build"
    assert not s.item.metadata_json["quality_handoff"]["quality_blocked"]
    with pytest.raises(HTTPException) as error:
        require_quality_snapshot(
            s.item, s.item.metadata_json, db=s.db, project=s.project
        )
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"
    old_uncertainty = deepcopy(
        s.item.metadata_json["quality_handoff"]["unverified_pr_observations"]
    )
    process_quality_event(
        s.db,
        observation(
            s, head="head-2", head_verified=True, observed_at="2026-11-17T12:00:14Z"
        ),
    )
    require_quality_snapshot(s.item, s.item.metadata_json, db=s.db, project=s.project)
    metadata = deepcopy(s.item.metadata_json)
    metadata["quality_handoff"]["unverified_pr_observations"] = old_uncertainty
    require_quality_snapshot(s.item, metadata, db=s.db, project=s.project)


def test_older_trusted_proof_cannot_clear_newer_head_uncertainty(quality_scenario):
    s = quality_scenario
    process_quality_event(
        s.db, observation(s, head_verified=True, observed_at="2026-11-17T12:00:10Z")
    )
    process_quality_event(
        s.db,
        observation(
            s,
            head="head-2",
            complete=False,
            head_verified=False,
            observed_at="2026-11-17T12:00:12Z",
        ),
    )
    before = _counts(s)
    assert (
        process_quality_event(
            s.db, observation(s, head_verified=True, observed_at="2026-11-17T12:00:11Z")
        )
        == 0
    )
    assert _counts(s) == before
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"]
    assert s.item.assignee_user_id == s.users["engineering"].id
    process_quality_event(
        s.db,
        observation(
            s, head="head-2", head_verified=True, observed_at="2026-11-17T12:00:13Z"
        ),
    )
    assert s.item.assignee_user_id == s.users["qa"].id
    assert not s.item.metadata_json["quality_handoff"]["quality_blocked"]


@pytest.mark.parametrize(
    "latest",
    ["new_head", "unverified_other_head", "unverified_same_head", "same_head_failed"],
)
def test_quality_review_checks_newer_persisted_collector_evidence(
    quality_scenario, latest
):
    s = quality_scenario
    first = observation(s, head_verified=True, observed_at="2026-11-17T12:00:10Z")
    process_quality_event(s.db, first)
    hook = _watermark_hook(s)
    metadata = deepcopy(hook.metadata_json)
    metadata["poll"] = {}
    hook.metadata_json = metadata
    s.db.commit()

    def persist(event):
        return _persist_observation(s, hook, event)

    persist(first)
    changes = {
        "head_verified": latest in {"new_head", "same_head_failed"},
        "complete": latest in {"new_head", "same_head_failed"},
        "observed_at": "2026-11-17T12:00:12Z",
    }
    if latest == "same_head_failed":
        changes["required_checks"] = [
            {"name": "unit", "conclusion": "FAILURE", "head_sha": "head-1"}
        ]
    claimed_head = (
        "head-1" if latest in {"unverified_same_head", "same_head_failed"} else "head-2"
    )
    latest_event = observation(s, head=claimed_head, **changes)
    persist(latest_event)
    before = _counts(s)
    previous = deepcopy(s.item.metadata_json)
    with pytest.raises(HTTPException) as error:
        review(s, "qa", "stale-collector-approval")
    assert error.value.detail["reason_code"] == "quality_review_head_mismatch"
    assert _counts(s) == before
    assert s.item.metadata_json == previous
    assert s.item.assignee_user_id == s.users["qa"].id
    with pytest.raises(HTTPException) as error:
        require_quality_snapshot(
            s.item, s.item.metadata_json, db=s.db, project=s.project
        )
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"
    with pytest.raises(HTTPException) as error:
        validate_stage_assignee(
            s.db,
            project=s.project,
            item=s.item,
            assignee_type="user",
            assignee_id=str(s.users["qa"].id),
            stage_id="quality",
        )
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"
    assert _counts(s) == before
    assert process_quality_event(s.db, latest_event) == 1
    recovery = observation(
        s, head="head-2", head_verified=True, observed_at="2026-11-17T12:00:13Z"
    )
    process_quality_event(s.db, recovery)
    assert s.item.assignee_user_id == s.users["qa"].id
    result = review(s, "qa", "current-collector-approval", pr_head_sha="head-2")
    assert result["next_role"] == "product"
    assert review(s, "qa", "current-collector-approval", pr_head_sha="head-2") == result


def test_review_rejects_a_higher_source_sequence_at_the_same_collection_time(
    quality_scenario,
):
    s = quality_scenario
    hook = _watermark_hook(s)
    metadata = deepcopy(hook.metadata_json)
    metadata["poll"] = {}
    hook.metadata_json = metadata
    s.db.commit()
    first = observation(s, head_verified=True, observed_at="2026-11-17T12:00:10Z")
    _persist_observation(s, hook, first)
    first.payload["quality_snapshot"] = deepcopy(
        s.db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.parent_id == hook.id)
        .one()
        .metadata_json["payload"]["quality_snapshot"]
    )
    assert first.payload["quality_snapshot"]["observation_sequence"] == 1
    process_quality_event(s.db, first)
    failed = observation(
        s,
        head_verified=True,
        observed_at="2026-11-17T12:00:10Z",
        required_checks=[
            {"name": "unit", "conclusion": "FAILURE", "head_sha": "head-1"}
        ],
    )
    _persist_observation(s, hook, failed)
    state = hook.metadata_json["poll"]["quality_observations"][PR]
    assert state["sequence"] == 2
    assert state["observation_source"] == str(hook.id)
    before = _counts(s)
    with pytest.raises(HTTPException) as error:
        review(s, "qa", "same-clock-stale-approval")
    assert error.value.detail["reason_code"] == "quality_review_head_mismatch"
    assert _counts(s) == before
    with pytest.raises(HTTPException) as error:
        require_quality_snapshot(
            s.item, s.item.metadata_json, db=s.db, project=s.project
        )
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"


@pytest.mark.parametrize("role", ["product", "ui", "engineering"])
def test_invalid_initial_quality_role_waits_instead_of_skipping_qa(
    quality_scenario, role
):
    s = quality_scenario
    metadata = deepcopy(s.item.metadata_json)
    metadata["workflow"]["nodes"][1]["required_assignee_role"] = role
    s.item.metadata_json = metadata
    process_quality_event(s.db, observation(s))
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["required_assignee_role"] == "qa"
    assert handoff["waiting_assignee"] is True
    assert handoff["quality_blocked"] is True
    assert handoff["reason_code"] == "quality_initial_role_invalid"
    assert s.item.assignee_user_id is None
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "quality"


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"required_checks": [{"name": "unit", "conclusion": "PENDING"}]},
        {"required_checks": [{"name": "unit", "conclusion": "FAILURE"}]},
    ],
)
def test_new_head_or_block_invalidates_completed_acceptance(quality_scenario, changes):
    s = quality_scenario
    _complete(s)
    process_quality_event(s.db, observation(s, head="head-2", **changes))
    assert s.item.metadata_json["quality_handoff"]["acceptance_complete"] is False


@pytest.mark.parametrize("conclusion", ["PENDING", "FAILURE"])
def test_same_head_block_invalidates_completed_acceptance(quality_scenario, conclusion):
    s = quality_scenario
    _complete(s)
    process_quality_event(
        s.db,
        observation(s, required_checks=[{"name": "unit", "conclusion": conclusion}]),
    )
    assert s.item.metadata_json["quality_handoff"]["acceptance_complete"] is False


def test_new_required_pr_invalidates_acceptance_on_an_unchanged_observation(
    quality_scenario,
):
    s = quality_scenario
    _complete(s)
    _link(s, OTHER_PR)
    assert process_quality_event(s.db, observation(s)) == 1
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["acceptance_complete"] is False
    assert handoff["quality_blocked"] is True
    assert handoff["reason_code"] == "pr_checks_pending"


def test_enterprise_pr_is_required_by_automatic_and_manual_quality_gates(
    quality_scenario,
):
    s = quality_scenario
    _link(s, ENTERPRISE_PR)
    process_quality_event(s.db, observation(s))
    assert s.item.metadata_json["workflow"]["current_stage_id"] == "build"
    with pytest.raises(HTTPException) as error:
        require_quality_snapshot(
            s.item, s.item.metadata_json, db=s.db, project=s.project
        )
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"
    process_quality_event(s.db, _event(s, url=ENTERPRISE_PR, head="enterprise-head"))
    assert s.item.assignee_user_id == s.users["qa"].id
    result = review(s, "qa", "both-hosts-accepted")
    assert result["pr_heads"] == {PR: "head-1", ENTERPRISE_PR: "enterprise-head"}


def test_removing_a_pr_reconciles_before_an_unchanged_remaining_observation(
    quality_scenario,
):
    s = quality_scenario
    _link(s, OTHER_PR)
    process_quality_event(s.db, observation(s))
    process_quality_event(s.db, _event(s, url=OTHER_PR, head="other-head"))
    review(s, "qa", "qa-both-prs")
    before = _counts(s)
    metadata = deepcopy(s.item.metadata_json)
    metadata["badges"] = [
        badge for badge in metadata["badges"] if badge["url"] != OTHER_PR
    ]
    s.item.metadata_json = metadata

    assert process_quality_event(s.db, observation(s)) == 1
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {PR: "head-1"}
    assert s.item.assignee_user_id == s.users["product"].id
    assert _counts(s) == (before[0] + 1, before[1])
    result = review(s, "product", "product-remaining-pr")
    assert result["pr_heads"] == {PR: "head-1"}


@pytest.mark.parametrize("change", ["reorder", "duplicate", "new_run"])
def test_same_head_check_changes_preserve_reviewer_rejection(quality_scenario, change):
    s = quality_scenario
    checks = [
        {"name": "unit", "conclusion": "SUCCESS", "head_sha": "head-1"},
        {"name": "integration", "conclusion": "SUCCESS", "head_sha": "head-1"},
    ]
    process_quality_event(s.db, observation(s, required_checks=checks))
    review(s, "qa", "qa-rejection", decision="changes_requested")
    before = _counts(s)
    updated = list(reversed(checks))
    if change in {"duplicate", "new_run"}:
        updated.append({**checks[0], **({"id": 2} if change == "new_run" else {})})
    process_quality_event(s.db, observation(s, required_checks=updated))
    assert s.item.assignee_user_id == s.users["engineering"].id
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["quality_blocked"] is True
    assert handoff["review_blocked_heads"] == {PR: "head-1"}
    assert _counts(s)[1] == before[1]
    process_quality_event(s.db, observation(s, head="head-2"))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert not s.item.metadata_json["quality_handoff"]["quality_blocked"]


def test_failed_checks_need_a_new_green_head_before_returning_to_qa(quality_scenario):
    s = quality_scenario
    process_quality_event(s.db, observation(s))
    process_quality_event(
        s.db,
        observation(s, required_checks=[{"name": "unit", "conclusion": "FAILURE"}]),
    )
    process_quality_event(s.db, observation(s))
    assert s.item.assignee_user_id == s.users["engineering"].id
    assert s.item.metadata_json["quality_handoff"]["quality_blocked"]
    process_quality_event(s.db, observation(s, head="head-2"))
    assert s.item.assignee_user_id == s.users["qa"].id
    assert not s.item.metadata_json["quality_handoff"]["quality_blocked"]


@pytest.mark.parametrize("source", ["same", "different", "unknown"])
def test_late_unseen_head_cannot_replace_a_newer_trusted_observation(
    quality_scenario, source
):
    s = quality_scenario
    process_quality_event(
        s.db,
        observation(
            s,
            head="head-2",
            observed_at="2026-11-17T12:00:02Z",
            observation_source="collector-one",
            observation_sequence=2,
        ),
    )
    before = _counts(s)
    old = observation(
        s,
        head="unseen-head-1",
        required_checks=[{"name": "unit", "conclusion": "FAILURE"}],
    )
    if source != "unknown":
        old.payload["quality_snapshot"].update(
            observed_at="2026-11-17T12:00:01Z",
            observation_source="collector-one" if source == "same" else "collector-two",
            observation_sequence=1,
        )
    assert process_quality_event(s.db, old) == 0
    assert _counts(s) == before
    assert (
        s.item.metadata_json["quality_handoff"]["pr_heads"][PR]["head_sha"] == "head-2"
    )


def test_a_newer_trusted_force_push_can_restore_a_previously_seen_sha(quality_scenario):
    s = quality_scenario
    for sequence, head in enumerate(["head-1", "head-2", "head-1"], start=1):
        process_quality_event(
            s.db,
            observation(
                s,
                head=head,
                observed_at=f"2026-11-17T12:00:0{sequence}Z",
                observation_source="collector-one",
                observation_sequence=sequence,
            ),
        )
    assert (
        s.item.metadata_json["quality_handoff"]["pr_heads"][PR]["head_sha"] == "head-1"
    )
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {PR: "head-1"}


def _watermark_hook(s, *, mode="poll", url=PR):
    hook = ProjectIncomingHook(
        cloud_project_id=str(s.project.id),
        name="Quality watermark",
        source="github",
        status="active",
        created_by_user_id=s.actor.id,
        metadata_json={
            "source_type": "github",
            "collection_mode": mode,
            "resource": {
                "resource_type": "repository",
                "instance_url": "https://github.com",
                "path": "acme/app",
            },
            "poll": {
                "quality_observations": {
                    url: {
                        "head_sha": "head-1",
                        "observed_at": "2026-11-17T12:00:12Z",
                        "head_verified": True,
                    }
                }
            },
        },
    )
    s.db.add(hook)
    s.db.flush()
    return hook


@pytest.mark.parametrize("mode", ["poll", "hybrid"])
def test_deduplicated_poll_watermark_rejects_an_older_other_source_head(
    quality_scenario, mode
):
    s = quality_scenario
    hook = _watermark_hook(s, mode=mode)
    first = observation(
        s,
        head_verified=True,
        observed_at="2026-11-17T12:00:10Z",
        observation_source=str(hook.id),
        observation_sequence=1,
    )
    polled = PolledInput(
        identity="pull_request:12:quality:head-1:green",
        title="Current quality",
        payload={"quality_snapshot": first.payload["quality_snapshot"]},
        headers={},
    )
    # Persist the real subscription state and deduplicated event together.
    metadata = deepcopy(hook.metadata_json)
    metadata["poll"] = {}
    hook.metadata_json = metadata
    s.db.commit()
    assert (
        project_event_polling_service._persist_page(
            s.db,
            hook_id=hook.id,
            source_type="github",
            inputs=(polled,),
            next_cursor={},
        )
        == 1
    )
    assert process_quality_event(s.db, first) == 1
    polled.payload["quality_snapshot"]["observed_at"] = "2026-11-17T12:00:12Z"
    assert (
        project_event_polling_service._persist_page(
            s.db,
            hook_id=hook.id,
            source_type="github",
            inputs=(polled,),
            next_cursor={},
        )
        == 0
    )
    assert s.db.query(ProjectIncomingEvent).count() == 1
    assert hook.metadata_json["poll"]["quality_observations"][PR]["observed_at"] == (
        "2026-11-17T12:00:12Z"
    )
    assert review(s, "qa", "identical-collector-proof")["next_role"] == "product"
    before = _counts(s)
    assert (
        process_quality_event(
            s.db,
            observation(
                s,
                head="head-2",
                observed_at="2026-11-17T12:00:11Z",
                observation_source="other-collector",
                observation_sequence=1,
            ),
        )
        == 0
    )
    assert _counts(s) == before
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {PR: "head-1"}
    assert (
        process_quality_event(
            s.db,
            observation(
                s,
                head="head-2",
                observed_at="2026-11-17T12:00:13Z",
                observation_source="other-collector",
                observation_sequence=2,
            ),
        )
        == 1
    )
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {PR: "head-2"}


@pytest.mark.asyncio
@pytest.mark.parametrize("same_head_partial", [False, True])
async def test_fallback_rest_head_cannot_replace_verified_head_after_graphql_race(
    quality_scenario, same_head_partial
):
    s = quality_scenario
    observed_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    for offset, head in enumerate(["head-1", "head-2"]):
        process_quality_event(
            s.db,
            observation(
                s,
                head=head,
                head_verified=True,
                observed_at=(observed_at + timedelta(seconds=offset)).isoformat(),
            ),
        )
    if same_head_partial:
        process_quality_event(
            s.db,
            observation(
                s,
                head="head-2",
                head_verified=False,
                complete=False,
                observed_at=(observed_at + timedelta(seconds=2)).isoformat(),
            ),
        )
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

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        polled = await observe_quality_snapshot(
            client,
            api_base="https://api.github.com",
            repository="acme/app",
            number=12,
            headers={},
            repository_payload={"full_name": "acme/app"},
            pull={"html_url": PR, "head": {"sha": "head-1"}},
        )
    snapshot = polled.payload["quality_snapshot"]
    assert snapshot["head_verified"] is False
    assert "head changed" in snapshot["observation_error"]
    event = observation(s, head="head-1", **snapshot)
    assert process_quality_event(s.db, event) == 1
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["pr_heads"][PR]["head_sha"] == "head-2"
    assert "head-2" not in handoff["pr_heads"][PR]["superseded_heads"]
    assert handoff["accepted_heads"] == {PR: "head-2"}
    assert handoff["quality_blocked"]
    assert handoff["reason_code"] == "quality_observation_unavailable"
    assert s.item.assignee_user_id == s.users["engineering"].id
    before = _counts(s)
    assert process_quality_event(s.db, event) == 0
    assert _counts(s) == before
    with pytest.raises(HTTPException) as error:
        review(s, "qa", "cannot-approve-unknown-head", pr_head_sha="head-2")
    assert error.value.detail["reason_code"] == "quality_blocked"
    process_quality_event(
        s.db,
        observation(
            s,
            head="head-2",
            head_verified=True,
            observed_at=(datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat(),
        ),
    )
    assert s.item.assignee_user_id == s.users["qa"].id
    assert not s.item.metadata_json["quality_handoff"]["quality_blocked"]


@pytest.mark.parametrize(
    "event_type,changes,reason",
    [
        (
            "change_request.checks_failed",
            {"required_checks": [{"name": "unit", "conclusion": "FAILURE"}]},
            "pr_checks_failed",
        ),
        (
            "change_request.merge_conflict",
            {"mergeable": "CONFLICTING"},
            "pr_merge_conflict",
        ),
    ],
)
def test_unverified_different_head_still_blocks_and_assigns_engineering(
    quality_scenario, event_type, changes, reason
):
    s = quality_scenario
    process_quality_event(
        s.db, observation(s, head_verified=True, observed_at="2026-11-17T12:00:10Z")
    )
    process_quality_event(
        s.db,
        observation(
            s,
            head="unknown-head",
            head_verified=False,
            complete=False,
            observed_at="2026-11-17T12:00:11Z",
            event_type=event_type,
            **changes,
        ),
    )
    handoff = s.item.metadata_json["quality_handoff"]
    assert handoff["pr_heads"][PR]["head_sha"] == "head-1"
    assert handoff["accepted_heads"] == {PR: "head-1"}
    assert handoff["reason_code"] == reason
    assert handoff["quality_blocked"]
    assert s.item.assignee_user_id == s.users["engineering"].id


@pytest.mark.parametrize(
    "unrelated", ["project", "repository", "mode", "inactive", "url"]
)
def test_unrelated_subscription_watermarks_do_not_block_current_observations(
    quality_scenario, unrelated
):
    s = quality_scenario
    hook = _watermark_hook(s, url=OTHER_PR if unrelated == "url" else PR)
    metadata = deepcopy(hook.metadata_json)
    if unrelated == "project":
        project = CloudProject(
            project_key="OTHERWATERMARK",
            name="Other watermark project",
            created_by_user_id=s.actor.id,
        )
        s.db.add(project)
        s.db.flush()
        hook.cloud_project_id = str(project.id)
    elif unrelated == "repository":
        metadata["resource"]["path"] = "other/repository"
    elif unrelated == "mode":
        metadata["collection_mode"] = "webhook"
    elif unrelated == "inactive":
        hook.status = "disabled"
    hook.metadata_json = metadata
    assert (
        process_quality_event(
            s.db, observation(s, head="head-2", observed_at="2026-11-17T12:00:11Z")
        )
        == 1
    )
    assert s.item.metadata_json["quality_handoff"]["accepted_heads"] == {PR: "head-2"}
