# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Redis staging buffer for external events.

The buffer serves two purposes with one set of keys:

- Compensation: an event that arrives before its binding is registered stays
  under its (provider, opaque reference, event type) key until registration
  takes it back.
- Debounce aggregation: while a rerun is executing, matching events are
  parked under an aggregate key that references the same triple keys instead
  of copying event data. The aggregate settles when the execution ends.

The buffer is intentionally ephemeral (24h TTL, restart-lossy); the durable
full event log in ``ProjectIncomingEvent`` remains the audit source.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from redis import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

KEY_PREFIX = "wework:external-events:v1"
TRIPLE_TTL_SECONDS = 24 * 60 * 60


def _triple_key(provider: str, opaque_ref: str, event_type: str) -> str:
    ref_digest = hashlib.sha256(opaque_ref.encode()).hexdigest()[:16]
    return f"{KEY_PREFIX}:triple:{provider}:{ref_digest}:{event_type}"


def _aggregate_key(task_id: str, node_id: str) -> str:
    return f"{KEY_PREFIX}:aggregate:{task_id}:{node_id}"


def _index_key(provider: str, opaque_ref: str) -> str:
    ref_digest = hashlib.sha256(opaque_ref.encode()).hexdigest()[:16]
    return f"{KEY_PREFIX}:index:{provider}:{ref_digest}"


class ExternalEventBuffer:
    """Lazy sync Redis client for the external event staging buffer."""

    def __init__(self, url: str | None = None) -> None:
        self._url = url or settings.REDIS_URL
        self._client: Redis | None = None

    def _redis(self) -> Redis:
        if self._client is None:
            self._client = Redis.from_url(
                self._url,
                encoding="utf-8",
                decode_responses=False,
                socket_timeout=3.0,
                socket_connect_timeout=2.0,
            )
        return self._client

    @staticmethod
    def _decode(value: bytes | None) -> list[dict[str, Any]]:
        if not value:
            return []
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return []
        return parsed if isinstance(parsed, list) else []

    @staticmethod
    def _encode(events: list[dict[str, Any]]) -> bytes:
        return json.dumps(events, ensure_ascii=False).encode()

    def append(
        self,
        provider: str,
        opaque_ref: str,
        event_type: str,
        event: dict[str, Any],
    ) -> None:
        """Append one event under its triple key, deduplicated by event_id."""

        key = _triple_key(provider, opaque_ref, event_type)
        try:
            events = self._decode(self._redis().get(key))
            event_id = event.get("event_id")
            if event_id and any(existing.get("event_id") == event_id for existing in events):
                return
            events.append(event)
            redis = self._redis()
            pipeline = redis.pipeline()
            pipeline.set(key, self._encode(events), ex=TRIPLE_TTL_SECONDS)
            index = json.loads(redis.get(_index_key(provider, opaque_ref)) or b"[]")
            if event_type not in index:
                index.append(event_type)
                pipeline.set(
                    _index_key(provider, opaque_ref),
                    json.dumps(index).encode(),
                    ex=TRIPLE_TTL_SECONDS,
                )
            pipeline.execute()
        except Exception:
            logger.exception(
                "External event buffer append failed provider=%s event_type=%s",
                provider,
                event_type,
            )

    def take(
        self,
        provider: str,
        opaque_ref: str,
        event_type: str,
    ) -> list[dict[str, Any]]:
        """Read and delete one triple key (compensation or settle)."""

        key = _triple_key(provider, opaque_ref, event_type)
        try:
            events = self._decode(self._redis().get(key))
            self._redis().delete(key)
            return events
        except Exception:
            logger.exception(
                "External event buffer take failed provider=%s event_type=%s",
                provider,
                event_type,
            )
            return []

    def take_for_reference(
        self,
        provider: str,
        opaque_ref: str,
    ) -> list[dict[str, Any]]:
        """Take every buffered event for one provider reference (compensation)."""

        try:
            raw = self._redis().get(_index_key(provider, opaque_ref))
            event_types = json.loads(raw) if raw else []
            self._redis().delete(_index_key(provider, opaque_ref))
        except Exception:
            logger.exception(
                "External event buffer reference take failed provider=%s", provider
            )
            return []
        events: list[dict[str, Any]] = []
        for event_type in event_types:
            if isinstance(event_type, str):
                events.extend(self.take(provider, opaque_ref, event_type))
        return events

    def push_aggregate(
        self,
        *,
        task_id: str,
        node_id: str,
        provider: str,
        opaque_ref: str,
        event_type: str,
    ) -> None:
        """Park a triple reference under one (task, node) aggregate key."""

        key = _aggregate_key(task_id, node_id)
        triple = [provider, opaque_ref, event_type]
        try:
            references = self._decode(self._redis().get(key))
            if triple not in references:
                references.append(triple)
                self._redis().set(key, self._encode(references), ex=TRIPLE_TTL_SECONDS)
        except Exception:
            logger.exception(
                "External event buffer aggregate push failed task=%s node=%s",
                task_id,
                node_id,
            )

    def take_aggregate(self, *, task_id: str, node_id: str) -> list[dict[str, Any]]:
        """Settle one (task, node) aggregate: resolve and delete all references."""

        key = _aggregate_key(task_id, node_id)
        try:
            references = self._decode(self._redis().get(key))
            self._redis().delete(key)
        except Exception:
            logger.exception(
                "External event buffer aggregate take failed task=%s node=%s",
                task_id,
                node_id,
            )
            return []
        events: list[dict[str, Any]] = []
        for reference in references:
            if not isinstance(reference, list) or len(reference) != 3:
                continue
            provider, opaque_ref, event_type = (str(value) for value in reference)
            events.extend(self.take(provider, opaque_ref, event_type))
        return events

    def clear(self) -> None:
        """Delete every buffer key (test helper and maintenance entry)."""

        try:
            keys = list(self._redis().scan_iter(f"{KEY_PREFIX}:*", count=200))
            if keys:
                self._redis().delete(*keys)
        except Exception:
            logger.exception("External event buffer clear failed")


external_event_buffer = ExternalEventBuffer()
