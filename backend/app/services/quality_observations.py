# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure identity and ordering rules for trusted quality observations."""

from datetime import datetime, timezone
from typing import Any, Mapping

from app.services.loop_items.change_requests import extract_change_request_urls
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_event_sources import resource_matches

ORDER_FIELDS = {"observed_at", "observation_sequence", "observation_source"}


def linked_pr_urls(metadata: Mapping[str, Any]) -> set[str]:
    """Use the shared provider URL parser, including Enterprise GitHub hosts."""
    return {
        url
        for badge in metadata.get("badges", [])
        if isinstance(badge, dict) and badge.get("icon") == "git-pull-request"
        for url in extract_change_request_urls(str(badge.get("url") or ""))
        if "/-/merge_requests/" not in url
    }


def _observed_at(snapshot: Mapping[str, Any]) -> datetime | None:
    value = snapshot.get("observed_at")
    if not isinstance(value, str):
        return None
    try:
        observed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return observed.astimezone(timezone.utc) if observed.tzinfo else None


def trusted_observation(snapshot: Mapping[str, Any]) -> bool:
    return verified_head_time(snapshot) is not None


def verified_head_time(snapshot: Mapping[str, Any]) -> datetime | None:
    verified = snapshot.get("head_verified", snapshot.get("complete") is True)
    if verified is True and _observed_at(snapshot) is not None:
        return _observed_at(snapshot)
    return _observed_at({"observed_at": snapshot.get("verified_head_at")})


def unverified_head_change(
    previous: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> bool:
    return bool(
        previous.get("head_sha") != snapshot.get("head_sha")
        and trusted_observation(previous)
        and not trusted_observation(snapshot)
    )


def preserve_head_proof(
    previous: Mapping[str, Any], snapshot: dict[str, Any]
) -> dict[str, Any]:
    verified_at = verified_head_time(snapshot)
    if verified_at is None and previous.get("head_sha") == snapshot.get("head_sha"):
        verified_at = verified_head_time(previous)
    return {
        **snapshot,
        **({"verified_head_at": verified_at.isoformat()} if verified_at else {}),
    }


def stale_observation(previous: Mapping[str, Any], snapshot: Mapping[str, Any]) -> bool:
    """Sequence orders one collector; its trusted clock orders distinct sources."""
    if not previous.get("head_sha"):
        return False
    source = snapshot.get("observation_source")
    if source and source == previous.get("observation_source"):
        current = snapshot.get("observation_sequence")
        old = previous.get("observation_sequence")
        if isinstance(current, int) and isinstance(old, int) and current != old:
            return current < old
    current_at, old_at = _observed_at(snapshot), _observed_at(previous)
    if current_at is not None and old_at is not None:
        return current_at < old_at
    return bool(
        old_at is not None
        and current_at is None
        and previous.get("head_sha") != snapshot.get("head_sha")
    )


def newer_collector_head(
    metadata: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> bool:
    """A deduplicated poll still contributes its persisted collection watermark."""
    url = str(snapshot["url"])
    instance, repository = project_change_request_binding_service._identity_from_url(
        "github", url, int(url.rsplit("/", 1)[-1])
    )
    resource = metadata.get("resource")
    if not isinstance(resource, dict) or not resource_matches(
        resource,
        {
            "resource_type": "repository",
            "instance_url": instance,
            "path": repository,
        },
    ):
        return False
    poll = metadata.get("poll")
    states = poll.get("quality_observations") if isinstance(poll, dict) else None
    observation = states.get(url) if isinstance(states, dict) else None
    if (
        not isinstance(observation, dict)
        or not observation.get("head_sha")
        or observation.get("head_verified") is not True
    ):
        return False
    collected_at = _observed_at(observation)
    incoming_at = _observed_at(snapshot)
    return bool(
        observation["head_sha"] != snapshot.get("head_sha")
        and collected_at is not None
        and (incoming_at is None or collected_at > incoming_at)
    )


def observed_heads(heads: Mapping[str, Any], urls: set[str]) -> dict[str, str]:
    return {
        url: str(heads[url]["head_sha"])
        for url in urls
        if isinstance(heads.get(url), dict) and heads[url].get("head_sha")
    }


def reconcile_links(handoff: dict[str, Any], urls: set[str]) -> bool:
    """Removed PRs leave the gate; newly linked PRs still need full proof."""
    changed = False
    for key in (
        "pr_heads",
        "accepted_heads",
        "technical_blocked_heads",
        "unverified_pr_observations",
    ):
        previous = handoff.get(key)
        if isinstance(previous, dict):
            remaining = {url: value for url, value in previous.items() if url in urls}
            if previous != remaining:
                handoff[key] = remaining
                changed = True
    if changed:
        handoff["acceptance_complete"] = False
    return changed


def retained_block(
    handoff: dict[str, Any], heads: Mapping[str, Any], urls: set[str]
) -> str | None:
    """Healthy check events cannot resolve a rejection or a failed head."""
    rejected = handoff.get("review_blocked_heads") or {}
    current = observed_heads(heads, urls)
    applicable = set(rejected) & urls
    if applicable and not any(
        url in current and current[url] != rejected[url] for url in applicable
    ):
        return "quality_changes_requested"
    if rejected:
        handoff.pop("review_blocked_heads", None)
    failed = handoff.get("technical_blocked_heads") or {}
    active = {url: head for url, head in failed.items() if current.get(url) == head}
    handoff["technical_blocked_heads"] = active
    return "pr_checks_failed" if active else None
