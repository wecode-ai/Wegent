# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Process-local event submission; receivers must not wait for network I/O."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

from . import contracts
from .dimensions import knowledge_base_fields, knowledge_base_ownerships
from .envelope import ALLOWED_STATUSES


class EventReceiver(Protocol):
    def accepts(self, event_type: str) -> bool: ...
    def observation_limit(self, event_type: str) -> int: ...
    def receive(self, event: dict[str, Any]) -> None: ...


_receiver: EventReceiver | None = None
_receiver_pid: int | None = None
_registration_lock = Lock()


def _reset_registration_lock() -> None:
    global _registration_lock
    _registration_lock = Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_registration_lock)


def register_event_receiver(receiver: EventReceiver | None) -> None:
    """Register a single receiver in the current process."""
    global _receiver, _receiver_pid
    with _registration_lock:
        _receiver = receiver
        _receiver_pid = os.getpid() if receiver is not None else None


def unregister_event_receiver(receiver: EventReceiver) -> None:
    """Clear a receiver only when it still owns the process registration."""
    global _receiver, _receiver_pid
    with _registration_lock:
        if _current() is receiver:
            _receiver = None
            _receiver_pid = None


def _current() -> EventReceiver | None:
    return _receiver if _receiver_pid == os.getpid() else None


def is_event_reporting_enabled(event_type: str | None = None) -> bool:
    try:
        receiver = _current()
        return receiver is not None and (
            event_type is None or receiver.accepts(event_type)
        )
    except Exception:
        return False


def get_event_observation_limit(event_type: str) -> int:
    try:
        receiver = _current()
        if receiver is not None and receiver.accepts(event_type):
            return max(0, int(receiver.observation_limit(event_type)))
    except Exception:
        pass
    return 0


def emit_event(
    *,
    event_type: str,
    payload_factory: Callable[[], Mapping[str, Any]] = dict,
    fact_key_parts: Sequence[object] = (),
    kb_id: int | str | None = None,
    document_id: int | str | None = None,
    status: str = "success",
    error_code_factory: Callable[[], str | None] | None = None,
    duration_ms_factory: Callable[[], int | None] | None = None,
    fields_factory: Callable[[], dict[str, Any]] | None = None,
) -> None:
    try:
        receiver = _current()
        if (
            receiver is None
            or event_type not in contracts.EVENT_TYPES
            or not receiver.accepts(event_type)
        ):
            return
        frame = fields_factory() if fields_factory else {}
        kb_id = frame.get("kb_id", kb_id)
        data = contracts.payload(
            event_type, frame.get("data", {}) if fields_factory else payload_factory()
        )
        if event_type == "knowledge.retrieval.request.finished" and kb_id is None:
            ownerships = knowledge_base_ownerships(data.get("knowledge_base_ids"))
            ownership = (
                {"asset_org_by_kb": ownerships} if ownerships is not None else {}
            )
        else:
            ownership = knowledge_base_fields(kb_id)
        if (
            ownership
            and not data.keys() & ownership.keys()
            and len(data.keys() | ownership.keys()) <= contracts.MAX_DATA_FIELDS
        ):
            data.update(ownership)
        parts = frame.get("fact_key_parts", fact_key_parts)
        if len(parts) > 64 or frame.get("status", status) not in ALLOWED_STATUSES:
            return
        event = {
            "event_id": str(uuid4()),
            "occurred_at": datetime.now(timezone.utc).isoformat(
                timespec="milliseconds"
            ),
            "event_type": event_type,
            "fact_key_parts": tuple(contracts.scalar(part) for part in parts),
            "kb_id": contracts.scalar(kb_id),
            "document_id": contracts.scalar(frame.get("document_id", document_id)),
            "status": frame.get("status", status),
            "error_code": contracts.scalar(
                frame.get("error_code")
                if fields_factory
                else error_code_factory() if error_code_factory else None
            ),
            "duration_ms": contracts.scalar(
                frame.get("duration_ms")
                if fields_factory
                else duration_ms_factory() if duration_ms_factory else None
            ),
            "data": data,
        }
        receiver.receive(event)
    except Exception:
        pass
