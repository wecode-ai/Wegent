# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services import user_runtime_config as runtime_config_module
from app.services.user_runtime_config import (
    USER_PROXY_CONFIG_KIND,
    USER_PROXY_CONFIG_NAME,
    USER_RUNTIME_CONFIG_KIND,
    USER_RUNTIME_CONFIG_NAMESPACE,
    UserRuntimeConfigError,
    UserRuntimeConfigSyncError,
    user_runtime_config_service,
)
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted


def _get_codex_kind(test_db: Session, user_id: int) -> Kind:
    return (
        test_db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == USER_RUNTIME_CONFIG_KIND,
            Kind.namespace == USER_RUNTIME_CONFIG_NAMESPACE,
            Kind.name == "codex",
        )
        .one()
    )


def _get_proxy_kind(test_db: Session, user_id: int) -> Kind:
    return (
        test_db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == USER_PROXY_CONFIG_KIND,
            Kind.namespace == USER_RUNTIME_CONFIG_NAMESPACE,
            Kind.name == USER_PROXY_CONFIG_NAME,
        )
        .one()
    )


def _create_user(test_db: Session, user_id: int, preferences=None) -> User:
    user = User(
        id=user_id,
        user_name=f"user-{user_id}",
        password_hash="hash",
        preferences=preferences,
    )
    test_db.add(user)
    test_db.commit()
    return user


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


def test_save_auth_json_encrypts_runtime_config(test_db: Session) -> None:
    response = user_runtime_config_service.save_auth_json(
        test_db,
        user_id=101,
        runtime="codex",
        auth_json='{"token":"secret","account":{"id":"user-1"}}',
    )

    assert response["runtime"] == "codex"
    assert response["configured"] is True
    assert response["target_path"] == "~/.codex/auth.json"

    kind = _get_codex_kind(test_db, 101)
    encrypted_value = kind.json["spec"]["auth"]["encryptedValue"]

    assert encrypted_value != '{"token":"secret","account":{"id":"user-1"}}'
    assert "secret" not in encrypted_value
    assert is_data_encrypted(encrypted_value)
    assert json.loads(decrypt_sensitive_data(encrypted_value)) == {
        "account": {"id": "user-1"},
        "token": "secret",
    }


def test_save_auth_json_records_source_metadata(test_db: Session) -> None:
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=109,
        runtime="codex",
        auth_json='{"token":"from-master"}',
        source_device_id="master-device",
        source_modified_at="2026-06-23T01:02:03+00:00",
    )

    kind = _get_codex_kind(test_db, 109)
    auth = kind.json["spec"]["auth"]

    assert auth["sourceDeviceId"] == "master-device"
    assert auth["sourceModifiedAt"] == "2026-06-23T01:02:03+00:00"


def test_set_use_user_config_stores_preference(test_db: Session) -> None:
    user = User(
        id=1201,
        user_name="runtime-pref-user",
        password_hash="hash",
        preferences='{"send_key":"cmd_enter"}',
    )
    test_db.add(user)
    test_db.commit()

    response = user_runtime_config_service.set_use_user_config(
        test_db,
        user=user,
        runtime="codex",
        use_user_config=True,
    )

    test_db.refresh(user)
    assert response["use_user_config"] is True
    assert json.loads(user.preferences) == {
        "send_key": "cmd_enter",
        "runtime_configs": {"codex": {"use_user_config": True}},
    }


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


def test_set_use_user_config_rejects_unknown_auth_sync_device(
    test_db: Session,
) -> None:
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


def test_set_use_proxy_stores_runtime_preference(test_db: Session) -> None:
    user = _create_user(
        test_db,
        1202,
        preferences='{"runtime_configs":{"codex":{"use_user_config":true}}}',
    )
    user_runtime_config_service.save_proxy_url(
        test_db,
        user=user,
        proxy_url="http://127.0.0.1:7890",
    )

    response = user_runtime_config_service.set_use_user_config(
        test_db,
        user=user,
        runtime="codex",
        use_user_config=True,
        use_proxy=True,
    )

    test_db.refresh(user)
    assert response["use_proxy"] is True
    assert json.loads(user.preferences) == {
        "runtime_configs": {"codex": {"use_user_config": True, "use_proxy": True}},
    }


def test_set_use_proxy_requires_configured_proxy(test_db: Session) -> None:
    user = _create_user(test_db, 1203)

    with pytest.raises(UserRuntimeConfigError, match="proxy is not configured"):
        user_runtime_config_service.set_use_user_config(
            test_db,
            user=user,
            runtime="codex",
            use_user_config=False,
            use_proxy=True,
        )


def test_save_proxy_url_encrypts_and_masks_proxy_config(test_db: Session) -> None:
    user = _create_user(test_db, 105)

    response = user_runtime_config_service.save_proxy_url(
        test_db,
        user=user,
        proxy_url="http://user:secret@127.0.0.1:7890",
    )

    assert response["configured"] is True
    assert response["proxy_url_masked"] == "http://***:***@127.0.0.1:7890"

    kind = _get_proxy_kind(test_db, 105)
    encrypted_url = kind.json["spec"]["proxy"]["encryptedUrl"]

    assert "secret" not in encrypted_url
    assert is_data_encrypted(encrypted_url)
    assert decrypt_sensitive_data(encrypted_url) == "http://user:secret@127.0.0.1:7890"


def test_clearing_proxy_disables_runtime_proxy_preferences(test_db: Session) -> None:
    user = _create_user(
        test_db,
        108,
        preferences='{"runtime_configs":{"codex":{"use_user_config":true,"use_proxy":true}}}',
    )
    user_runtime_config_service.save_proxy_url(
        test_db,
        user=user,
        proxy_url="http://127.0.0.1:7890",
    )

    response = user_runtime_config_service.save_proxy_url(
        test_db,
        user=user,
        proxy_url="",
    )

    test_db.refresh(user)
    assert response["configured"] is False
    assert json.loads(user.preferences) == {
        "runtime_configs": {"codex": {"use_user_config": True, "use_proxy": False}},
    }


def test_get_execution_config_includes_proxy_url_when_enabled(
    test_db: Session,
) -> None:
    user = _create_user(test_db, 106)
    user_runtime_config_service.save_proxy_url(
        test_db,
        user=user,
        proxy_url="socks5://127.0.0.1:7890",
    )

    response = user_runtime_config_service.get_execution_config(
        test_db,
        user_id=106,
        runtime="codex",
        preferences={
            "runtime_configs": {"codex": {"use_user_config": True, "use_proxy": True}}
        },
    )

    assert response["use_proxy"] is True
    assert response["proxy_configured"] is True
    assert response["proxy_url"] == "socks5://127.0.0.1:7890"


def test_save_auth_json_rejects_invalid_json(test_db: Session) -> None:
    with pytest.raises(UserRuntimeConfigError, match="valid JSON"):
        user_runtime_config_service.save_auth_json(
            test_db,
            user_id=101,
            runtime="codex",
            auth_json="{invalid",
        )


def test_save_proxy_url_rejects_invalid_url(test_db: Session) -> None:
    user = _create_user(test_db, 107)

    with pytest.raises(UserRuntimeConfigError, match="scheme"):
        user_runtime_config_service.save_proxy_url(
            test_db,
            user=user,
            proxy_url="ftp://127.0.0.1:7890",
        )


@pytest.mark.asyncio
async def test_sync_auth_to_devices_preserves_skipped_existing_status(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=102,
        runtime="codex",
        auth_json='{"token":"secret"}',
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [{"device_id": "device-1", "status": "online"}]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "stdout": {
                "status": "skipped_existing",
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
        user_id=102,
        runtime="codex",
        preferences={"runtime_configs": {"codex": {"use_user_config": True}}},
    )

    assert result["total"] == 1
    assert result["items"][0]["status"] == "skipped_existing"
    assert calls[0]["command_key"] == "sync_runtime_auth_file"
    assert calls[0]["env"]["WEGENT_RUNTIME_CONFIG_TARGET_PATH"] == "~/.codex/auth.json"
    assert json.loads(calls[0]["env"]["WEGENT_RUNTIME_CONFIG_CONTENT"]) == {
        "token": "secret"
    }


@pytest.mark.asyncio
async def test_sync_auth_to_devices_can_overwrite_selected_devices(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1210,
        runtime="codex",
        auth_json='{"token":"secret"}',
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [
            {"device_id": "slave-a", "status": "online"},
            {"device_id": "other-device", "status": "online"},
        ]

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
        user_id=1210,
        runtime="codex",
        preferences={"runtime_configs": {"codex": {"use_user_config": True}}},
        device_ids=["slave-a"],
        overwrite=True,
    )

    assert result["total"] == 1
    assert result["items"][0]["status"] == "overwritten"
    assert calls[0]["device_id"] == "slave-a"
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
        user_id=1211,
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
        user_id=1211,
        runtime="codex",
        preferences=preferences,
    )

    assert result["total"] == 2
    assert {call["device_id"] for call in calls} == {"slave-a", "slave-b"}
    assert all(
        call["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true" for call in calls
    )


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
                    "slave_device_ids": ["slave-a"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1212,
        runtime="codex",
        auth_json='{"token":"old"}',
        preferences=preferences,
        source_device_id="master-device",
        source_modified_at="2026-06-23T01:00:00+00:00",
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [
            {"device_id": "master-device", "status": "online"},
            {"device_id": "slave-a", "status": "online"},
        ]

    async def fake_execute_configured_device_command(**kwargs):
        calls.append(kwargs)
        if kwargs["command_key"] == "read_runtime_auth_file":
            return {
                "success": True,
                "stdout": {"content": '{"token":"new"}'},
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
        user_id=1212,
        runtime="codex",
        device_id="master-device",
        runtime_auth_files={
            "codex": {
                "exists": True,
                "sha256": "new-sha",
                "modified_at": "2026-06-23T02:00:00+00:00",
            }
        },
        preferences=preferences,
    )

    kind = _get_codex_kind(test_db, 1212)
    auth = kind.json["spec"]["auth"]

    assert result["status"] == "master_imported"
    assert auth["sourceDeviceId"] == "master-device"
    assert auth["sourceModifiedAt"] == "2026-06-23T02:00:00+00:00"
    assert json.loads(decrypt_sensitive_data(auth["encryptedValue"])) == {
        "token": "new"
    }
    assert [call["command_key"] for call in calls] == [
        "read_runtime_auth_file",
        "sync_runtime_auth_file",
    ]
    assert calls[1]["device_id"] == "slave-a"
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
                "auth_sync": {
                    "master_device_id": "master-device",
                    "slave_device_ids": ["slave-a"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1213,
        runtime="codex",
        auth_json='{"token":"newer"}',
        preferences=preferences,
        source_device_id="master-device",
        source_modified_at="2026-06-23T03:00:00+00:00",
    )
    execute_configured_device_command = AsyncMock()
    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        execute_configured_device_command,
    )

    result = await user_runtime_config_service.sync_auth_for_heartbeat_device(
        test_db,
        user_id=1213,
        runtime="codex",
        device_id="master-device",
        runtime_auth_files={
            "codex": {
                "exists": True,
                "sha256": "older-sha",
                "modified_at": "2026-06-23T02:00:00+00:00",
            }
        },
        preferences=preferences,
    )

    assert result["status"] == "master_not_newer"
    execute_configured_device_command.assert_not_awaited()


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
                    "slave_device_ids": ["slave-a"],
                },
            }
        }
    }
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=1214,
        runtime="codex",
        auth_json='{"token":"master"}',
        preferences=preferences,
    )
    calls = []

    async def fake_get_online_devices(db, user_id):
        return [{"device_id": "slave-a", "status": "online"}]

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
        user_id=1214,
        runtime="codex",
        device_id="slave-a",
        runtime_auth_files={"codex": {"exists": True}},
        preferences=preferences,
    )

    assert result["status"] == "slave_synced"
    assert calls[0]["device_id"] == "slave-a"
    assert calls[0]["env"]["WEGENT_RUNTIME_CONFIG_OVERWRITE"] == "true"


@pytest.mark.asyncio
async def test_import_auth_json_from_device_encrypts_device_file(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_configured_device_command(**kwargs):
        assert kwargs["command_key"] == "read_runtime_auth_file"
        assert (
            kwargs["env"]["WEGENT_RUNTIME_CONFIG_TARGET_PATH"] == "~/.codex/auth.json"
        )
        return {
            "success": True,
            "stdout": {
                "status": "read",
                "runtime": "codex",
                "path": "~/.codex/auth.json",
                "content": '{"token":"from-device"}',
            },
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    response = await user_runtime_config_service.import_auth_json_from_device(
        test_db,
        user_id=103,
        runtime="codex",
        device_id="device-1",
    )

    assert response["configured"] is True
    kind = _get_codex_kind(test_db, 103)
    encrypted_value = kind.json["spec"]["auth"]["encryptedValue"]
    assert "from-device" not in encrypted_value
    assert json.loads(decrypt_sensitive_data(encrypted_value)) == {
        "token": "from-device"
    }


@pytest.mark.asyncio
async def test_import_auth_json_from_device_uses_script_error_detail(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_configured_device_command(**kwargs):
        return {
            "success": False,
            "stdout": '{"status":"failed","error":"runtime auth file does not exist"}',
            "stderr": "",
        }

    monkeypatch.setattr(
        runtime_config_module,
        "execute_configured_device_command",
        fake_execute_configured_device_command,
    )

    with pytest.raises(UserRuntimeConfigSyncError, match="does not exist"):
        await user_runtime_config_service.import_auth_json_from_device(
            test_db,
            user_id=104,
            runtime="codex",
            device_id="device-1",
        )
