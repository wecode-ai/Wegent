"""Persistent presence must survive TTL expiry without conflating installations."""

from datetime import datetime, timedelta, timezone

import pytest

from app.models.kind import Kind
from app.services.device.presence import persist_device_presence


@pytest.fixture
def installations(test_db):
    rows = [
        Kind(
            user_id=7,
            namespace="default",
            name="local-device",
            kind="Device",
            json={"spec": {"deviceType": "app", "runtimeInstanceId": f"runtime-{i}"}},
        )
        for i in range(2)
    ]
    test_db.add_all(rows)
    test_db.commit()
    return rows


def observe(db, row, at, **kwargs):
    persist_device_presence(db, 7, f"app-record-{row.id}", "runtime-0", at, **kwargs)
    db.commit()
    db.refresh(row)
    return row.json.get("status", {}).get("lastSeenAt")


def test_presence_is_record_scoped_and_does_not_replace_spec(test_db, installations):
    selected, other = installations
    at = datetime(2026, 11, 6, 8, tzinfo=timezone.utc)
    assert observe(test_db, selected, at) == at.isoformat(timespec="microseconds")
    test_db.refresh(other)
    assert "status" not in other.json
    assert selected.json["spec"]["runtimeInstanceId"] == "runtime-0"


def test_presence_is_throttled_and_never_moves_backwards(test_db, installations):
    row = installations[0]
    at = datetime(2026, 11, 6, 8, tzinfo=timezone.utc)
    original = observe(test_db, row, at)
    assert observe(test_db, row, at + timedelta(seconds=30)) == original
    latest = observe(test_db, row, at + timedelta(seconds=60))
    assert latest != original
    assert observe(test_db, row, at, force=True) == latest
    assert observe(test_db, row, at + timedelta(seconds=65), force=True) != latest


@pytest.mark.parametrize(
    "owner,runtime,active",
    [(8, "runtime-0", True), (7, "other", True), (7, "runtime-0", False)],
)
def test_presence_cannot_touch_another_owner_runtime_or_deleted_record(
    test_db, installations, owner, runtime, active
):
    row = installations[0]
    row.is_active = active
    test_db.commit()
    persist_device_presence(
        test_db,
        owner,
        f"app-record-{row.id}",
        runtime,
        datetime(2026, 11, 6, 8, tzinfo=timezone.utc),
        force=True,
    )
    test_db.commit()
    test_db.refresh(row)
    assert "lastSeenAt" not in row.json.get("status", {})


async def test_noop_write_does_not_postpone_the_next_presence_observation(monkeypatch):
    from unittest.mock import AsyncMock

    from app.api.ws import device_namespace

    writer = AsyncMock(side_effect=[False, True])
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", writer)
    namespace = device_namespace.DeviceNamespace()
    session = {"user_id": 7, "device_id": "app-record-1"}
    await namespace._persist_device_presence("sid", session)
    assert "presence_persisted_at" not in session
    await namespace._persist_device_presence("sid", session)
    assert "presence_persisted_at" in session
    await namespace._persist_device_presence("sid", session)
    assert writer.await_count == 2
