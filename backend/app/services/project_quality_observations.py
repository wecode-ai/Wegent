# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Canonical quality states and durable consecutive polling transitions."""

import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from app.services.project_event_polling import PolledInput

_ORDER_FIELDS = {"observed_at", "observation_source", "observation_sequence"}


def quality_snapshot_signature(snapshot: dict[str, Any]) -> str:
    state = {key: value for key, value in snapshot.items() if key not in _ORDER_FIELDS}
    for field in ("required_checks", "expected_required_checks"):
        if isinstance(state.get(field), list):
            state[field] = sorted(
                state[field], key=lambda value: json.dumps(value, sort_keys=True)
            )
    return hashlib.sha256(
        json.dumps(state, sort_keys=True, default=str).encode()
    ).hexdigest()


def _observed_at(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (
            parsed.replace(tzinfo=timezone.utc)
            if parsed.tzinfo is None
            else parsed.astimezone(timezone.utc)
        )
    except ValueError:
        return None


def prepare_quality_inputs(
    inputs: tuple[PolledInput, ...], poll: dict[str, Any], source_id: str
) -> tuple[PolledInput, ...]:
    """Called under the subscription lock; state changes commit with events."""
    states = deepcopy(poll.get("quality_observations") or {})
    prepared = []
    for item in inputs:
        snapshot = item.payload.get("quality_snapshot")
        if not isinstance(snapshot, dict) or not snapshot.get("url"):
            prepared.append(item)
            continue
        url = snapshot["url"]
        signature = quality_snapshot_signature(snapshot)
        previous = states.get(url) or {}
        before = _observed_at(
            previous.get("last_observed_at") or previous.get("observed_at")
        )
        incoming = _observed_at(snapshot.get("observed_at"))
        quality_event = ":quality:" in item.identity
        if before and incoming and incoming < before:
            if not quality_event:
                payload = deepcopy(item.payload)
                payload.pop("quality_snapshot", None)
                prepared.append(replace(item, payload=payload))
            continue
        changed = previous.get("signature") != signature
        verified = snapshot.get("head_verified", snapshot.get("complete")) is True
        record = {
            "signature": signature,
            "sequence": int(previous.get("sequence") or 0) + int(changed),
            "observation_source": source_id,
            "last_observed_at": snapshot.get("observed_at")
            or previous.get("last_observed_at"),
            "latest_head_sha": snapshot.get("head_sha"),
            "latest_head_verified": verified,
            "latest_complete": snapshot.get("complete") is True,
            "observed_at": (
                snapshot.get("observed_at") if verified else previous.get("observed_at")
            ),
            "head_sha": (
                snapshot.get("head_sha") if verified else previous.get("head_sha")
            ),
            "head_verified": verified or previous.get("head_verified") is True,
            "emitted": not changed and previous.get("emitted", True),
        }
        states[url] = record
        if quality_event and record["emitted"]:
            continue
        payload = deepcopy(item.payload)
        payload["quality_snapshot"].update(
            observation_source=source_id, observation_sequence=record["sequence"]
        )
        identity = (
            f"{item.identity}:transition:{record['sequence']}"
            if quality_event
            else item.identity
        )
        prepared.append(replace(item, identity=identity, payload=payload))
        if quality_event:
            record["emitted"] = True
    poll["quality_observations"] = states
    return tuple(prepared)
