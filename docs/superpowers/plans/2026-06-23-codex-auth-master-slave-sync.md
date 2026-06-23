# Codex Auth Master Slave Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement user-controlled Codex `auth.json` master/slave sync where the master device is read-only source and slave devices are overwritten.

**Architecture:** Keep encrypted auth content in the existing `UserRuntimeConfig/codex` Kind and store non-secret topology in `users.preferences.runtime_configs.codex.auth_sync`. Executor heartbeat reports auth `sha256` and `modified_at`; Backend compares master heartbeat metadata with saved auth metadata, imports only newer master files, and syncs saved auth to slave devices using an explicit overwrite command flag. Wework exposes a compact master/slave selector in the existing Codex auth settings page.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, Socket.IO device namespace, Python executor, pytest, Tauri/Vite React, TypeScript, Vitest, i18next.

---

## File Structure

- Modify `executor/modes/local/websocket_client.py`: add sanitized auth file digest and mtime metadata to heartbeat reports.
- Modify `executor/tests/test_local_websocket_client.py`: test missing and existing auth report shapes.
- Modify `backend/app/services/device/command_registry.py`: add opt-in overwrite mode to `sync_runtime_auth_file`.
- Modify `backend/tests/services/test_local_device_command_service.py`: prove default skip remains and overwrite mode replaces existing files.
- Modify `backend/app/services/user_runtime_config.py`: add auth sync preference helpers, source metadata, slave overwrite sync, and master/slave heartbeat sync orchestration.
- Modify `backend/tests/services/test_user_runtime_config_service.py`: cover auth sync preferences, slave overwrite sync, manual upload metadata, master import, and slave heartbeat resync.
- Modify `backend/app/api/ws/device_namespace.py`: schedule runtime auth sync on any Codex auth heartbeat report and delegate master/slave decisions to the service.
- Modify `backend/tests/api/ws/test_device_capabilities_state.py`: update heartbeat scheduling expectations.
- Modify `backend/app/api/endpoints/users.py`: add `auth_sync` request/response fields and trigger best-effort slave sync after settings updates or uploads.
- Modify `wework/src/api/users.ts`: add auth sync TypeScript types.
- Modify `wework/src/components/settings/RuntimeConfigSettingsPage.tsx`: add master/slave device controls with stable `data-testid` attributes.
- Modify `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`: cover the new UI flow.
- Modify `wework/src/i18n/locales/zh-CN/common.json` and `wework/src/i18n/locales/en/common.json`: add localized copy for the sync controls.
- Modify `wework/src/types/api.ts`: allow `auth_sync` in runtime preferences.
- Modify `docs/zh/developer-guide/user-runtime-config.md` first, then `docs/en/developer-guide/user-runtime-config.md`: document the new behavior.

## Task 1: Executor Auth Heartbeat Metadata

**Files:**
- Modify: `executor/tests/test_local_websocket_client.py:5-27`
- Modify: `executor/modes/local/websocket_client.py:32-72`

- [ ] **Step 1: Write the failing executor report test**

Replace `test_build_runtime_auth_file_report_reports_codex_auth_presence` in `executor/tests/test_local_websocket_client.py` with:

```python
def test_build_runtime_auth_file_report_reports_codex_auth_metadata(tmp_path):
    report = build_runtime_auth_file_report(home=tmp_path)

    assert report == {
        "codex": {
            "target_path": "~/.codex/auth.json",
            "exists": False,
        }
    }

    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    auth_file = codex_dir / "auth.json"
    auth_file.write_text('{"token":"secret"}', encoding="utf-8")

    existing_report = build_runtime_auth_file_report(home=tmp_path)["codex"]

    assert existing_report["target_path"] == "~/.codex/auth.json"
    assert existing_report["exists"] is True
    assert (
        existing_report["sha256"]
        == "1c987b9ac6f539f4fe2d6b6e592e28f9fdd8ec444d9d3794f6d1217835e582a1"
    )
    assert existing_report["modified_at"].endswith("+00:00")
```

- [ ] **Step 2: Run the executor test to verify it fails**

Run:

```bash
cd executor && uv run pytest tests/test_local_websocket_client.py::test_build_runtime_auth_file_report_reports_codex_auth_metadata -q
```

Expected: FAIL because the report for an existing auth file does not contain `sha256` or `modified_at`.

- [ ] **Step 3: Implement digest and mtime reporting**

In `executor/modes/local/websocket_client.py`, keep the existing imports and replace `build_runtime_auth_file_report()` with:

```python
def _auth_file_metadata(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {
            "target_path": CODEX_AUTH_TARGET_PATH,
            "exists": False,
        }

    stat = path.stat()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    modified_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    return {
        "target_path": CODEX_AUTH_TARGET_PATH,
        "exists": True,
        "sha256": digest,
        "modified_at": modified_at,
    }


def build_runtime_auth_file_report(
    home: Optional[Path] = None,
) -> dict[str, dict[str, Any]]:
    """Build sanitized local runtime auth file state for heartbeat reports."""
    home_dir = home or Path.home()
    codex_auth_path = home_dir / ".codex" / "auth.json"
    return {"codex": _auth_file_metadata(codex_auth_path)}
```

Also update the import line from:

```python
from pathlib import Path
```

to:

```python
from datetime import datetime, timezone
from pathlib import Path
```

- [ ] **Step 4: Run the executor test to verify it passes**

Run:

```bash
cd executor && uv run pytest tests/test_local_websocket_client.py::test_build_runtime_auth_file_report_reports_codex_auth_metadata -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add executor/modes/local/websocket_client.py executor/tests/test_local_websocket_client.py
git commit -m "feat(executor): report codex auth metadata"
```

## Task 2: Device Command Overwrite Flag

**Files:**
- Modify: `backend/tests/services/test_local_device_command_service.py:1418-1480`
- Modify: `backend/app/services/device/command_registry.py:622-693`

- [ ] **Step 1: Write the failing overwrite command test**

Add this test after `test_sync_runtime_auth_file_command_does_not_overwrite_existing_file` in `backend/tests/services/test_local_device_command_service.py`:

```python
def test_sync_runtime_auth_file_command_overwrites_existing_file_when_enabled(tmp_path):
    """sync_runtime_auth_file should overwrite auth JSON when overwrite is enabled."""
    from app.services.device.command_registry import SYNC_RUNTIME_AUTH_FILE_SCRIPT

    target = tmp_path / ".codex" / "auth.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"token":"existing"}\n', encoding="utf-8")
    target.chmod(0o644)
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "WEGENT_RUNTIME_CONFIG_RUNTIME": "codex",
        "WEGENT_RUNTIME_CONFIG_TARGET_PATH": "~/.codex/auth.json",
        "WEGENT_RUNTIME_CONFIG_CONTENT": '{"token":"new"}',
        "WEGENT_RUNTIME_CONFIG_OVERWRITE": "true",
    }

    result = subprocess.run(
        [sys.executable, "-c", SYNC_RUNTIME_AUTH_FILE_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {
        "status": "overwritten",
        "runtime": "codex",
        "path": "~/.codex/auth.json",
    }
    assert json.loads(target.read_text(encoding="utf-8")) == {"token": "new"}
    assert target.stat().st_mode & 0o777 == 0o600
```

- [ ] **Step 2: Run the overwrite command test to verify it fails**

Run:

```bash
cd backend && uv run pytest tests/services/test_local_device_command_service.py::test_sync_runtime_auth_file_command_overwrites_existing_file_when_enabled -q
```

Expected: FAIL because the command returns `skipped_existing` and leaves the old file content.

- [ ] **Step 3: Implement opt-in overwrite**

In `backend/app/services/device/command_registry.py`, replace the body of `SYNC_RUNTIME_AUTH_FILE_SCRIPT` from the `runtime = ...` line through the final `print(...)` with this script content:

```python
runtime = os.environ.get("WEGENT_RUNTIME_CONFIG_RUNTIME", "").strip()
target_path = os.environ.get("WEGENT_RUNTIME_CONFIG_TARGET_PATH", "").strip()
content = os.environ.get("WEGENT_RUNTIME_CONFIG_CONTENT", "")
overwrite = os.environ.get("WEGENT_RUNTIME_CONFIG_OVERWRITE", "").strip().lower() in {
    "1",
    "true",
    "yes",
}

if not runtime:
    fail("runtime is required")
if not target_path.startswith("~/"):
    fail("target path must be inside the user home directory")
if not content:
    fail("runtime config content is required")

try:
    parsed = json.loads(content)
except json.JSONDecodeError as exc:
    fail(f"runtime config content is not valid JSON: {exc}")
if not isinstance(parsed, dict):
    fail("runtime config content must be a JSON object")

home = Path.home().resolve()
target = Path(target_path).expanduser()
try:
    resolved_target = target.resolve(strict=False)
except OSError as exc:
    fail(f"failed to resolve target path: {exc}")

if home not in [resolved_target, *resolved_target.parents]:
    fail("target path must stay inside the user home directory")

if target.exists() and not overwrite:
    print(
        json.dumps(
            {"status": "skipped_existing", "runtime": runtime, "path": target_path},
            ensure_ascii=False,
        )
    )
    sys.exit(0)

target.parent.mkdir(parents=True, exist_ok=True)
payload = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True) + "\\n"

if overwrite:
    existed = target.exists()
    tmp_path = target.parent / f".{target.name}.tmp.{os.getpid()}"
    try:
        fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(str(tmp_path), str(target))
        os.chmod(str(target), 0o600)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
    status = "overwritten" if existed else "written"
else:
    try:
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print(
            json.dumps(
                {"status": "skipped_existing", "runtime": runtime, "path": target_path},
                ensure_ascii=False,
            )
        )
        sys.exit(0)

    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(payload)
    status = "written"

print(
    json.dumps(
        {"status": status, "runtime": runtime, "path": target_path},
        ensure_ascii=False,
    )
)
```

- [ ] **Step 4: Run command tests**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_local_device_command_service.py::test_sync_runtime_auth_file_command_writes_json_object \
  tests/services/test_local_device_command_service.py::test_sync_runtime_auth_file_command_does_not_overwrite_existing_file \
  tests/services/test_local_device_command_service.py::test_sync_runtime_auth_file_command_overwrites_existing_file_when_enabled -q
```

Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/device/command_registry.py backend/tests/services/test_local_device_command_service.py
git commit -m "feat(backend): allow runtime auth overwrite command"
```

## Task 3: Auth Sync Preferences

**Files:**
- Modify: `backend/tests/services/test_user_runtime_config_service.py:1-240`
- Modify: `backend/app/services/user_runtime_config.py:25-282,641-667`

- [ ] **Step 1: Write failing preference tests**

Add this helper after `_create_user()` in `backend/tests/services/test_user_runtime_config_service.py`:

```python
def _create_device(test_db: Session, user_id: int, device_id: str) -> Kind:
    device = Kind(
        user_id=user_id,
        kind="Device",
        namespace="default",
        name=device_id,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {"deviceId": device_id, "displayName": device_id},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()
    return device
```

Add these tests after `test_set_use_user_config_stores_preference`:

```python
def test_set_use_user_config_stores_auth_sync_preference(test_db: Session) -> None:
    user = _create_user(test_db, 1204)
    _create_device(test_db, user.id, "master-device")
    _create_device(test_db, user.id, "slave-a")
    _create_device(test_db, user.id, "slave-b")

    response = user_runtime_config_service.set_use_user_config(
        test_db,
        user=user,
        runtime="codex",
        use_user_config=True,
        auth_sync={
            "master_device_id": "master-device",
            "slave_device_ids": ["slave-a", "slave-b", "slave-a", ""],
        },
    )

    test_db.refresh(user)
    assert response["auth_sync"] == {
        "master_device_id": "master-device",
        "slave_device_ids": ["slave-a", "slave-b"],
    }
    assert json.loads(user.preferences)["runtime_configs"]["codex"]["auth_sync"] == {
        "master_device_id": "master-device",
        "slave_device_ids": ["slave-a", "slave-b"],
    }


def test_set_use_user_config_rejects_master_as_slave(test_db: Session) -> None:
    user = _create_user(test_db, 1205)
    _create_device(test_db, user.id, "same-device")

    with pytest.raises(UserRuntimeConfigError, match="master device cannot be a slave"):
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=user,
            runtime="codex",
            use_user_config=True,
            auth_sync={
                "master_device_id": "same-device",
                "slave_device_ids": ["same-device"],
            },
        )


def test_set_use_user_config_rejects_unknown_auth_sync_device(test_db: Session) -> None:
    user = _create_user(test_db, 1206)
    _create_device(test_db, user.id, "master-device")

    with pytest.raises(UserRuntimeConfigError, match="unknown auth sync device"):
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=user,
            runtime="codex",
            use_user_config=True,
            auth_sync={
                "master_device_id": "master-device",
                "slave_device_ids": ["missing-device"],
            },
        )
```

- [ ] **Step 2: Run preference tests to verify they fail**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_stores_auth_sync_preference \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_rejects_master_as_slave \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_rejects_unknown_auth_sync_device -q
```

Expected: FAIL because `set_use_user_config()` does not accept `auth_sync` and responses do not include `auth_sync`.

- [ ] **Step 3: Implement auth sync preference helpers**

In `backend/app/services/user_runtime_config.py`, add this constant after `USER_RUNTIME_CONFIG_PREFERENCE_KEY`:

```python
AUTH_SYNC_PREFERENCE_KEY = "auth_sync"
```

Add these helper functions after `is_runtime_proxy_enabled()`:

```python
def _dedupe_device_ids(device_ids: Iterable[Any]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for raw_device_id in device_ids:
        device_id = str(raw_device_id or "").strip()
        if not device_id or device_id in seen:
            continue
        seen.add(device_id)
        normalized.append(device_id)
    return normalized


def get_runtime_auth_sync(preferences: Any, runtime: str) -> dict[str, Any]:
    """Return normalized auth sync topology for a runtime."""
    normalized_runtime = _normalize_runtime(runtime)
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        return {"master_device_id": None, "slave_device_ids": []}
    config = runtime_configs.get(normalized_runtime) or {}
    if not isinstance(config, dict):
        return {"master_device_id": None, "slave_device_ids": []}
    auth_sync = config.get(AUTH_SYNC_PREFERENCE_KEY) or {}
    if not isinstance(auth_sync, dict):
        return {"master_device_id": None, "slave_device_ids": []}
    master_device_id = str(auth_sync.get("master_device_id") or "").strip() or None
    slave_device_ids = _dedupe_device_ids(auth_sync.get("slave_device_ids") or [])
    if master_device_id:
        slave_device_ids = [
            device_id for device_id in slave_device_ids if device_id != master_device_id
        ]
    return {
        "master_device_id": master_device_id,
        "slave_device_ids": slave_device_ids,
    }


def _normalize_auth_sync_input(auth_sync: Any) -> dict[str, Any]:
    if auth_sync is None:
        return {"master_device_id": None, "slave_device_ids": []}
    if not isinstance(auth_sync, dict):
        raise UserRuntimeConfigError("auth_sync must be an object")
    master_device_id = str(auth_sync.get("master_device_id") or "").strip() or None
    slave_device_ids = _dedupe_device_ids(auth_sync.get("slave_device_ids") or [])
    if master_device_id and master_device_id in slave_device_ids:
        raise UserRuntimeConfigError("master device cannot be a slave")
    return {
        "master_device_id": master_device_id,
        "slave_device_ids": slave_device_ids,
    }


def _known_device_ids(db: Session, user_id: int) -> set[str]:
    rows = (
        db.query(Kind.name)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Device",
            Kind.namespace == USER_RUNTIME_CONFIG_NAMESPACE,
            Kind.is_active.is_(True),
        )
        .all()
    )
    return {str(row[0]) for row in rows if row and row[0]}


def _validate_auth_sync_devices(
    db: Session,
    *,
    user_id: int,
    auth_sync: dict[str, Any],
) -> None:
    selected = {
        device_id
        for device_id in [
            auth_sync.get("master_device_id"),
            *auth_sync.get("slave_device_ids", []),
        ]
        if device_id
    }
    if not selected:
        return
    missing = sorted(selected - _known_device_ids(db, user_id))
    if missing:
        raise UserRuntimeConfigError(
            f"unknown auth sync device: {', '.join(missing)}"
        )
```

Replace `set_runtime_user_config_enabled()` with:

```python
def set_runtime_user_config_enabled(
    preferences: Any,
    runtime: str,
    enabled: bool,
    use_proxy: Optional[bool] = None,
    auth_sync: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Return preferences with the runtime config enablement updated."""
    normalized_runtime = _normalize_runtime(runtime)
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        runtime_configs = {}
    runtime_config = dict(runtime_configs.get(normalized_runtime) or {})
    runtime_config["use_user_config"] = bool(enabled)
    if use_proxy is not None:
        runtime_config["use_proxy"] = bool(use_proxy)
    if auth_sync is not None:
        runtime_config[AUTH_SYNC_PREFERENCE_KEY] = _normalize_auth_sync_input(auth_sync)
    runtime_configs[normalized_runtime] = runtime_config
    parsed[USER_RUNTIME_CONFIG_PREFERENCE_KEY] = runtime_configs
    return parsed
```

Update `UserRuntimeConfigService.set_use_user_config()` signature and body:

```python
def set_use_user_config(
    self,
    db: Session,
    *,
    user: User,
    runtime: str,
    use_user_config: bool,
    use_proxy: Optional[bool] = None,
    auth_sync: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Update whether the runtime should use this user's saved config."""
    normalized_runtime = _normalize_runtime(runtime)
    normalized_auth_sync = (
        _normalize_auth_sync_input(auth_sync) if auth_sync is not None else None
    )
    if normalized_auth_sync is not None:
        _validate_auth_sync_devices(
            db,
            user_id=user.id,
            auth_sync=normalized_auth_sync,
        )
    preferences = set_runtime_user_config_enabled(
        user.preferences,
        normalized_runtime,
        use_user_config,
        use_proxy,
        normalized_auth_sync,
    )
    proxy_kind = self._get_proxy_kind(db, user_id=user.id)
    if use_proxy is True and not self._get_proxy_url(proxy_kind):
        raise UserRuntimeConfigError("proxy is not configured")

    user.preferences = json.dumps(preferences)
    db.add(user)
    db.commit()
    db.refresh(user)
    kind = self._get_kind(db, user_id=user.id, runtime=normalized_runtime)
    proxy_kind = self._get_proxy_kind(db, user_id=user.id)
    return self._build_response(
        normalized_runtime,
        kind,
        user.preferences,
        proxy_kind=proxy_kind,
    )
```

In `_build_response()`, add this field before `"updated_at"`:

```python
"auth_sync": get_runtime_auth_sync(preferences, runtime),
```

- [ ] **Step 4: Run preference tests to verify they pass**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_stores_auth_sync_preference \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_rejects_master_as_slave \
  tests/services/test_user_runtime_config_service.py::test_set_use_user_config_rejects_unknown_auth_sync_device -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/user_runtime_config.py backend/tests/services/test_user_runtime_config_service.py
git commit -m "feat(backend): store codex auth sync topology"
```

## Task 4: Slave Overwrite Sync and Source Metadata

**Files:**
- Modify: `backend/tests/services/test_user_runtime_config_service.py:63-340`
- Modify: `backend/app/services/user_runtime_config.py:343-536`

- [ ] **Step 1: Write failing slave sync tests**

Add these tests after `test_sync_auth_to_devices_preserves_skipped_existing_status`:

```python
@pytest.mark.asyncio
async def test_sync_auth_to_devices_can_overwrite_selected_devices(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1301,
        runtime="codex",
        auth_json='{"token":"secret"}',
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [{"device_id": "slave-a", "status": "online"}]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "stdout": {
                "status": "overwritten",
                "runtime": "codex",
                "path": "~/.codex/auth.json",
            },
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module.device_service,
        "get_online_devices",
        fake_get_online_devices,
    )
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    result = await user_runtime_config_service.sync_auth_to_devices(
        test_db,
        user_id=1301,
        runtime="codex",
        preferences={"runtime_configs": {"codex": {"use_user_config": True}}},
        device_ids=["slave-a"],
        overwrite=True,
    )

    assert result["items"][0]["status"] == "overwritten"
    assert calls[0]["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true"


@pytest.mark.asyncio
async def test_sync_auth_to_slave_devices_excludes_master(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preferences = {
        "runtime_configs": {
            "codex": {
                "use_user_config": True,
                "auth_sync": {
                    "master_device_id": "master-device",
                    "slave_device_ids": ["slave-a", "slave-b"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1302,
        runtime="codex",
        auth_json='{"token":"secret"}',
        preferences=preferences,
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [
            {"device_id": "master-device", "status": "online"},
            {"device_id": "slave-a", "status": "online"},
            {"device_id": "slave-b", "status": "online"},
        ]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "stdout": {"status": "overwritten"},
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module.device_service,
        "get_online_devices",
        fake_get_online_devices,
    )
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    result = await user_runtime_config_service.sync_auth_to_slave_devices(
        test_db,
        user_id=1302,
        runtime="codex",
        preferences=preferences,
    )

    assert result["total"] == 2
    assert [call["device_id"] for call in calls] == ["slave-a", "slave-b"]
    assert all(call["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true" for call in calls)


def test_save_auth_json_records_source_metadata(test_db: Session) -> None:
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1303,
        runtime="codex",
        auth_json='{"token":"from-master"}',
        source_device_id="master-device",
        source_modified_at="2026-06-23T00:00:00+00:00",
    )

    kind = _get_codex_kind(test_db, 1303)
    auth = kind.json["spec"]["auth"]
    assert auth["sourceDeviceId"] == "master-device"
    assert auth["sourceModifiedAt"] == "2026-06-23T00:00:00+00:00"
```

- [ ] **Step 2: Run slave sync tests to verify they fail**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_to_devices_can_overwrite_selected_devices \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_to_slave_devices_excludes_master \
  tests/services/test_user_runtime_config_service.py::test_save_auth_json_records_source_metadata -q
```

Expected: FAIL because `overwrite`, `sync_auth_to_slave_devices`, and source metadata arguments do not exist.

- [ ] **Step 3: Implement overwrite sync and metadata**

Update `save_auth_json()` signature:

```python
def save_auth_json(
    self,
    db: Session,
    *,
    user_id: int,
    runtime: str,
    auth_json: str,
    preferences: Any = None,
    source_device_id: Optional[str] = None,
    source_modified_at: Optional[str] = None,
) -> dict[str, Any]:
```

In the `spec["auth"] = {...}` payload, add:

```python
"sourceDeviceId": source_device_id,
"sourceModifiedAt": source_modified_at,
```

Update `sync_auth_to_devices()` signature and docstring:

```python
async def sync_auth_to_devices(
    self,
    db: Session,
    *,
    user_id: int,
    runtime: str,
    preferences: Any = None,
    device_ids: Optional[Iterable[str]] = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Sync a saved auth file to selected online devices."""
```

Pass `overwrite=overwrite` into `_sync_auth_to_device()`.

Update `_sync_auth_to_device()` signature:

```python
overwrite: bool = False,
```

Build the command environment with:

```python
env = {
    "WEGENT_RUNTIME_CONFIG_RUNTIME": runtime,
    "WEGENT_RUNTIME_CONFIG_TARGET_PATH": target_path,
    "WEGENT_RUNTIME_CONFIG_CONTENT": auth_json,
}
if overwrite:
    env["WEGENT_RUNTIME_CONFIG_OVERWRITE"] = "true"
```

Then pass `env=env` to `execute_configured_device_command()`.

Add this method to `UserRuntimeConfigService` after `sync_auth_to_devices()`:

```python
async def sync_auth_to_slave_devices(
    self,
    db: Session,
    *,
    user_id: int,
    runtime: str,
    preferences: Any = None,
) -> dict[str, Any]:
    """Overwrite saved auth to configured slave devices only."""
    normalized_runtime = _normalize_runtime(runtime)
    auth_sync = get_runtime_auth_sync(preferences, normalized_runtime)
    slave_device_ids = list(auth_sync["slave_device_ids"])
    if not slave_device_ids:
        target_path = RUNTIME_AUTH_FILES[normalized_runtime]["target_path"]
        return {
            "runtime": normalized_runtime,
            "target_path": target_path,
            "total": 0,
            "items": [],
        }

    return await self.sync_auth_to_devices(
        db,
        user_id=user_id,
        runtime=normalized_runtime,
        preferences=preferences,
        device_ids=slave_device_ids,
        overwrite=True,
    )
```

- [ ] **Step 4: Run slave sync tests to verify they pass**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_to_devices_preserves_skipped_existing_status \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_to_devices_can_overwrite_selected_devices \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_to_slave_devices_excludes_master \
  tests/services/test_user_runtime_config_service.py::test_save_auth_json_records_source_metadata -q
```

Expected: PASS, including the existing default skip behavior test.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/user_runtime_config.py backend/tests/services/test_user_runtime_config_service.py
git commit -m "feat(backend): sync codex auth to slave devices"
```

## Task 5: Master and Slave Heartbeat Sync

**Files:**
- Modify: `backend/tests/services/test_user_runtime_config_service.py:1-380`
- Modify: `backend/tests/api/ws/test_device_capabilities_state.py:70-167`
- Modify: `backend/app/services/user_runtime_config.py:1-536`
- Modify: `backend/app/api/ws/device_namespace.py:487-494,1122-1212,1286-1290`

- [ ] **Step 1: Write failing service heartbeat tests**

Add `from datetime import datetime, timezone` to `backend/tests/services/test_user_runtime_config_service.py`.

Add these tests after `test_save_auth_json_records_source_metadata`:

```python
@pytest.mark.asyncio
async def test_sync_auth_for_heartbeat_imports_newer_master_and_syncs_slaves(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preferences = {
        "runtime_configs": {
            "codex": {
                "use_user_config": True,
                "auth_sync": {
                    "master_device_id": "master-device",
                    "slave_device_ids": ["slave-device"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1401,
        runtime="codex",
        auth_json='{"token":"old"}',
        preferences=preferences,
        source_device_id="master-device",
        source_modified_at="2026-06-22T00:00:00+00:00",
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [
            {"device_id": "master-device", "status": "online"},
            {"device_id": "slave-device", "status": "online"},
        ]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        if kwargs["command_key"] == "read_runtime_auth_file":
            return {
                "success": True,
                "stdout": {
                    "status": "read",
                    "runtime": "codex",
                    "path": "~/.codex/auth.json",
                    "content": '{"token":"new"}',
                },
                "stderr": "",
            }
        return {
            "success": True,
            "stdout": {"status": "overwritten"},
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module.device_service,
        "get_online_devices",
        fake_get_online_devices,
    )
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    result = await user_runtime_config_service.sync_auth_for_heartbeat_device(
        test_db,
        user_id=1401,
        runtime="codex",
        device_id="master-device",
        runtime_auth_files={
            "codex": {
                "exists": True,
                "sha256": "different",
                "modified_at": "2026-06-23T00:00:00+00:00",
            }
        },
        preferences=preferences,
    )

    kind = _get_codex_kind(test_db, 1401)
    auth = kind.json["spec"]["auth"]
    assert result["status"] == "master_imported"
    assert json.loads(decrypt_sensitive_data(auth["encryptedValue"])) == {"token": "new"}
    assert auth["sourceDeviceId"] == "master-device"
    assert auth["sourceModifiedAt"] == "2026-06-23T00:00:00+00:00"
    assert [call["command_key"] for call in calls] == [
        "read_runtime_auth_file",
        "sync_runtime_auth_file",
    ]
    assert calls[1]["device_id"] == "slave-device"
    assert calls[1]["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true"


@pytest.mark.asyncio
async def test_sync_auth_for_heartbeat_ignores_older_master_report(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preferences = {
        "runtime_configs": {
            "codex": {
                "use_user_config": True,
                "auth_sync": {"master_device_id": "master-device", "slave_device_ids": []},
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1402,
        runtime="codex",
        auth_json='{"token":"current"}',
        preferences=preferences,
        source_device_id="master-device",
        source_modified_at="2026-06-23T00:00:00+00:00",
    )
    execute_command = pytest.fail
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        execute_command,
    )

    result = await user_runtime_config_service.sync_auth_for_heartbeat_device(
        test_db,
        user_id=1402,
        runtime="codex",
        device_id="master-device",
        runtime_auth_files={
            "codex": {
                "exists": True,
                "sha256": "different",
                "modified_at": "2026-06-22T23:59:59+00:00",
            }
        },
        preferences=preferences,
    )

    assert result["status"] == "master_not_newer"


@pytest.mark.asyncio
async def test_sync_auth_for_heartbeat_overwrites_slave_device(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preferences = {
        "runtime_configs": {
            "codex": {
                "use_user_config": True,
                "auth_sync": {
                    "master_device_id": "master-device",
                    "slave_device_ids": ["slave-device"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1403,
        runtime="codex",
        auth_json='{"token":"saved"}',
        preferences=preferences,
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [{"device_id": "slave-device", "status": "online"}]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "stdout": {"status": "overwritten"},
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module.device_service,
        "get_online_devices",
        fake_get_online_devices,
    )
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    result = await user_runtime_config_service.sync_auth_for_heartbeat_device(
        test_db,
        user_id=1403,
        runtime="codex",
        device_id="slave-device",
        runtime_auth_files={"codex": {"exists": True}},
        preferences=preferences,
    )

    assert result["status"] == "slave_synced"
    assert calls[0]["device_id"] == "slave-device"
    assert calls[0]["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true"
```

- [ ] **Step 2: Run service heartbeat tests to verify they fail**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_imports_newer_master_and_syncs_slaves \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_ignores_older_master_report \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_overwrites_slave_device -q
```

Expected: FAIL because `sync_auth_for_heartbeat_device()` does not exist.

- [ ] **Step 3: Implement heartbeat sync service logic**

In `backend/app/services/user_runtime_config.py`, replace the datetime import with:

```python
from datetime import datetime, timezone
```

Add these helpers before `class UserRuntimeConfigService`:

```python
def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _runtime_auth_report(runtime_auth_files: Any, runtime: str) -> dict[str, Any]:
    if not isinstance(runtime_auth_files, dict):
        return {}
    report = runtime_auth_files.get(runtime)
    return report if isinstance(report, dict) else {}


def _is_master_report_newer(report: dict[str, Any], auth: dict[str, Any]) -> bool:
    if report.get("exists") is not True:
        return False
    report_sha256 = str(report.get("sha256") or "").strip()
    report_modified_at = _parse_iso_datetime(report.get("modified_at"))
    if not report_sha256 or report_modified_at is None:
        return False
    if report_sha256 == auth.get("sha256"):
        return False
    baseline = _parse_iso_datetime(auth.get("sourceModifiedAt")) or _parse_iso_datetime(
        auth.get("updatedAt")
    )
    return baseline is None or report_modified_at > baseline
```

Add this method to `UserRuntimeConfigService` after `sync_auth_to_slave_devices()`:

```python
async def sync_auth_for_heartbeat_device(
    self,
    db: Session,
    *,
    user_id: int,
    runtime: str,
    device_id: str,
    runtime_auth_files: Any,
    preferences: Any = None,
) -> dict[str, Any]:
    """Handle master import or slave overwrite sync for one heartbeat device."""
    normalized_runtime = _normalize_runtime(runtime)
    auth_sync = get_runtime_auth_sync(preferences, normalized_runtime)
    master_device_id = auth_sync["master_device_id"]
    slave_device_ids = set(auth_sync["slave_device_ids"])

    if device_id == master_device_id:
        return await self._sync_master_auth_for_heartbeat(
            db,
            user_id=user_id,
            runtime=normalized_runtime,
            device_id=device_id,
            runtime_auth_files=runtime_auth_files,
            preferences=preferences,
        )

    if device_id in slave_device_ids:
        status = self.get_config(
            db,
            user_id=user_id,
            runtime=normalized_runtime,
            preferences=preferences,
        )
        if not status.get("use_user_config") or not status.get("configured"):
            return {"status": "slave_skipped_disabled"}
        result = await self.sync_auth_to_devices(
            db,
            user_id=user_id,
            runtime=normalized_runtime,
            preferences=preferences,
            device_ids=[device_id],
            overwrite=True,
        )
        return {"status": "slave_synced", "result": result}

    return {"status": "not_configured_device"}


async def _sync_master_auth_for_heartbeat(
    self,
    db: Session,
    *,
    user_id: int,
    runtime: str,
    device_id: str,
    runtime_auth_files: Any,
    preferences: Any = None,
) -> dict[str, Any]:
    kind = self._get_kind(db, user_id=user_id, runtime=runtime)
    spec = self._get_spec(kind)
    auth = dict(spec.get("auth") or {})
    report = _runtime_auth_report(runtime_auth_files, runtime)
    if not _is_master_report_newer(report, auth):
        return {"status": "master_not_newer"}

    target_path = RUNTIME_AUTH_FILES[runtime]["target_path"]
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="read_runtime_auth_file",
            env={
                "WEGENT_RUNTIME_CONFIG_RUNTIME": runtime,
                "WEGENT_RUNTIME_CONFIG_TARGET_PATH": target_path,
            },
            timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
        )
    except DeviceCommandError as exc:
        raise UserRuntimeConfigSyncError(str(exc)) from exc

    if not result.get("success"):
        raise UserRuntimeConfigSyncError(_command_error_detail(result, "read failed"))

    stdout = _parse_command_stdout(result.get("stdout"))
    if not isinstance(stdout, dict) or not isinstance(stdout.get("content"), str):
        raise UserRuntimeConfigSyncError("device returned an invalid auth file")

    self.save_auth_json(
        db,
        user_id=user_id,
        runtime=runtime,
        auth_json=stdout["content"],
        preferences=preferences,
        source_device_id=device_id,
        source_modified_at=str(report["modified_at"]),
    )
    slave_result = await self.sync_auth_to_slave_devices(
        db,
        user_id=user_id,
        runtime=runtime,
        preferences=preferences,
    )
    return {"status": "master_imported", "result": slave_result}
```

- [ ] **Step 4: Run service heartbeat tests to verify they pass**

Run:

```bash
cd backend && uv run pytest \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_imports_newer_master_and_syncs_slaves \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_ignores_older_master_report \
  tests/services/test_user_runtime_config_service.py::test_sync_auth_for_heartbeat_overwrites_slave_device -q
```

Expected: PASS.

- [ ] **Step 5: Write failing device namespace delegation test**

In `backend/tests/api/ws/test_device_capabilities_state.py`, replace `test_heartbeat_runtime_auth_sync_uses_user_preferences` with:

```python
@pytest.mark.asyncio
async def test_heartbeat_runtime_auth_sync_delegates_master_slave_policy(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    runtime_auth_files = {
        "codex": {
            "exists": True,
            "sha256": "new",
            "modified_at": "2026-06-23T00:00:00+00:00",
        }
    }
    user = SimpleNamespace(
        id=7,
        preferences=json.dumps(
            {
                "runtime_configs": {
                    "codex": {
                        "use_user_config": True,
                        "auth_sync": {
                            "master_device_id": "device-1",
                            "slave_device_ids": ["device-2"],
                        },
                    }
                }
            }
        ),
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = user

    @contextmanager
    def fake_db_session():
        yield db

    sync_auth_for_heartbeat_device = AsyncMock(return_value={"status": "master_imported"})
    monkeypatch.setattr(device_namespace, "_db_session", fake_db_session)
    monkeypatch.setattr(
        device_namespace.user_runtime_config_service,
        "sync_auth_for_heartbeat_device",
        sync_auth_for_heartbeat_device,
    )

    key = (7, "device-1", "codex")
    namespace._runtime_auth_sync_inflight.add(key)

    await namespace._sync_runtime_auth_for_heartbeat_device(
        user_id=7,
        device_id="device-1",
        runtime_auth_files=runtime_auth_files,
        key=key,
    )

    sync_auth_for_heartbeat_device.assert_awaited_once_with(
        db,
        user_id=7,
        runtime="codex",
        device_id="device-1",
        runtime_auth_files=runtime_auth_files,
        preferences=user.preferences,
    )
    assert key not in namespace._runtime_auth_sync_inflight
```

- [ ] **Step 6: Run namespace test to verify it fails**

Run:

```bash
cd backend && uv run pytest tests/api/ws/test_device_capabilities_state.py::test_heartbeat_runtime_auth_sync_delegates_master_slave_policy -q
```

Expected: FAIL because the namespace still calls `get_config()` and `sync_auth_to_devices()`.

- [ ] **Step 7: Update device namespace scheduling**

In `backend/app/api/ws/device_namespace.py`, add this helper after `_runtime_auth_file_missing()`:

```python
def _has_runtime_auth_report(runtime_auth_files: Any, runtime: str) -> bool:
    if not isinstance(runtime_auth_files, dict):
        return False
    return isinstance(runtime_auth_files.get(runtime), dict)
```

Replace `_schedule_runtime_auth_sync_after_heartbeat()` with:

```python
def _schedule_runtime_auth_sync_after_heartbeat(
    self,
    *,
    user_id: int,
    device_id: str,
    runtime_auth_files: Any,
) -> None:
    """Schedule best-effort runtime auth sync after heartbeat auth reports."""
    if not _has_runtime_auth_report(runtime_auth_files, CODEX_RUNTIME):
        return

    key = (user_id, device_id, CODEX_RUNTIME)
    if key in self._runtime_auth_sync_inflight:
        return
    self._runtime_auth_sync_inflight.add(key)
    asyncio.create_task(
        self._sync_runtime_auth_for_heartbeat_device(
            user_id=user_id,
            device_id=device_id,
            runtime_auth_files=runtime_auth_files,
            key=key,
        )
    )
```

Update `_sync_runtime_auth_for_heartbeat_device()` signature:

```python
runtime_auth_files: Any,
```

Inside `_sync_runtime_auth_for_heartbeat_device()`, replace the `get_config()` and `sync_auth_to_devices()` block with:

```python
result = await user_runtime_config_service.sync_auth_for_heartbeat_device(
    db,
    user_id=user_id,
    runtime=CODEX_RUNTIME,
    device_id=device_id,
    runtime_auth_files=runtime_auth_files,
    preferences=user.preferences,
)
```

Replace the `items` lookup with:

```python
if isinstance(result, dict) and result.get("status") in {
    "master_imported",
    "master_not_newer",
    "slave_synced",
    "slave_skipped_disabled",
    "not_configured_device",
}:
    return
logger.warning(
    "[Device WS] Runtime auth heartbeat sync returned unexpected result: "
    "user=%s device=%s result=%s",
    user_id,
    device_id,
    result,
)
```

- [ ] **Step 8: Run namespace test to verify it passes**

Run:

```bash
cd backend && uv run pytest tests/api/ws/test_device_capabilities_state.py::test_heartbeat_runtime_auth_sync_delegates_master_slave_policy -q
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/user_runtime_config.py backend/app/api/ws/device_namespace.py backend/tests/services/test_user_runtime_config_service.py backend/tests/api/ws/test_device_capabilities_state.py
git commit -m "feat(backend): sync codex auth from master heartbeat"
```

## Task 6: User API Schema and Best-Effort Slave Sync

**Files:**
- Modify: `backend/app/api/endpoints/users.py:86-390`
- Create: `backend/tests/api/endpoints/test_user_runtime_config_api.py`

- [ ] **Step 1: Write failing API tests**

Create `backend/tests/api/endpoints/test_user_runtime_config_api.py` with:

```python
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints import users as users_endpoint
from app.models.kind import Kind
from app.models.user import User
from app.services.user_runtime_config import user_runtime_config_service


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_device(test_db: Session, user_id: int, device_id: str) -> None:
    test_db.add(
        Kind(
            user_id=user_id,
            kind="Device",
            namespace="default",
            name=device_id,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Device",
                "metadata": {"name": device_id, "namespace": "default"},
                "spec": {"deviceId": device_id, "displayName": device_id},
            },
            is_active=True,
        )
    )
    test_db.commit()


def test_update_runtime_config_accepts_auth_sync_and_syncs_slaves(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_device(test_db, test_user.id, "master-device")
    _create_device(test_db, test_user.id, "slave-device")
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=test_user.id,
        runtime="codex",
        auth_json='{"token":"saved"}',
    )
    sync_auth_to_slave_devices = AsyncMock(
        return_value={
            "runtime": "codex",
            "target_path": "~/.codex/auth.json",
            "total": 1,
            "items": [],
        }
    )
    monkeypatch.setattr(
        users_endpoint.user_runtime_config_service,
        "sync_auth_to_slave_devices",
        sync_auth_to_slave_devices,
    )

    response = test_client.put(
        "/api/users/me/runtime-configs/codex",
        headers=_auth_headers(test_token),
        json={
            "use_user_config": True,
            "auth_sync": {
                "master_device_id": "master-device",
                "slave_device_ids": ["slave-device"],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["auth_sync"] == {
        "master_device_id": "master-device",
        "slave_device_ids": ["slave-device"],
    }
    sync_auth_to_slave_devices.assert_awaited_once()


def test_upload_runtime_auth_json_syncs_slaves(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_user.preferences = (
        '{"runtime_configs":{"codex":{"use_user_config":true,'
        '"auth_sync":{"master_device_id":"master-device",'
        '"slave_device_ids":["slave-device"]}}}}'
    )
    test_db.add(test_user)
    test_db.commit()
    sync_auth_to_slave_devices = AsyncMock(
        return_value={
            "runtime": "codex",
            "target_path": "~/.codex/auth.json",
            "total": 1,
            "items": [],
        }
    )
    monkeypatch.setattr(
        users_endpoint.user_runtime_config_service,
        "sync_auth_to_slave_devices",
        sync_auth_to_slave_devices,
    )

    response = test_client.post(
        "/api/users/me/runtime-configs/codex/auth-json",
        headers=_auth_headers(test_token),
        json={"auth_json": '{"token":"uploaded"}'},
    )

    assert response.status_code == 200
    assert response.json()["configured"] is True
    sync_auth_to_slave_devices.assert_awaited_once()
```

- [ ] **Step 2: Run API tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/api/endpoints/test_user_runtime_config_api.py -q
```

Expected: FAIL because the response model does not include `auth_sync`, the request model ignores `auth_sync`, and the upload endpoint does not call `sync_auth_to_slave_devices()`.

- [ ] **Step 3: Extend API request and response models**

In `backend/app/api/endpoints/users.py`, add this Pydantic model before `UserRuntimeConfigResponse`:

```python
class UserRuntimeAuthSync(BaseModel):
    """Codex auth master/slave sync topology."""

    master_device_id: Optional[str] = None
    slave_device_ids: list[str] = []
```

Add this field to `UserRuntimeConfigResponse`:

```python
auth_sync: UserRuntimeAuthSync = UserRuntimeAuthSync()
```

Add this field to `UserRuntimeConfigUpdateRequest`:

```python
auth_sync: Optional[UserRuntimeAuthSync] = None
```

In `update_user_runtime_config()`, pass the auth sync dict:

```python
auth_sync=(
    request.auth_sync.model_dump() if request.auth_sync is not None else None
),
```

After `set_use_user_config(...)`, assign the result to `response`, then trigger best-effort slave sync only when `request.auth_sync is not None`:

```python
response = user_runtime_config_service.set_use_user_config(...)
if request.auth_sync is not None and response.get("configured"):
    try:
        await user_runtime_config_service.sync_auth_to_slave_devices(
            db,
            user_id=current_user.id,
            runtime=runtime,
            preferences=current_user.preferences,
        )
    except UserRuntimeConfigSyncError:
        logger.warning("Failed to sync runtime auth after settings update", exc_info=True)
return UserRuntimeConfigResponse(**response)
```

In `upload_user_runtime_auth_json()`, assign the save response to `response`, then trigger best-effort slave sync:

```python
response = user_runtime_config_service.save_auth_json(...)
try:
    await user_runtime_config_service.sync_auth_to_slave_devices(
        db,
        user_id=current_user.id,
        runtime=runtime,
        preferences=current_user.preferences,
    )
except UserRuntimeConfigSyncError:
    logger.warning("Failed to sync runtime auth after upload", exc_info=True)
return UserRuntimeConfigResponse(**response)
```

- [ ] **Step 4: Run backend runtime config tests**

Run:

```bash
cd backend && uv run pytest tests/services/test_user_runtime_config_service.py tests/api/endpoints/test_user_runtime_config_api.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/endpoints/users.py backend/tests/api/endpoints/test_user_runtime_config_api.py
git commit -m "feat(backend): expose codex auth sync settings"
```

## Task 7: Wework API Types and UI Controls

**Files:**
- Modify: `wework/src/api/users.ts:10-35`
- Modify: `wework/src/types/api.ts:22-28`
- Modify: `wework/src/components/settings/RuntimeConfigSettingsPage.tsx:1-527`
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.test.tsx:294-331`
- Modify: `wework/src/i18n/locales/zh-CN/common.json:571-608`
- Modify: `wework/src/i18n/locales/en/common.json:571-608`

- [ ] **Step 1: Write the failing Wework UI test**

In `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`, add this test after `opens Codex auth settings under personal group without manual device sync`:

```typescript
test('saves Codex auth master slave sync settings', async () => {
  api.getAllDevices.mockResolvedValue([
    localDevice({ device_id: 'master-device', name: 'Master Mac' }),
    localDevice({ id: 3, device_id: 'slave-device', name: 'Slave Linux' }),
  ])
  userApi.getRuntimeConfig.mockResolvedValueOnce({
    runtime: 'codex',
    display_name: 'Codex',
    use_user_config: true,
    use_proxy: false,
    configured: true,
    target_path: '~/.codex/auth.json',
    auth_json_sha256: 'abc1234567890',
    auth_json_updated_at: '2026-06-09T00:00:00Z',
    proxy_configured: false,
    proxy_url_masked: '',
    proxy_updated_at: null,
    updated_at: '2026-06-09T00:00:00Z',
    auth_sync: {
      master_device_id: null,
      slave_device_ids: [],
    },
  })
  userApi.updateRuntimeConfig.mockResolvedValueOnce({
    runtime: 'codex',
    display_name: 'Codex',
    use_user_config: true,
    use_proxy: false,
    configured: true,
    target_path: '~/.codex/auth.json',
    auth_json_sha256: 'abc1234567890',
    auth_json_updated_at: '2026-06-09T00:00:00Z',
    proxy_configured: false,
    proxy_url_masked: '',
    proxy_updated_at: null,
    updated_at: '2026-06-09T00:00:01Z',
    auth_sync: {
      master_device_id: 'master-device',
      slave_device_ids: ['slave-device'],
    },
  })

  render(<ConnectionsSettingsPage onBack={vi.fn()} />)

  await userEvent.click(screen.getByTestId('settings-nav-codex-auth'))
  await screen.findByTestId('runtime-config-auth-sync-section')

  await userEvent.selectOptions(
    screen.getByTestId('runtime-config-master-device-select'),
    'master-device'
  )
  await userEvent.click(screen.getByTestId('runtime-config-slave-device-slave-device'))
  await userEvent.click(screen.getByTestId('runtime-config-auth-sync-save-button'))

  await waitFor(() =>
    expect(userApi.updateRuntimeConfig).toHaveBeenCalledWith('codex', {
      use_user_config: true,
      use_proxy: false,
      auth_sync: {
        master_device_id: 'master-device',
        slave_device_ids: ['slave-device'],
      },
    })
  )
  expect(await screen.findByTestId('runtime-config-notice')).toHaveTextContent(
    '同步设置已保存'
  )
})
```

Update existing mocked runtime config responses in `beforeEach` to include:

```typescript
auth_sync: {
  master_device_id: null,
  slave_device_ids: [],
},
```

- [ ] **Step 2: Run the Wework UI test to verify it fails**

Run:

```bash
pnpm --dir wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx -t "saves Codex auth master slave sync settings"
```

Expected: FAIL because the new `auth_sync` fields and UI controls do not exist.

- [ ] **Step 3: Add TypeScript auth sync types**

In `wework/src/api/users.ts`, add:

```typescript
export interface RuntimeAuthSync {
  master_device_id: string | null
  slave_device_ids: string[]
}
```

Add this field to `UserRuntimeConfig`:

```typescript
auth_sync: RuntimeAuthSync
```

Add this field to `UpdateUserRuntimeConfigRequest`:

```typescript
auth_sync?: RuntimeAuthSync
```

In `wework/src/types/api.ts`, extend runtime preferences:

```typescript
auth_sync?: {
  master_device_id?: string | null
  slave_device_ids?: string[]
}
```

- [ ] **Step 4: Add localized copy**

Add these keys under `workbench` in `wework/src/i18n/locales/zh-CN/common.json`:

```json
"runtime_config_auth_sync_title": "设备同步",
"runtime_config_auth_sync_description": "主设备只作为 auth.json 来源；从设备会被保存的 auth.json 直接覆盖。",
"runtime_config_master_device": "主设备",
"runtime_config_no_master_device": "不设置主设备",
"runtime_config_slave_devices": "从设备",
"runtime_config_no_slave_devices": "没有可选从设备",
"runtime_config_auth_sync_save": "保存同步设置",
"runtime_config_auth_sync_saved": "同步设置已保存"
```

Add these keys under `workbench` in `wework/src/i18n/locales/en/common.json`:

```json
"runtime_config_auth_sync_title": "Device sync",
"runtime_config_auth_sync_description": "The master device is only read as the auth.json source; slave devices are overwritten with the saved auth.json.",
"runtime_config_master_device": "Master device",
"runtime_config_no_master_device": "No master device",
"runtime_config_slave_devices": "Slave devices",
"runtime_config_no_slave_devices": "No slave devices available",
"runtime_config_auth_sync_save": "Save sync settings",
"runtime_config_auth_sync_saved": "Sync settings saved"
```

- [ ] **Step 5: Implement the UI controls**

In `wework/src/components/settings/RuntimeConfigSettingsPage.tsx`, add `Settings2` to the lucide import:

```typescript
Settings2,
```

After `const [proxyUpdating, setProxyUpdating] = useState(false)`, add:

```typescript
const [syncSaving, setSyncSaving] = useState(false)
const [draftMasterDeviceId, setDraftMasterDeviceId] = useState('')
const [draftSlaveDeviceIds, setDraftSlaveDeviceIds] = useState<string[]>([])
```

After `effectiveImportDeviceId`, add:

```typescript
const masterDeviceId = draftMasterDeviceId || ''
const slaveDeviceOptions = useMemo(
  () => devices.filter(device => device.device_id !== masterDeviceId),
  [devices, masterDeviceId],
)
```

After the existing `useEffect(() => { void Promise.resolve().then(() => loadRuntimeConfig()) }, ...)`, add:

```typescript
useEffect(() => {
  const authSync = config?.auth_sync
  setDraftMasterDeviceId(authSync?.master_device_id ?? '')
  setDraftSlaveDeviceIds(authSync?.slave_device_ids ?? [])
}, [config?.auth_sync])
```

Add these handlers before `handleFileChange`:

```typescript
const handleMasterDeviceChange = (deviceId: string) => {
  setDraftMasterDeviceId(deviceId)
  setDraftSlaveDeviceIds(current => current.filter(item => item !== deviceId))
}

const handleSlaveDeviceToggle = (deviceId: string) => {
  setDraftSlaveDeviceIds(current =>
    current.includes(deviceId)
      ? current.filter(item => item !== deviceId)
      : [...current, deviceId],
  )
}

const handleSaveAuthSync = async () => {
  if (!config || syncSaving) return
  setSyncSaving(true)
  setError(null)
  setNotice(null)
  try {
    const { userApi } = createRuntimeSettingsApis()
    const nextConfig = await userApi.updateRuntimeConfig(runtime, {
      use_user_config: config.use_user_config,
      use_proxy: config.use_proxy,
      auth_sync: {
        master_device_id: draftMasterDeviceId || null,
        slave_device_ids: draftSlaveDeviceIds,
      },
    })
    setConfig(nextConfig)
    setNotice(t('workbench.runtime_config_auth_sync_saved'))
  } catch (syncError) {
    setError(
      getErrorMessage(
        syncError,
        t('workbench.runtime_config_save_failed', '保存运行时配置失败'),
      ),
    )
  } finally {
    setSyncSaving(false)
  }
}
```

Insert this section after the proxy block and before `{notice && (...)}`:

```tsx
<div
  data-testid="runtime-config-auth-sync-section"
  className="mt-5 rounded-lg border border-border bg-surface p-3"
>
  <div className="flex min-w-0 items-start gap-3">
    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
      <Settings2 className="h-4 w-4" />
    </div>
    <div className="min-w-0 flex-1">
      <h3 className="text-sm font-semibold text-text-primary">
        {t('workbench.runtime_config_auth_sync_title')}
      </h3>
      <p className="mt-1 text-xs leading-5 text-text-secondary">
        {t('workbench.runtime_config_auth_sync_description')}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.2fr]">
        <label className="block">
          <span className="text-xs text-text-muted">
            {t('workbench.runtime_config_master_device')}
          </span>
          <select
            data-testid="runtime-config-master-device-select"
            value={draftMasterDeviceId}
            onChange={event => handleMasterDeviceChange(event.target.value)}
            disabled={devices.length === 0 || syncSaving}
            className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">
              {t('workbench.runtime_config_no_master_device')}
            </option>
            {devices.map(device => (
              <option key={device.device_id} value={device.device_id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <div className="text-xs text-text-muted">
            {t('workbench.runtime_config_slave_devices')}
          </div>
          <div className="mt-1 flex max-h-28 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-background p-2">
            {slaveDeviceOptions.length === 0 ? (
              <div className="text-xs text-text-muted">
                {t('workbench.runtime_config_no_slave_devices')}
              </div>
            ) : (
              slaveDeviceOptions.map(device => (
                <label
                  key={device.device_id}
                  className="flex min-h-8 items-center gap-2 text-sm text-text-primary"
                >
                  <input
                    type="checkbox"
                    data-testid={`runtime-config-slave-device-${device.device_id}`}
                    checked={draftSlaveDeviceIds.includes(device.device_id)}
                    onChange={() => handleSlaveDeviceToggle(device.device_id)}
                    disabled={syncSaving}
                    className="h-4 w-4 rounded border-border text-primary"
                  />
                  <span className="min-w-0 truncate">{device.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        data-testid="runtime-config-auth-sync-save-button"
        onClick={() => void handleSaveAuthSync()}
        disabled={syncSaving}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {syncSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('workbench.runtime_config_auth_sync_save')}
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 6: Run the Wework UI test to verify it passes**

Run:

```bash
pnpm --dir wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx -t "saves Codex auth master slave sync settings"
```

Expected: PASS.

- [ ] **Step 7: Run the surrounding Wework settings tests**

Run:

```bash
pnpm --dir wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add wework/src/api/users.ts wework/src/types/api.ts wework/src/components/settings/RuntimeConfigSettingsPage.tsx wework/src/components/settings/ConnectionsSettingsPage.test.tsx wework/src/i18n/locales/zh-CN/common.json wework/src/i18n/locales/en/common.json
git commit -m "feat(wework): configure codex auth sync devices"
```

## Task 8: Documentation

**Files:**
- Modify: `docs/zh/developer-guide/user-runtime-config.md`
- Modify: `docs/en/developer-guide/user-runtime-config.md`

- [ ] **Step 1: Update Chinese developer guide first**

In `docs/zh/developer-guide/user-runtime-config.md`, replace the `## 设备心跳同步` section with:

```markdown
## 主从设备同步

用户启用个人配置后，可以为 Codex auth 选择一台主设备和多台从设备。主设备是 `~/.codex/auth.json` 的来源；从设备是同步目标。主设备不会被后端覆盖，从设备收到同步时会直接覆盖已有 auth 文件。

主从拓扑保存在 `users.preferences.runtime_configs.codex.auth_sync`：

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true,
      "use_proxy": true,
      "auth_sync": {
        "master_device_id": "macbook-pro",
        "slave_device_ids": ["linux-box", "office-mac"]
      }
    }
  }
}
```

executor 会在设备心跳中上报本机 Codex auth 文件状态。如果文件存在，心跳包含 `sha256` 和 `modified_at`；如果文件不存在，只上报 `exists: false`。

当主设备心跳中的 `sha256` 与后端保存版本不同，并且 `modified_at` 晚于后端当前版本基准时间时，后端会通过 `read_runtime_auth_file` 读取主设备 auth，校验 JSON 后加密保存，并把新版本覆盖同步到所有在线从设备。基准时间优先使用 `sourceModifiedAt`，没有时使用 `spec.auth.updatedAt`，避免旧的主设备文件覆盖用户刚手动上传的新版本。

从设备上线或心跳时，如果用户启用了 Codex 个人配置且后端已有 auth，后端会把保存的 auth 覆盖写入该从设备。离线从设备跳过本次同步，等下次上线心跳后补同步。

下发链路复用 Local Device Command RPC：后端调用白名单命令 `sync_runtime_auth_file`，通过环境变量传递认证内容，避免把密文或明文放到命令行日志。主从同步写入从设备时会传入 `WEGENT_RUNTIME_CONFIG_OVERWRITE=true`，设备端使用原子写入覆盖目标文件，并设置 `0600` 权限。未传覆盖开关的旧调用仍保持“已有文件则跳过”的行为。

从设备导入配置仍可手动触发：后端调用 `read_runtime_auth_file` 读取目标文件，校验 JSON 后加密保存；读取到的内容不会返回给前端。
```

- [ ] **Step 2: Update English developer guide**

In `docs/en/developer-guide/user-runtime-config.md`, replace the `## Heartbeat Sync` section with:

```markdown
## Master/Slave Device Sync

After the user enables personal configuration, they can select one Codex auth master device and multiple slave devices. The master device is the source for `~/.codex/auth.json`; slave devices are sync targets. Backend never overwrites the master device. Slave devices are overwritten when they receive a sync.

The topology is stored in `users.preferences.runtime_configs.codex.auth_sync`:

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true,
      "use_proxy": true,
      "auth_sync": {
        "master_device_id": "macbook-pro",
        "slave_device_ids": ["linux-box", "office-mac"]
      }
    }
  }
}
```

executor reports local Codex auth file state in device heartbeats. If the file exists, the heartbeat includes `sha256` and `modified_at`; if it does not exist, it only reports `exists: false`.

When the master heartbeat `sha256` differs from the saved Backend version and `modified_at` is newer than the current saved version baseline, Backend reads the master file with `read_runtime_auth_file`, validates the JSON, stores it encrypted, and overwrites all online slave devices. The baseline prefers `sourceModifiedAt` and falls back to `spec.auth.updatedAt`, which prevents an old master file from replacing a version the user just uploaded manually.

When a slave device comes online or sends a heartbeat, Backend overwrites that slave with the saved auth if Codex personal config is enabled and auth is configured. Offline slaves are skipped for that attempt and are synced on a later heartbeat.

The write path reuses Local Device Command RPC. Backend calls the whitelisted `sync_runtime_auth_file` command and passes auth content through environment variables so plaintext and ciphertext are not put in command-line logs. Master/slave sync passes `WEGENT_RUNTIME_CONFIG_OVERWRITE=true`; the device command atomically overwrites the target file and sets `0600` permissions. Existing callers that do not pass the overwrite flag keep the old "skip existing file" behavior.

Manual import from a device remains available: Backend calls `read_runtime_auth_file`, validates the JSON, and stores it encrypted. The file content is not returned to Frontend.
```

- [ ] **Step 3: Run documentation grep**

Run:

```bash
rg -n "skipped_existing|does not overwrite|missing `~/.codex/auth.json`|缺少 `~/.codex/auth.json`" docs/zh/developer-guide/user-runtime-config.md docs/en/developer-guide/user-runtime-config.md
```

Expected: no stale statements claiming Codex heartbeat sync only fills missing files.

- [ ] **Step 4: Commit**

```bash
git add docs/zh/developer-guide/user-runtime-config.md docs/en/developer-guide/user-runtime-config.md
git commit -m "docs: document codex auth master slave sync"
```

## Task 9: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run backend runtime config tests**

Run:

```bash
cd backend && uv run pytest tests/services/test_user_runtime_config_service.py tests/api/ws/test_device_capabilities_state.py::test_heartbeat_runtime_auth_sync_delegates_master_slave_policy tests/services/test_local_device_command_service.py::test_sync_runtime_auth_file_command_overwrites_existing_file_when_enabled -q
```

Expected: PASS.

- [ ] **Step 2: Run executor heartbeat test**

Run:

```bash
cd executor && uv run pytest tests/test_local_websocket_client.py::test_build_runtime_auth_file_report_reports_codex_auth_metadata -q
```

Expected: PASS.

- [ ] **Step 3: Run Wework settings test**

Run:

```bash
pnpm --dir wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run formatting and lint checks for touched frontend code**

Run:

```bash
pnpm --dir wework run lint
```

Expected: PASS. If the package has no `lint` script, record the missing script and rely on the Vitest run plus TypeScript compiler output from the test run.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional implementation changes are present, or the worktree is clean after commits.
