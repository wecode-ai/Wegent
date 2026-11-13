# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Sequence
from urllib.parse import quote
from uuid import uuid4

ALLOWED_STATUSES = {
    "started",
    "success",
    "failure",
    "skipped",
    "cancelled",
    "partial",
    "completed",
    "failed",
}


def build_fact_key(namespace: str, parts: Sequence[object]) -> str:
    encoded_parts = [
        (
            "~"
            if part is None
            else "%7E" if str(part) == "~" else quote(str(part), safe="")
        )
        for part in parts
    ]
    suffix = "|".join(encoded_parts)
    return f"v1|{namespace}|{suffix}" if encoded_parts else f"v1|{namespace}"


def build_envelope(
    *,
    event_type: str,
    fact_key_parts: Sequence[object],
    service_name: str,
    environment: str,
    host_ip: str | None,
    kb_id: int | str | None,
    document_id: int | str | None,
    status: str,
    error_code: str | None,
    duration_ms: int | None,
    data: Mapping[str, Any],
) -> dict[str, Any]:
    if not event_type.startswith("knowledge."):
        raise ValueError("event_type must use the knowledge namespace")
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"unsupported event status: {status}")
    if error_code is not None and not error_code.strip():
        raise ValueError("error_code must be absent or non-empty")

    return {
        "schema_version": 1,
        "event_id": str(uuid4()),
        "fact_key": build_fact_key(event_type, fact_key_parts),
        "event_type": event_type,
        "occurred_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "service_name": service_name,
        "deployment_environment": environment,
        "host_ip": host_ip,
        "kb_id": kb_id,
        "document_id": document_id,
        "status": status,
        "error_code": error_code,
        "duration_ms": duration_ms,
        "data": dict(data),
    }
