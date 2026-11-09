# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist successful device observations independently of the online TTL."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, update
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.device.identity import record_id_from_route

PRESENCE_PERSIST_INTERVAL_SECONDS = 60


def persist_device_presence(
    db: Session,
    user_id: int,
    device_id: str,
    runtime_instance_id: str | None,
    observed_at: datetime,
    *,
    force: bool = False,
) -> bool:
    """Atomically advance one installation's timestamp without replacing its spec."""
    observed_at = observed_at.astimezone(timezone.utc)
    timestamp = observed_at.isoformat(timespec="microseconds")
    cutoff = observed_at - timedelta(
        seconds=0 if force else PRESENCE_PERSIST_INTERVAL_SECONDS
    )
    record_id = record_id_from_route(device_id)
    previous = Kind.json["status"]["lastSeenAt"].as_string()
    document = func.json_set(
        Kind.json,
        "$.status",
        func.coalesce(func.json_extract(Kind.json, "$.status"), func.json_object()),
    )
    elapsed = (
        previous < timestamp
        if force
        else previous <= cutoff.isoformat(timespec="microseconds")
    )
    result = db.execute(
        update(Kind)
        .where(
            Kind.user_id == user_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
            Kind.id == record_id if record_id is not None else Kind.name == device_id,
            Kind.json["spec"]["runtimeInstanceId"].as_string() == runtime_instance_id,
            or_(previous.is_(None), elapsed),
        )
        .values(json=func.json_set(document, "$.status.lastSeenAt", timestamp))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount > 0
