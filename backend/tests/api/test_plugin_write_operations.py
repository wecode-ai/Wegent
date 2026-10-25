"""Account writes remain authoritative when later device coordination is busy."""

import io
import json
import time
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, Mock

import anyio
import pytest
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.background import BackgroundTask

from app.api.dependencies import get_db
from app.api.endpoints import installed_plugins as endpoints
from app.core.security import get_current_user
from app.db.base import Base
from app.models.kind import Kind
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
)
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services import plugin_device_sync
from app.services import plugin_write_coordination as coordination
from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
from app.services.device_service import device_service
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service as installations,
)
from app.services.plugin_marketplace_identity import OFFICIAL_CATALOG_NAMESPACE
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_write_errors import PluginWriteError

DEVICE_ID = "write-regression-device"
PLUGIN_KEY = "write-regression-plugin"
LEGACY_KEY = "write-regression-legacy"
ENTRIES = ("marketplace", "builtin", "legacy", "release", "state")
FAULT_CODES = ("plugin_write_busy", "plugin_write_unavailable")


def plugin_archive() -> bytes:
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps({"name": LEGACY_KEY, "version": "1.0.0"}),
        )
    return package.getvalue()


@dataclass
class PluginRequests:
    client: TestClient
    sessions: sessionmaker
    user_id: int
    plugin_id: int
    release_id: int
    upgraded_release_id: int
    remote_calls: list[str]
    targeted_calls: list[int]
    background_tasks: list[BackgroundTask]
    installed_id: int | None = None

    def run_background(self) -> None:
        tasks = self.background_tasks[:]
        self.background_tasks.clear()
        for task in tasks:
            anyio.run(task)

    def seed_update(self) -> None:
        with self.sessions() as db:
            installed = plugin_marketplace_service.install(
                db, user_id=self.user_id, plugin_id=self.plugin_id
            )
            self.installed_id = int(installed.metadata["labels"]["id"])

    def write(self, entry: str, *, device_id: str | None = DEVICE_ID):
        params = {"device_id": device_id} if device_id is not None else {}
        if entry == "marketplace":
            return self.client.post(
                f"/plugins/marketplace/{self.plugin_id}/install",
                params=params,
            )
        if entry in {"builtin", "legacy"}:
            key = LEGACY_KEY if entry == "legacy" else PLUGIN_KEY
            return self.client.post(
                f"/plugins/builtin/{key}/ensure-installed",
                json={"device_id": device_id},
            )
        payload = (
            {"releaseId": self.upgraded_release_id}
            if entry == "release"
            else {"componentStates": {"review": False}}
        )
        return self.client.put(
            f"/plugins/installed/{self.installed_id}",
            params=params,
            json=payload,
        )

    def account(self) -> Kind | None:
        with self.sessions() as db:
            return (
                db.query(Kind)
                .filter_by(
                    user_id=self.user_id,
                    kind="InstalledPlugin",
                    namespace="default",
                    is_active=True,
                )
                .one_or_none()
            )


@pytest.fixture
def plugin_requests(tmp_path, monkeypatch):
    from app.services import plugin_write_operations

    engine = create_engine(
        f"sqlite:///{tmp_path / 'plugin-operations.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False, autoflush=False)

    @contextmanager
    def worker_session():
        with sessions() as db:
            yield db

    monkeypatch.setattr(plugin_write_operations, "get_db_session", worker_session)
    monkeypatch.setattr(plugin_device_sync, "get_db_session", worker_session)
    with sessions.begin() as db:
        user = User(user_name="plugin-operations", password_hash="unused")
        db.add(user)
        db.flush()
        user_id = user.id
        plugin = Plugin(
            catalog_namespace=OFFICIAL_CATALOG_NAMESPACE,
            slug=PLUGIN_KEY,
            name=PLUGIN_KEY,
            display_name="Write Regression",
            owner_user_id=user_id,
            status="published",
            visibility="public",
        )
        db.add(plugin)
        db.flush()
        releases = [
            PluginRelease(
                plugin_id=plugin.id,
                version=version,
                manifest_json={},
                interface_json={},
                storage_key=f"regression/{version}.zip",
                sha256="a" * 64,
                size_bytes=1,
                status="ready",
                scan_status="passed",
                scan_report_json={"components": {}},
            )
            for version in ("1.0.0", "2.0.0")
        ]
        db.add_all(releases)
        db.flush()
        plugin.latest_release_id = releases[0].id
        db.add(
            Kind(
                user_id=user_id,
                kind="Device",
                namespace="default",
                name=DEVICE_ID,
                json={
                    "spec": {
                        "deviceType": "local",
                        "deviceId": DEVICE_ID,
                        "runtimeInstanceId": "regression-instance",
                    }
                },
            )
        )
    with sessions() as db:
        installed_plugin_service.publish_marketplace_plugin(
            db=db,
            user_id=BUILTIN_PLUGIN_OWNER_ID,
            package_bytes=plugin_archive(),
            filename="legacy.zip",
            visibility="workspace",
        )
    remote_calls: list[str] = []
    targeted_calls: list[int] = []
    background_tasks: list[BackgroundTask] = []

    async def capture_background(tasks: BackgroundTasks) -> None:
        # TestClient normally completes background work before returning a response.
        background_tasks.extend(tasks.tasks)

    monkeypatch.setattr(BackgroundTasks, "__call__", capture_background)

    def device_result(db, *, report_plugins: bool) -> DeviceCapabilitySyncResult:
        rows = db.query(Kind).filter_by(
            user_id=user_id, kind="InstalledPlugin", is_active=True
        )
        return DeviceCapabilitySyncResult(
            device_id=DEVICE_ID,
            success=True,
            plugins=(
                [{"id": row.id, "name": row.name, "status": "synced"} for row in rows]
                if report_plugins
                else []
            ),
        )

    async def global_sync(db, **_kwargs):
        remote_calls.append("global")
        result = device_result(db, report_plugins=False)
        return DeviceCapabilitySyncResponse(
            mode="replace", success=True, results=[result], synced=1
        )

    async def plugin_sync(db, *, user_id, installed_plugin_id, device_id):
        assert user_id == user.id
        assert device_id == DEVICE_ID
        targeted_calls.append(installed_plugin_id)
        remote_calls.append("plugin")
        result = device_result(db, report_plugins=True)
        return DeviceCapabilitySyncResponse(
            mode="merge",
            success=True,
            results=[result],
            plugins=result.plugins,
            synced=1,
        )

    async def current_sync(**_kwargs):
        remote_calls.append("recovery")
        with sessions() as db:
            return device_result(db, report_plugins=True)

    monkeypatch.setattr(
        device_service,
        "get_all_devices",
        AsyncMock(return_value=[{"device_id": DEVICE_ID}]),
    )
    sync_service = endpoints.device_capability_sync_service
    monkeypatch.setattr(sync_service, "sync_user_global_capabilities", global_sync)
    monkeypatch.setattr(sync_service, "sync_installed_plugin_to_device", plugin_sync)
    monkeypatch.setattr(sync_service, "sync_current_device_capabilities", current_sync)
    monkeypatch.setattr(
        "app.services.device.plugin_change_sync.sync_changed_plugin_to_devices",
        AsyncMock(
            side_effect=AssertionError("Request must not fan out to all devices")
        ),
    )

    def request_db():
        with sessions() as db:
            yield db

    app = FastAPI()
    app.include_router(endpoints.router, prefix="/plugins")
    app.dependency_overrides[get_db] = request_db
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        with TestClient(app) as client:
            yield PluginRequests(
                client,
                sessions,
                user_id,
                plugin.id,
                releases[0].id,
                releases[1].id,
                remote_calls,
                targeted_calls,
                background_tasks,
            )
    finally:
        engine.dispose()


def assert_account_write(context: PluginRequests, entry: str) -> Kind:
    account = context.account()
    assert account is not None
    spec = account.json["spec"]
    if entry == "release":
        assert spec["releaseId"] == context.upgraded_release_id
    elif entry == "state":
        assert spec["componentStates"] == {"review": False}
    elif entry == "legacy":
        assert spec["source"]["pluginKey"] == LEGACY_KEY
    else:
        assert spec["releaseId"] == context.release_id
    return account


@pytest.mark.parametrize("entry", ENTRIES)
def test_normal_account_write_materializes_the_device(plugin_requests, entry):
    context = plugin_requests
    if entry in {"release", "state"}:
        context.seed_update()

    response = context.write(entry)

    assert response.status_code == 200, response.text
    account = assert_account_write(context, entry)
    assert context.remote_calls == ["plugin"]
    assert context.targeted_calls == [account.id]
    assert len(context.background_tasks) == 1
    if entry != "legacy":
        with context.sessions() as db:
            device = (
                db.query(PluginDeviceInstallation)
                .filter_by(user_id=context.user_id, installed_kind_id=account.id)
                .one()
            )
            assert device.state == "installed"
            assert device.actual_release_id == account.json["spec"]["releaseId"]
    context.run_background()
    assert context.remote_calls == ["plugin", "global"]


def test_uploaded_plugin_update_targets_the_changed_plugin(plugin_requests):
    context = plugin_requests
    with context.sessions() as db:
        installed = installed_plugin_service.upload_plugin(
            db=db,
            user_id=context.user_id,
            package_bytes=plugin_archive(),
            filename="uploaded.zip",
        )
        context.installed_id = int(installed.metadata["labels"]["id"])

    response = context.write("state")

    assert response.status_code == 200, response.text
    assert_account_write(context, "state")
    assert context.targeted_calls == [context.installed_id]
    assert context.remote_calls == ["plugin"]
    assert len(context.background_tasks) == 1
    context.run_background()
    assert context.remote_calls == ["plugin", "global"]


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("code", FAULT_CODES)
def test_coordination_failure_before_account_commit_is_fail_closed(
    plugin_requests, monkeypatch, entry, code
):
    context = plugin_requests
    if entry in {"release", "state"}:
        context.seed_update()
    previous = context.account()
    previous_payload = previous.json if previous is not None else None

    def unavailable():
        raise ConnectionError("coordination unavailable")

    if code == "plugin_write_unavailable":
        monkeypatch.setattr(coordination, "_redis_client", unavailable)
    else:
        redis = coordination._redis_client()
        with redis.mutex:
            redis.values[f"wegent:plugin-write:{context.user_id}"] = (
                "another-owner",
                time.monotonic() + 30,
            )
        monkeypatch.setattr(coordination, "WAIT_SECONDS", 0)

    response = context.write(entry)

    assert response.status_code == 503
    assert response.json() == {"detail": code}
    current = context.account()
    assert (current.json if current is not None else None) == previous_payload
    assert context.remote_calls == []
    assert context.background_tasks == []


@pytest.mark.parametrize(
    ("entry", "stage", "device_id"),
    [
        (entry, stage, DEVICE_ID)
        for entry in ENTRIES
        for stage in ("prepare", "global_ack", "plugin_ack")
        if entry != "legacy" or stage == "plugin_ack"
    ]
    + [("legacy", "global_ack", None)],
)
@pytest.mark.parametrize("code", FAULT_CODES)
def test_device_coordination_failure_preserves_account_commit_and_recovers(
    plugin_requests, monkeypatch, entry, stage, device_id, code
):
    context = plugin_requests
    if entry in {"release", "state"}:
        context.seed_update()
    observed: list[str] = []
    prepare = installations._ensure_pending_for_devices
    record = installations.record_sync_response
    record_plugin = installations.record_plugin_sync_response
    deferred = Mock(wraps=plugin_device_sync.deferred_plugin_sync)

    def fail_committed_stage():
        assert_account_write(context, entry)
        observed.append(stage)
        raise PluginWriteError(code)

    def prepare_write(*args: Any, **kwargs: Any):
        if stage == "prepare":
            fail_committed_stage()
        return prepare(*args, **kwargs)

    def record_write(*args: Any, **kwargs: Any):
        if stage == "global_ack":
            fail_committed_stage()
        return record(*args, **kwargs)

    def record_plugin_write(*args: Any, **kwargs: Any):
        if stage == "plugin_ack":
            fail_committed_stage()
        return record_plugin(*args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(installations, "_ensure_pending_for_devices", prepare_write)
        fault.setattr(installations, "record_sync_response", record_write)
        fault.setattr(installations, "record_plugin_sync_response", record_plugin_write)
        fault.setattr(plugin_device_sync, "deferred_plugin_sync", deferred)

        response = context.write(entry, device_id=device_id)

        assert response.status_code == 200, response.text
        assert len(context.background_tasks) == 1
        if stage == "global_ack":
            assert observed == []
            if entry in {"marketplace", "builtin", "legacy"}:
                sync = response.json()["sync"]
                if device_id is None:
                    assert sync is None
                else:
                    assert sync["success"] is True
            context.run_background()

    assert observed == [stage]
    deferred.assert_called_once()
    assert deferred.call_args.args[0].code == code
    assert deferred.call_args.kwargs["stage"] == stage
    account = assert_account_write(context, entry)
    if entry == "legacy":
        assert context.remote_calls == ["plugin" if device_id else "global"]
    if stage != "global_ack" and entry in {"marketplace", "builtin", "legacy"}:
        sync = response.json()["sync"]
        assert sync["success"] is False
        assert sync["failed"] >= 1
        assert any(
            error["code"] == code and error["stage"] == stage
            for error in sync["errors"]
        )

    recovered = context.client.post(
        "/plugins/installed/sync-device", params={"device_id": DEVICE_ID}
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["sync"]["success"] is True
    with context.sessions() as db:
        devices = (
            db.query(PluginDeviceInstallation)
            .filter_by(user_id=context.user_id, installed_kind_id=account.id)
            .all()
        )
        if entry == "legacy":
            assert devices == []
        else:
            assert len(devices) == 1
            assert devices[0].state == "installed"
            assert devices[0].actual_release_id == account.json["spec"]["releaseId"]
    assert assert_account_write(context, entry).json == account.json


@pytest.mark.parametrize(
    ("entry", "device_id"),
    [(entry, DEVICE_ID) for entry in ENTRIES] + [("legacy", None)],
)
@pytest.mark.parametrize(
    "code", (*FAULT_CODES, "plugin_write_lease_lost", "plugin_write_conflict")
)
def test_snapshot_coordination_failure_preserves_commit_without_retrying_device(
    plugin_requests, monkeypatch, entry, device_id, code
):
    context = plugin_requests
    if entry in {"release", "state"}:
        context.seed_update()
    with context.sessions.begin() as db:
        unrelated = Kind(
            user_id=context.user_id,
            kind="InstalledPlugin",
            namespace="default",
            name="unrelated-removal",
            is_active=False,
            json={"spec": {"installState": "uninstalled"}},
        )
        db.add(unrelated)
        db.flush()
        pending = PluginDeviceInstallation(
            user_id=context.user_id,
            installed_kind_id=unrelated.id,
            device_id=DEVICE_ID,
            desired_release_id=context.release_id,
            actual_release_id=context.release_id,
            state="uninstalling",
            attempt_count=2,
            error_message="previous removal failed",
        )
        db.add(pending)
        db.flush()
        unrelated_id = pending.id

    async def reject_snapshot(*_args, **_kwargs):
        assert_account_write(context, entry)
        raise PluginWriteError(code)

    snapshot = AsyncMock(side_effect=reject_snapshot)
    record = Mock(wraps=installations.record_sync_response)
    record_plugin = Mock(wraps=installations.record_plugin_sync_response)
    deferred = Mock(wraps=plugin_device_sync.deferred_plugin_sync)
    monkeypatch.setattr(
        "app.services.device.plugin_change_sync.sync_changed_plugin_to_devices",
        snapshot,
    )
    monkeypatch.setattr(
        endpoints.device_capability_sync_service,
        "sync_installed_plugin_to_device",
        snapshot,
    )
    if device_id is None:
        monkeypatch.setattr(
            endpoints.device_capability_sync_service,
            "sync_user_global_capabilities",
            snapshot,
        )
    monkeypatch.setattr(installations, "record_sync_response", record)
    monkeypatch.setattr(installations, "record_plugin_sync_response", record_plugin)
    monkeypatch.setattr(plugin_device_sync, "deferred_plugin_sync", deferred)

    response = context.write(entry, device_id=device_id)

    assert response.status_code == 200, response.text
    assert_account_write(context, entry)
    assert len(context.background_tasks) == 1
    if device_id is None:
        assert response.json()["sync"] is None
        snapshot.assert_not_awaited()
        context.run_background()
    snapshot.assert_awaited_once()
    deferred.assert_called_once()
    assert deferred.call_args.args[0].code == code
    assert deferred.call_args.kwargs["stage"] == "snapshot"
    record.assert_not_called()
    record_plugin.assert_not_called()
    assert context.remote_calls == []
    if device_id is not None and entry in {"marketplace", "builtin", "legacy"}:
        sync = response.json()["sync"]
        assert sync["success"] is False
        assert sync["failed"] >= 1
        assert sync["errors"] == [{"code": code, "stage": "snapshot"}]
    with context.sessions() as db:
        pending = db.get(PluginDeviceInstallation, unrelated_id)
        assert pending is not None
        assert pending.state == "uninstalling"
        assert pending.actual_release_id == context.release_id
        assert pending.desired_release_id == context.release_id
        assert pending.attempt_count == 2
        assert pending.error_message == "previous removal failed"
