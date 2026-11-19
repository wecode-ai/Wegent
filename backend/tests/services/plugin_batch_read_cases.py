"""Database-independent cases exercised with SQLite and isolated InnoDB."""

from contextlib import contextmanager
from datetime import datetime, timedelta

from sqlalchemy import event

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin, PluginDeviceInstallation
from app.models.plugin_publication import (
    PluginPublicationCheck,
    PluginPublicationRequest,
    PluginPublicationRevision,
)
from app.models.user import User
from app.schemas.installed_plugin import (
    InstalledPlugin,
    InstalledPluginListResponse,
    PluginDeviceInstallationItem,
)
from app.services.plugin_device_identity import (
    coalesce_plugin_device_rows,
    coalesce_plugin_device_rows_resolved,
    plugin_device_id,
)
from app.services.plugin_device_snapshot import PluginDeviceSnapshot
from app.services.plugin_installation_views import enrich_plugin_installations
from app.services.plugin_publication_service import PluginPublicationService


@contextmanager
def select_reads(db):
    statements = []

    def record(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


def plugin(db, index):
    row = Plugin(
        catalog_namespace="enterprise",
        slug=f"batch-{index}",
        name=f"batch-{index}",
        display_name=f"Plugin {index}",
        latest_release_id=100 + index,
    )
    db.add(row)
    db.flush()
    return row


def installed_item(index, plugin_id, release_id):
    return InstalledPlugin(
        metadata={"name": f"install-{index}", "labels": {"id": str(index)}},
        spec={
            "source": {"type": "marketplace", "pluginKey": str(index)},
            "displayName": f"Plugin {index}",
            "pluginId": plugin_id,
            "releaseId": release_id,
        },
    )


def installation_budget_case(db, count, device):
    now = datetime(2026, 1, 1)
    for number in range(1, 4):
        db.add(
            Kind(
                user_id=7,
                kind="Device",
                name=f"host-{number}",
                namespace="default",
                is_active=True,
                json={"spec": {"deviceType": "remote", "deviceId": f"host-{number}"}},
            )
        )
    items = []
    for index in range(1, count + 1):
        market = plugin(db, index)
        # Repeated plugin IDs must not produce repeated version reads.
        items.append(installed_item(index, market.id, market.latest_release_id))
        for number in range(1, 4):
            db.add(
                PluginDeviceInstallation(
                    user_id=7,
                    installed_kind_id=index,
                    device_id=f"host-{number}",
                    desired_release_id=market.latest_release_id,
                    actual_release_id=market.latest_release_id,
                    state="installed",
                    updated_at=now,
                )
            )
    if items:
        first = items[0]
        items.append(
            installed_item(count + 1, first.spec.pluginId, first.spec.releaseId)
        )
        for number in range(1, 4):
            db.add(
                PluginDeviceInstallation(
                    user_id=7,
                    installed_kind_id=count + 1,
                    device_id=f"host-{number}",
                    desired_release_id=first.spec.releaseId,
                    actual_release_id=first.spec.releaseId,
                    state="installed",
                    updated_at=now,
                )
            )
    db.commit()
    db.expunge_all()
    response = InstalledPluginListResponse(items=items)
    before = response.model_dump()
    with select_reads(db) as reads:
        enrich_plugin_installations(db, response, device_id=device)
    assert len(reads) <= 3
    assert len(reads) == (0 if count == 0 else 2 if device in {"missing", "   "} else 3)
    expected = InstalledPluginListResponse.model_validate(before)
    for item in expected.items:
        item.spec.installState = (
            "not_installed" if device in {"missing", "   "} else "installed"
        )
        for number in range(1, 4):
            item.status.devices.append(
                PluginDeviceInstallationItem(
                    **{
                        "deviceId": f"host-{number}",
                        "desiredReleaseId": item.spec.releaseId,
                        "actualReleaseId": item.spec.releaseId,
                        "state": "installed",
                        "errorCode": None,
                        "errorMessage": None,
                        "attemptCount": 0,
                        "lastSyncAt": None,
                        "updatedAt": now,
                    }
                )
            )
    assert response.model_dump() == expected.model_dump()


def installation_edge_case(db):
    market = plugin(db, 1)
    items = [
        installed_item(i, market.id, release)
        for i, release in enumerate([None, 101, 101, 101, 101], 1)
    ]
    items.append(installed_item(6, 987654, 101))
    items.append(installed_item(7, 0, 101))
    for index, actual, state in [
        (1, 101, "installed"),
        (2, 0, "failed"),
        (3, 0, "pending"),
        (4, 100, "installed"),
        (5, 101, "failed"),
    ]:
        db.add(
            PluginDeviceInstallation(
                user_id=7,
                installed_kind_id=index,
                device_id="unknown",
                desired_release_id=101,
                actual_release_id=actual,
                state=state,
            )
        )
    db.commit()
    for device, expected in [
        (
            None,
            [
                "update_available",
                "installed",
                "installed",
                "installed",
                "installed",
                "installed",
                "installed",
            ],
        ),
        (
            "",
            [
                "update_available",
                "installed",
                "installed",
                "installed",
                "installed",
                "installed",
                "installed",
            ],
        ),
        (
            "unknown",
            [
                "update_available",
                "failed",
                "not_installed",
                "update_available",
                "installed",
                "not_installed",
                "installed",
            ],
        ),
    ]:
        response = InstalledPluginListResponse(
            items=[item.model_copy(deep=True) for item in items]
        )
        with select_reads(db) as reads:
            enrich_plugin_installations(db, response, device_id=device)
        assert len(reads) <= 3
        assert [item.spec.installState for item in response.items] == expected


def snapshot_case(db):
    devices = []
    for owner, name, kind, namespace, active in [
        (7, "shared", "app", "default", True),
        (8, "shared", "app", "default", True),
        (7, "inactive", "app", "default", False),
        (7, "foreign", "app", "other", True),
        (7, "ambiguous", "app", "default", True),
        (7, "ambiguous", "app", "default", True),
        (7, "shared", "remote", "default", True),
    ]:
        row = Kind(
            user_id=owner,
            kind="Device",
            name=name,
            namespace=namespace,
            is_active=active,
            json={"spec": {"deviceType": kind, "deviceId": name, "appDeviceId": name}},
        )
        db.add(row)
        db.flush()
        devices.append(row)
    db.commit()
    ids = [row.id for row in devices]
    cases = [
        (7, "shared", f"app-record-{ids[0]}"),
        (8, "shared", f"app-record-{ids[1]}"),
        (7, "ambiguous", "ambiguous"),
        (7, "inactive", "inactive"),
        (7, "foreign", "foreign"),
        (7, f"app-record-{ids[1]}", f"app-record-{ids[1]}"),
        (7, "app-record-0", "app-record-0"),
        (7, "   ", ""),
        (7, "unknown", "unknown"),
    ]
    db.expunge_all()
    with select_reads(db) as reads:
        snapshot = PluginDeviceSnapshot.load(
            db, ((user, alias) for user, alias, _ in cases)
        )
        for owner, alias, expected in cases:
            assert snapshot.resolve(owner, alias) == expected
            assert snapshot.resolve(owner, alias) == expected
    assert len(reads) == 1
    for owner, alias, expected in cases:
        assert plugin_device_id(db, owner, alias) == expected
    with select_reads(db) as reads:
        record_snapshot = PluginDeviceSnapshot.load(db, [(7, f"app-record-{ids[0]}")])
        assert (
            record_snapshot.resolve(7, f"app-record-{ids[0]}") == f"app-record-{ids[0]}"
        )
    assert len(reads) == 1 and "kinds.id IN" in reads[0]
    assert sum(len(rows) for rows in record_snapshot._devices.values()) == 1


def publication_budget_case(db, count, admin):
    users = []
    for index in [1, 2]:
        user = User(
            user_name=f"batch-user-{index}",
            email=f"batch-{index}@example.test",
            password_hash="unused",
            is_active=True,
        )
        db.add(user)
        db.flush()
        users.append(user)
    owner_ids = [user.id for user in users]
    base = datetime(2026, 1, 1)
    expected = {}
    for index in range(count):
        market = plugin(db, index)
        owner = users[index % 2]
        request = PluginPublicationRequest(
            source_plugin_id=market.id,
            submitter_user_id=owner.id,
            aggregate_status="awaiting_admin",
            created_at=base + timedelta(seconds=index),
            updated_at=base + timedelta(seconds=index),
        )
        db.add(request)
        db.flush()
        revision = PluginPublicationRevision(
            request_id=request.id,
            requested_version=f"1.0.{index}",
            pipeline_status="success",
        )
        db.add(revision)
        db.flush()
        request.current_revision_id = revision.id
        request.updated_at = base + timedelta(seconds=index + 1)
        for number in range(index % 3 + 1):
            db.add(
                PluginPublicationCheck(
                    revision_id=revision.id,
                    check_code=f"check-{number}",
                    severity="blocker" if number == 0 else "info",
                    status="failed" if number == 0 else "warning",
                )
            )
        expected[request.id] = {
            "id": request.id,
            "pluginId": market.id,
            "pluginName": market.display_name,
            "pluginSlug": market.slug,
            "requestedVersion": revision.requested_version,
            "submitter": {
                "id": owner.id,
                "userName": owner.user_name,
                "email": owner.email,
            },
            "currentRevision": 1,
            "stage": "administrator_review",
            "status": "awaiting_admin",
            "riskLevel": "none",
            "blockerCount": 1,
            "warningCount": index % 3,
            "gitlabStatus": "success",
            "submittedAt": request.created_at,
            "updatedAt": request.updated_at,
        }
    db.commit()
    db.expunge_all()
    with select_reads(db) as reads:
        result = PluginPublicationService().list_requests(
            db, user_id=owner_ids[0], is_admin=admin, page=1, limit=100
        )
    assert len(reads) == (6 if result.items else 2)
    visible = [
        value
        for value in expected.values()
        if admin or value["submitter"]["id"] == owner_ids[0]
    ]
    assert result.total == len(visible)
    actual = []
    for item in result.items:
        value = item.model_dump()
        assert value.pop("waitingDurationSeconds") >= 0
        actual.append(value)
    assert actual == visible, [(a, e) for a, e in zip(actual, visible) if a != e]
    with select_reads(db) as reads:
        empty = PluginPublicationService().list_requests(
            db, user_id=owner_ids[0], is_admin=admin, page=200, limit=20
        )
    assert empty.items == [] and len(reads) == 2


def publication_broken_reference_case(db):
    owner = User(user_name="missing-ref-user", password_hash="unused", is_active=True)
    db.add(owner)
    db.flush()
    owner_id = owner.id
    first = PluginPublicationRequest(
        source_plugin_id=987654, submitter_user_id=owner_id
    )
    second = PluginPublicationRequest(
        source_plugin_id=987655, submitter_user_id=owner_id + 99999
    )
    db.add_all([first, second])
    db.flush()
    revision = PluginPublicationRevision(
        request_id=second.id, requested_version="secret"
    )
    db.add(revision)
    db.flush()
    first.current_revision_id = revision.id
    db.add(
        PluginPublicationCheck(
            revision_id=revision.id,
            check_code="foreign",
            severity="blocker",
            status="failed",
        )
    )
    db.commit()
    db.expunge_all()
    with select_reads(db) as reads:
        result = PluginPublicationService().list_requests(
            db, user_id=owner_id, is_admin=False, page=1, limit=20
        )
    assert result.total == 1 and len(result.items) == 1
    item = result.items[0]
    assert (
        item.requestedVersion == "" and item.blockerCount == 0 and item.pluginName == ""
    )
    assert not any("FROM plugin_publication_checks" in sql for sql in reads)


def coalescing_case(db):
    now = datetime(2026, 1, 1)
    device = Kind(
        user_id=7,
        kind="Device",
        name="runtime",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "deviceType": "remote",
                "deviceId": "runtime",
                "appDeviceId": "electron",
            }
        },
    )
    db.add(device)
    for installed_id, alias, actual, timestamp in [
        (1, "electron", 2, now),
        (1, "runtime", 3, now),
        (2, "electron", 4, now + timedelta(seconds=1)),
        (2, "runtime", 5, now),
    ]:
        db.add(
            PluginDeviceInstallation(
                user_id=7,
                installed_kind_id=installed_id,
                device_id=alias,
                actual_release_id=actual,
                desired_release_id=5,
                state="installed",
                last_sync_at=timestamp,
                updated_at=now,
            )
        )
    db.commit()
    db.expunge_all()
    rows = (
        db.query(PluginDeviceInstallation)
        .order_by(PluginDeviceInstallation.device_id)
        .all()
    )
    with select_reads(db) as reads:
        snapshot = PluginDeviceSnapshot.load(
            db, ((row.user_id, row.device_id) for row in rows)
        )
        selected = coalesce_plugin_device_rows_resolved(rows, snapshot.resolve)
    assert len(reads) == 1
    assert {key: row.actual_release_id for key, row in selected.items()} == {
        (1, "runtime"): 3,
        (2, "runtime"): 4,
    }
    assert {key: row.id for key, row in selected.items()} == {
        key: row.id for key, row in coalesce_plugin_device_rows(db, rows).items()
    }
    db.query(PluginDeviceInstallation).delete()
    db.commit()
    response = InstalledPluginListResponse(items=[installed_item(1, 42, 1)])
    with select_reads(db) as reads:
        enrich_plugin_installations(db, response, device_id="unknown")
    assert len(reads) == 1 and response.items[0].spec.installState == "not_installed"
