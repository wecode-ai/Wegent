# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services import user_runtime_config as runtime_config_module
from app.services.user_runtime_config import (
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


def test_save_auth_json_rejects_invalid_json(test_db: Session) -> None:
    with pytest.raises(UserRuntimeConfigError, match="valid JSON"):
        user_runtime_config_service.save_auth_json(
            test_db,
            user_id=101,
            runtime="codex",
            auth_json="{invalid",
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
