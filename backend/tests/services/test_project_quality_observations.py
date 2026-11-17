# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Provider evidence survives recurrence and remains isolated to its own PR."""

import json
from copy import deepcopy
from dataclasses import replace

import httpx
import pytest
from sqlalchemy.orm import Session

from app.models.delivery import ProjectIncomingEvent
from app.services.project_event_polling import GitHubEventPoller
from app.services.project_event_polling_service import project_event_polling_service
from app.services.project_event_sources import (
    normalize_webhook_events,
    normalized_event_identity,
)
from app.services.project_quality_observations import prepare_quality_inputs
from app.services.project_quality_snapshot import (
    _quality_input,
    observe_quality_snapshot,
)
from tests.services.test_project_event_polling import _project, _subscription
from tests.services.test_quality_handoffs import graph_snapshot

PR = "https://github.com/acme/app/pull/12"


def _input(conclusion, *, instant="2026-11-17T13:00:00+00:00"):
    return _quality_input(
        12,
        {"id": 1, "full_name": "acme/app", "html_url": "https://github.com/acme/app"},
        {
            "complete": True,
            "url": PR,
            "head_sha": "head-1",
            "draft": False,
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "required_checks": [{"name": "required", "conclusion": conclusion}],
            "observed_at": instant,
        },
    )


def test_polling_persists_returning_state_and_deduplicates_consecutive_replays(
    test_db, test_user
):
    project = _project(test_db, test_user)
    hook = _subscription(test_db, test_user, project)
    created = []
    for conclusion in ("SUCCESS", "SUCCESS", "FAILURE", "SUCCESS", "SUCCESS"):
        created.append(
            project_event_polling_service._persist_page(
                test_db,
                hook_id=hook.id,
                source_type="github",
                inputs=(_input(conclusion),),
                next_cursor={},
            )
        )
    assert created == [1, 0, 1, 1, 0]
    assert hook.metadata_json["poll"]["quality_observations"][PR][
        "observation_source"
    ] == str(hook.id)
    rows = sorted(
        test_db.query(ProjectIncomingEvent).all(),
        key=lambda row: row.metadata_json["payload"]["quality_snapshot"][
            "observation_sequence"
        ],
    )
    assert len(rows) == 3
    identities = set()
    for sequence, row in enumerate(rows, 1):
        metadata = row.metadata_json
        snapshot = metadata["payload"]["quality_snapshot"]
        assert snapshot["observation_sequence"] == sequence
        assert snapshot["required_checks"][0]["conclusion"] == (
            "FAILURE" if sequence == 2 else "SUCCESS"
        )
        assert snapshot["observation_source"] == str(hook.id)
        normalized = normalize_webhook_events(
            "github", metadata["payload"], metadata["headers"]
        )
        identities.add(normalized_event_identity(normalized[0]))
    assert len(identities) == 3


def test_one_page_retains_each_state_transition_and_enriches_one_sequence():
    first = _input("SUCCESS")
    failure = _input("FAILURE")
    conflict = replace(first, identity="pull_request:12:conflict:head-1")
    result = prepare_quality_inputs((conflict, first, failure, first), {}, "hook")
    assert [
        item.payload["quality_snapshot"]["observation_sequence"] for item in result
    ] == [1, 1, 2, 3]
    assert len({item.identity for item in result}) == 4


def test_persistence_refreshes_cached_subscription_state_under_its_lock(
    test_db, test_user
):
    project = _project(test_db, test_user)
    hook = _subscription(test_db, test_user, project)

    def persist(db, conclusion):
        return project_event_polling_service._persist_page(
            db,
            hook_id=hook.id,
            source_type="github",
            inputs=(_input(conclusion),),
            next_cursor={},
        )

    assert persist(test_db, "SUCCESS") == 1
    assert hook.metadata_json["poll"]["quality_observations"][PR]["sequence"] == 1
    with Session(bind=test_db.get_bind()) as other:
        assert persist(other, "FAILURE") == 1
    assert hook.metadata_json["poll"]["quality_observations"][PR]["sequence"] == 1

    assert persist(test_db, "SUCCESS") == 1
    assert hook.metadata_json["poll"]["quality_observations"][PR]["sequence"] == 3
    assert test_db.query(ProjectIncomingEvent).count() == 3


def test_checks_order_and_collection_time_do_not_create_another_transition():
    first = _input("SUCCESS")
    first.payload["quality_snapshot"]["required_checks"].append(
        {"name": "another", "conclusion": "SUCCESS"}
    )
    second = deepcopy(first)
    second.payload["quality_snapshot"]["required_checks"].reverse()
    second.payload["quality_snapshot"]["observed_at"] = "2026-11-17T13:01:00Z"
    poll = {}
    assert len(prepare_quality_inputs((first,), poll, "hook")) == 1
    assert prepare_quality_inputs((second,), poll, "hook") == ()
    assert poll["quality_observations"][PR]["sequence"] == 1


def test_older_provider_observation_cannot_replace_a_newer_persisted_state():
    poll = {}
    current = _input("SUCCESS", instant="2026-11-17T13:01:00Z")
    assert len(prepare_quality_inputs((current,), poll, "hook")) == 1
    assert prepare_quality_inputs((_input("FAILURE"),), poll, "hook") == ()
    assert poll["quality_observations"][PR]["sequence"] == 1


@pytest.mark.parametrize(
    "identity", ["pull_request:12:conflict:head-1", "check_run:77:failure"]
)
def test_stale_enrichment_preserves_independent_base_event(identity):
    poll = {}
    prepare_quality_inputs(
        (_input("SUCCESS", instant="2026-11-17T13:02:00Z"),), poll, "hook"
    )
    before = deepcopy(poll)
    base = replace(_input("FAILURE"), identity=identity)
    base.payload["base_event"] = {"id": 77, "action": "completed"}

    result = prepare_quality_inputs((base,), poll, "hook")

    assert len(result) == 1
    assert result[0].identity == identity
    assert result[0].payload["base_event"] == base.payload["base_event"]
    assert "quality_snapshot" not in result[0].payload
    assert "quality_snapshot" in base.payload
    assert poll == before


@pytest.mark.parametrize("has_verified_head", [False, True])
def test_unverified_observation_advances_order_without_advancing_verified_head(
    has_verified_head,
):
    poll = {}
    if has_verified_head:
        prepare_quality_inputs((_input("SUCCESS"),), poll, "hook")
    uncertain = _input("FAILURE", instant="2026-11-17T13:03:00Z")
    uncertain.payload["quality_snapshot"].update(
        head_sha="unverified-head", head_verified=False, complete=False
    )
    prepare_quality_inputs((uncertain,), poll, "hook")
    before = deepcopy(poll)
    observation = poll["quality_observations"][PR]
    assert observation["last_observed_at"] == "2026-11-17T13:03:00Z"
    assert observation["latest_head_sha"] == "unverified-head"
    assert observation["latest_head_verified"] is False
    assert observation["latest_complete"] is False
    assert observation["head_sha"] == ("head-1" if has_verified_head else None)
    assert observation["observed_at"] == (
        "2026-11-17T13:00:00+00:00" if has_verified_head else None
    )

    delayed = _input("SUCCESS", instant="2026-11-17T13:02:00Z")
    assert prepare_quality_inputs((delayed,), poll, "hook") == ()
    assert poll == before

    fresh = _input("SUCCESS", instant="2026-11-17T13:04:00Z")
    fresh.payload["quality_snapshot"].update(
        head_sha="verified-head", head_verified=True
    )
    assert len(prepare_quality_inputs((fresh,), poll, "hook")) == 1
    observation = poll["quality_observations"][PR]
    assert observation["last_observed_at"] == observation["observed_at"]
    assert observation["head_sha"] == "verified-head"
    assert observation["latest_head_verified"] is True
    assert observation["latest_complete"] is True


@pytest.mark.asyncio
async def test_null_check_node_produces_incomplete_proof_without_losing_poll():
    def handler(request):
        return httpx.Response(
            200,
            json=graph_snapshot(
                contexts={"nodes": [None], "pageInfo": {"hasNextPage": False}}
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await observe_quality_snapshot(
            client,
            api_base="https://api.github.com",
            repository="acme/app",
            number=12,
            headers={},
            repository_payload={"full_name": "acme/app"},
            pull={"html_url": PR, "head": {"sha": "head-1"}},
        )
    snapshot = result.payload["quality_snapshot"]
    assert snapshot["complete"] is False
    assert snapshot["head_sha"] == "head-1"
    assert snapshot["reason_code"] == "quality_observation_unavailable"
    assert snapshot["observed_at"]


@pytest.mark.asyncio
async def test_same_head_prs_keep_their_own_branch_check_evidence():
    def detail(number):
        return {
            "number": number,
            "html_url": f"https://github.com/acme/app/pull/{number}",
            "head": {"sha": "shared-head"},
            "draft": False,
        }

    def handler(request):
        if request.method == "POST":
            number = json.loads(request.content)["variables"]["number"]
            data = graph_snapshot(
                head="shared-head",
                contexts={
                    "nodes": [
                        {
                            "name": f"branch-{number}",
                            "isRequired": True,
                            "conclusion": "FAILURE" if number == 12 else "SUCCESS",
                        }
                    ],
                    "pageInfo": {"hasNextPage": False},
                },
            )
            data["data"]["repository"]["pullRequest"]["url"] = detail(number)[
                "html_url"
            ]
            return httpx.Response(200, json=data)
        if request.url.path.endswith("/pulls"):
            return httpx.Response(200, json=[detail(12), detail(13)])
        if request.url.path.endswith("/pulls/12"):
            return httpx.Response(200, json=detail(12))
        if request.url.path.endswith("/pulls/13"):
            return httpx.Response(200, json=detail(13))
        if request.url.path.endswith("/check-runs"):
            return httpx.Response(
                200,
                json={
                    "check_runs": [
                        {
                            "id": 77,
                            "name": "branch-12",
                            "status": "completed",
                            "conclusion": "failure",
                        }
                    ]
                },
            )
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        inputs = await GitHubEventPoller()._open_pull_health_sweep_inputs(
            client,
            api_base="https://api.github.com",
            repository="acme/app",
            headers={},
            seen_numbers=set(),
        )
    checks = [item for item in inputs if "check_run" in item.payload]
    assert len(checks) == 2
    for item in checks:
        number = item.payload["check_run"]["pull_requests"][0]["number"]
        snapshot = item.payload["quality_snapshot"]
        assert snapshot["url"] == detail(number)["html_url"]
        assert snapshot["required_checks"][0]["name"] == f"branch-{number}"
