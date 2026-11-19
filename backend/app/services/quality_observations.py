# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Head proofs and locked collection state for quality admission."""

from datetime import datetime, timezone
from typing import Any, Mapping

from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.models.delivery import ProjectIncomingHook, loop_datetime_is_unset
from app.services.loop_items.change_requests import extract_change_request_urls
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_event_sources import resource_matches
from app.services.project_quality_observations import quality_snapshot_signature

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


def collector_observations(
    db: Session, *, project_id: str, urls: set[str]
) -> list[dict[str, Any]]:
    """Call after Issue locks; lock matching subscriptions in a stable order."""
    if not urls:
        return []
    quality_states = cast(
        ProjectIncomingHook.metadata_json["poll"]["quality_observations"], String
    )
    hooks = (
        db.query(ProjectIncomingHook)
        .filter(
            ProjectIncomingHook.cloud_project_id == project_id,
            ProjectIncomingHook.source == "github",
            ProjectIncomingHook.status == "active",
            loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            ProjectIncomingHook.metadata_json["collection_mode"]
            .as_string()
            .in_(["poll", "hybrid"]),
            or_(
                *(quality_states.contains(url, autoescape=True) for url in sorted(urls))
            ),
        )
        .order_by(ProjectIncomingHook.id)
        .with_for_update()
        .populate_existing()
        .all()
    )
    return [dict(hook.metadata_json or {}) for hook in hooks]


def collector_snapshot_signature(snapshot: Mapping[str, Any]) -> str:
    internal = {
        "collector_signature",
        "signature",
        "superseded_heads",
        "verified_head_at",
        "event_head_matches",
        "event_type",
        "conclusion",
        "mergeable_state",
        "check",
    }
    return quality_snapshot_signature(
        {key: value for key, value in snapshot.items() if key not in internal}
    )


def _collector_state(
    metadata: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> dict[str, Any]:
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
        return {}
    poll = metadata.get("poll")
    states = poll.get("quality_observations") if isinstance(poll, dict) else None
    observation = states.get(url) if isinstance(states, dict) else None
    return observation if isinstance(observation, dict) else {}


def newer_collector_head(
    metadata: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> bool:
    """Queued collector evidence must gate admission before event application."""
    observation = _collector_state(metadata, snapshot)
    collected_at = _observed_at(
        {
            "observed_at": observation.get("last_observed_at")
            or observation.get("observed_at")
        }
    )
    incoming_at = _observed_at(snapshot)
    source = observation.get("observation_source")
    source_matches = source and source == snapshot.get("observation_source")
    sequence, incoming_sequence = observation.get("sequence"), snapshot.get(
        "observation_sequence"
    )
    if (
        source_matches
        and isinstance(sequence, int)
        and isinstance(incoming_sequence, int)
        and sequence != incoming_sequence
    ):
        newer = sequence > incoming_sequence
    else:
        newer = collected_at is not None and (
            incoming_at is None or collected_at > incoming_at
        )
    if not newer:
        return False
    if observation.get("last_observed_at"):
        if (
            observation.get("latest_head_verified") is False
            or observation.get("latest_complete") is False
        ):
            return True
        latest_head = observation.get("latest_head_sha")
    else:
        latest_head = (
            observation.get("head_sha")
            if observation.get("head_verified") is True
            else None
        )
    return bool(
        latest_head
        and (
            latest_head != snapshot.get("head_sha")
            or (
                observation.get("signature")
                and observation["signature"]
                != (
                    snapshot.get("collector_signature")
                    or collector_snapshot_signature(snapshot)
                )
            )
        )
    )


def unresolved_quality_observations(handoff: Mapping[str, Any], urls: set[str]) -> bool:
    heads = handoff.get("pr_heads") or {}
    uncertain = handoff.get("unverified_pr_observations") or {}
    return any(
        url in urls
        and (
            not trusted_observation(heads.get(url) or {})
            or stale_observation(observation, heads.get(url) or {})
        )
        for url, observation in uncertain.items()
    )


def collector_blocks_quality(
    db: Session, *, project_id: str, snapshots: Mapping[str, Any], urls: set[str]
) -> bool:
    collectors = collector_observations(db, project_id=project_id, urls=urls)
    return any(
        newer_collector_head(collector, snapshots[url])
        for url in urls
        for collector in collectors
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
