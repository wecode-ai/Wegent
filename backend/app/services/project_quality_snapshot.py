# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Collect a head-bound GitHub required-check snapshot for quality handoffs."""

from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import quote

import httpx

from app.services.project_event_polling import EventPollingError, PolledInput
from shared.telemetry.decorators import trace_async

_QUERY = """
query QualitySnapshot($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url headRefOid isDraft state mergeable baseRefName
      baseRef { branchProtectionRule { requiredStatusChecks { context app { databaseId } } } }
      commits(last: 1) { nodes { commit {
        oid statusCheckRollup { contexts(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { name conclusion status checkSuite { app { databaseId } } isRequired(pullRequestNumber: $number) }
            ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
          }
        } }
      } } }
    }
  }
}
"""


@trace_async(span_name="collaboration.quality_snapshot.collect")
async def collect_quality_snapshot(
    client: httpx.AsyncClient,
    *,
    api_base: str,
    repository: str,
    number: int,
    headers: Mapping[str, str],
    repository_payload: dict[str, Any],
) -> PolledInput:
    observed_at = datetime.now(timezone.utc).isoformat()
    owner, name = repository.split("/", 1)
    endpoint = (
        "https://api.github.com/graphql"
        if api_base == "https://api.github.com"
        else api_base.removesuffix("/v3") + "/graphql"
    )
    cursor = None
    observed: list[dict[str, Any]] = []
    expected_head = None
    snapshot: dict[str, Any] = {}
    for _ in range(10):
        try:
            response = await client.post(
                endpoint,
                headers=headers,
                json={
                    "query": _QUERY,
                    "variables": {
                        "owner": owner,
                        "name": name,
                        "number": number,
                        "after": cursor,
                    },
                },
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EventPollingError("GitHub quality snapshot request failed") from exc
        if payload.get("errors"):
            raise EventPollingError("GitHub quality snapshot query was rejected")
        pull = ((payload.get("data") or {}).get("repository") or {}).get("pullRequest")
        if not isinstance(pull, dict) or not pull.get("headRefOid"):
            raise EventPollingError("GitHub quality snapshot is missing its PR head")
        if expected_head and expected_head != pull["headRefOid"]:
            raise EventPollingError(
                "GitHub PR head changed while collecting required checks"
            )
        expected_head = pull["headRefOid"]
        commits = (pull.get("commits") or {}).get("nodes") or []
        commit = (commits[-1].get("commit") or {}) if commits else {}
        if commit.get("oid") != expected_head:
            raise EventPollingError(
                "GitHub required checks do not belong to the PR head"
            )
        contexts = (commit.get("statusCheckRollup") or {}).get("contexts") or {}
        for check in contexts.get("nodes") or []:
            if not isinstance(check, dict):
                raise EventPollingError("GitHub required-check proof is unavailable")
            observed.append(
                {
                    "name": check.get("name") or check.get("context"),
                    "conclusion": check.get("conclusion")
                    or check.get("state")
                    or "PENDING",
                    "status": check.get("status"),
                    "head_sha": expected_head,
                    "app_id": ((check.get("checkSuite") or {}).get("app") or {}).get(
                        "databaseId"
                    ),
                    "required": check.get("isRequired") is True,
                }
            )
        page = contexts.get("pageInfo") or {}
        snapshot = {
            "complete": not page.get("hasNextPage", False),
            "url": pull.get("url"),
            "head_sha": expected_head,
            "head_verified": True,
            "draft": pull.get("isDraft"),
            "state": pull.get("state"),
            "mergeable": pull.get("mergeable"),
            "required_checks": [],
        }
        if snapshot["complete"]:
            break
        cursor = page.get("endCursor")
        if not cursor:
            raise EventPollingError("GitHub required-check pagination is incomplete")
    expected, rules_complete = await _expected_checks(
        client,
        api_base=api_base,
        repository=repository,
        headers=headers,
        pull=pull,
    )
    checks = [check for check in observed if check["required"]]
    for required in expected:
        matches = [
            check
            for check in observed
            if check["name"] == required["name"]
            and (required["app_id"] is None or check["app_id"] == required["app_id"])
        ]
        if not matches:
            checks.append(
                {
                    "name": required["name"],
                    "conclusion": "PENDING",
                    "status": None,
                    "head_sha": expected_head,
                    "app_id": required["app_id"],
                    "required": True,
                }
            )
        else:
            checks.extend(check for check in matches if check not in checks)
    snapshot["required_checks"] = [
        {
            key: value
            for key, value in check.items()
            if key not in {"app_id", "required"}
        }
        for check in checks
    ]
    snapshot["expected_required_checks"] = expected
    snapshot["complete"] = snapshot["complete"] and rules_complete
    snapshot["observed_at"] = observed_at
    return _quality_input(number, repository_payload, snapshot)


@trace_async(span_name="collaboration.quality_snapshot.observe")
async def observe_quality_snapshot(
    client: httpx.AsyncClient,
    *,
    api_base: str,
    repository: str,
    number: int,
    headers: Mapping[str, str],
    repository_payload: dict[str, Any],
    pull: dict[str, Any],
) -> PolledInput:
    """Preserve base polling events when additional quality proof is unavailable."""
    observed_at = datetime.now(timezone.utc).isoformat()
    try:
        return await collect_quality_snapshot(
            client,
            api_base=api_base,
            repository=repository,
            number=number,
            headers=headers,
            repository_payload=repository_payload,
        )
    except EventPollingError as exc:
        snapshot = {
            "complete": False,
            "url": pull.get("html_url")
            or f"https://github.com/{repository}/pull/{number}",
            "head_sha": (pull.get("head") or {}).get("sha"),
            "head_verified": False,
            "draft": pull.get("draft"),
            "state": pull.get("state"),
            "mergeable": (
                "CONFLICTING" if pull.get("mergeable") is False else "UNKNOWN"
            ),
            "required_checks": [],
            "observation_error": str(exc),
            "reason_code": "quality_observation_unavailable",
            "observed_at": observed_at,
        }
        return _quality_input(number, repository_payload, snapshot)


def _quality_input(
    number: int,
    repository_payload: dict[str, Any],
    snapshot: dict[str, Any],
) -> PolledInput:
    from app.services.project_quality_observations import quality_snapshot_signature

    signature = quality_snapshot_signature(snapshot)[:24]
    return PolledInput(
        identity=f"pull_request:{number}:quality:{signature}",
        title=f"github: pull_request quality #{number}",
        payload={
            "quality_snapshot": snapshot,
            "action": "synchronize",
            "repository": repository_payload,
            "pull_request": {
                "number": number,
                "html_url": snapshot.get("url"),
                "head": {"sha": snapshot.get("head_sha")},
            },
        },
        headers={"x-github-event": "pull_request"},
    )


async def _expected_checks(
    client: httpx.AsyncClient,
    *,
    api_base: str,
    repository: str,
    headers: Mapping[str, str],
    pull: dict[str, Any],
) -> tuple[list[dict[str, Any]], bool]:
    base = pull.get("baseRef")
    branch = pull.get("baseRefName")
    if not isinstance(base, dict) or "branchProtectionRule" not in base or not branch:
        raise EventPollingError("GitHub branch check requirements are unavailable")
    protection = base.get("branchProtectionRule") or {}
    expected = [
        {"name": check["context"], "app_id": (check.get("app") or {}).get("databaseId")}
        for check in protection.get("requiredStatusChecks") or []
    ]
    for page in range(1, 11):
        try:
            response = await client.get(
                f"{api_base}/repos/{repository}/rules/branches/{quote(branch, safe='')}",
                headers=headers,
                params={"per_page": 100, "page": page},
            )
            response.raise_for_status()
            rules = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EventPollingError(
                "GitHub effective branch rules are unavailable"
            ) from exc
        if not isinstance(rules, list):
            raise EventPollingError("GitHub effective branch rules are invalid")
        for rule in rules:
            if rule.get("type") != "required_status_checks":
                continue
            values = (rule.get("parameters") or {}).get("required_status_checks")
            if not isinstance(values, list):
                raise EventPollingError(
                    "GitHub required status check rules are incomplete"
                )
            expected.extend(
                {
                    "name": value["context"],
                    "app_id": value.get("integration_id") or None,
                }
                for value in values
            )
        if len(rules) < 100:
            return expected, True
    return expected, False
