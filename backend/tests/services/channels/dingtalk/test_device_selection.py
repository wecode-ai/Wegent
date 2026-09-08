# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk device selection manager."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.models.kind import Kind
from app.services.channels.device_selection import (
    CHANNEL_USER_DEVICE_PREFIX,
    CHANNEL_USER_DEVICE_TTL,
    DeviceSelection,
    DeviceSelectionManager,
    DeviceType,
    device_selection_manager,
    get_device_execution_target_id,
)


class TestDeviceType:
    """Tests for DeviceType enum."""

    def test_device_type_values(self):
        """Test DeviceType enum values."""
        assert DeviceType.CHAT.value == "chat"
        assert DeviceType.LOCAL.value == "local"
        assert DeviceType.CLOUD.value == "cloud"


class TestDeviceSelection:
    """Tests for DeviceSelection dataclass."""

    def test_default_selection(self):
        """Test default selection is CHAT mode."""
        selection = DeviceSelection.default()
        assert selection.device_type == DeviceType.CHAT
        assert selection.device_id is None
        assert selection.device_name is None

    def test_to_dict(self):
        """Test converting to dictionary."""
        selection = DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="device-123",
            device_name="My Mac",
        )
        data = selection.to_dict()
        assert data == {
            "device_type": "local",
            "device_id": "device-123",
            "device_name": "My Mac",
        }

    def test_from_dict(self):
        """Test creating from dictionary."""
        data = {
            "device_type": "local",
            "device_id": "device-123",
            "device_name": "My Mac",
        }
        selection = DeviceSelection.from_dict(data)
        assert selection.device_type == DeviceType.LOCAL
        assert selection.device_id == "device-123"
        assert selection.device_name == "My Mac"

    def test_from_dict_defaults(self):
        """Test from_dict with missing keys uses defaults."""
        selection = DeviceSelection.from_dict({})
        assert selection.device_type == DeviceType.CHAT
        assert selection.device_id is None
        assert selection.device_name is None

    def test_roundtrip(self):
        """Test roundtrip conversion."""
        original = DeviceSelection(
            device_type=DeviceType.CLOUD,
        )
        data = original.to_dict()
        restored = DeviceSelection.from_dict(data)
        assert restored.device_type == original.device_type

    def test_get_device_execution_target_id_prefers_record_route(self):
        device = {
            "device_id": "local-device",
            "execution_target_id": "app-record-1819",
        }

        assert get_device_execution_target_id(device) == "app-record-1819"

    def test_get_device_execution_target_id_uses_logical_id_for_local_device(self):
        assert get_device_execution_target_id({"device_id": "macbook"}) == "macbook"


class TestDeviceSelectionManager:
    """Tests for DeviceSelectionManager."""

    def test_generate_key(self):
        """Test Redis key generation."""
        key = DeviceSelectionManager._generate_key(123)
        assert key == f"{CHANNEL_USER_DEVICE_PREFIX}123"

    @pytest.mark.asyncio
    async def test_get_selection_no_cache(self):
        """Test getting selection when no cache exists."""
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=None)

            selection = await DeviceSelectionManager.get_selection(123)

            assert selection.device_type == DeviceType.CHAT
            mock_cache.get.assert_called_once_with(f"{CHANNEL_USER_DEVICE_PREFIX}123")

    @pytest.mark.asyncio
    async def test_get_selection_with_cache(self):
        """Test getting selection from cache."""
        cached_data = {
            "device_type": "local",
            "device_id": "device-123",
            "device_name": "My Mac",
        }
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=cached_data)

            selection = await DeviceSelectionManager.get_selection(123)

            assert selection.device_type == DeviceType.LOCAL
            assert selection.device_id == "device-123"
            assert selection.device_name == "My Mac"

    @pytest.mark.asyncio
    async def test_get_selection_from_user_preference_parses_json_string(
        self,
        test_db,
        test_user,
        monkeypatch,
    ):
        """Test user preference lookup handles stored JSON strings."""
        test_user.preferences = json.dumps({"default_execution_target": "device-123"})
        test_db.commit()

        class SessionProxy:
            def query(self, *args, **kwargs):
                return test_db.query(*args, **kwargs)

            def close(self):
                pass

        async def fake_get_device_online_info(user_id, device_id):
            return {"name": "My Mac"}

        monkeypatch.setattr("app.db.session.SessionLocal", lambda: SessionProxy())
        monkeypatch.setattr(
            "app.services.device_service.device_service.get_device_online_info",
            fake_get_device_online_info,
        )

        selection = await DeviceSelectionManager.get_selection_from_user_preference(
            test_user.id
        )

        assert selection is not None
        assert selection.device_type == DeviceType.LOCAL
        assert selection.device_id == "device-123"
        assert selection.device_name == "My Mac"

    @pytest.mark.asyncio
    async def test_get_selection_preserves_offline_preference_target(
        self,
        test_db,
        test_user,
        monkeypatch,
    ):
        """An unavailable default remains selected instead of becoming chat mode."""
        test_user.preferences = json.dumps(
            {"default_execution_target": "offline-device"}
        )
        test_db.commit()

        class SessionProxy:
            def query(self, *args, **kwargs):
                return test_db.query(*args, **kwargs)

            def close(self):
                pass

        monkeypatch.setattr("app.db.session.SessionLocal", lambda: SessionProxy())
        monkeypatch.setattr(
            "app.services.device_service.device_service.get_device_online_info",
            AsyncMock(return_value=None),
        )

        selection = await DeviceSelectionManager.get_selection_from_user_preference(
            test_user.id
        )

        assert selection == DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="offline-device",
        )

    @pytest.mark.asyncio
    async def test_get_selection_normalizes_app_preference_to_record_route(
        self,
        test_db,
        test_user,
        monkeypatch,
    ):
        test_user.preferences = json.dumps({"default_execution_target": "local-device"})
        device = Kind(
            user_id=test_user.id,
            kind="Device",
            name="local-device",
            namespace="default",
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Device",
                "metadata": {"name": "local-device", "namespace": "default"},
                "spec": {
                    "deviceId": "local-device",
                    "deviceType": "app",
                    "displayName": "APB22015038",
                    "runtimeInstanceId": "runtime-installation",
                    "appDeviceId": "electron-app",
                },
            },
        )
        test_db.add(device)
        test_db.commit()
        test_db.refresh(device)

        class SessionProxy:
            def query(self, *args, **kwargs):
                return test_db.query(*args, **kwargs)

            def close(self):
                pass

        get_online_info = AsyncMock(return_value={"name": "APB22015038"})
        monkeypatch.setattr("app.db.session.SessionLocal", lambda: SessionProxy())
        monkeypatch.setattr(
            "app.services.device_service.device_service.get_device_online_info",
            get_online_info,
        )

        selection = await DeviceSelectionManager.get_selection_from_user_preference(
            test_user.id
        )

        execution_target = f"app-record-{device.id}"
        assert selection == DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id=execution_target,
            device_name="APB22015038",
        )
        get_online_info.assert_awaited_once_with(test_user.id, execution_target)

    @pytest.mark.asyncio
    async def test_set_selection(self):
        """Test setting device selection."""
        selection = DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="device-123",
            device_name="My Mac",
        )
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_selection(123, selection)

            assert result is True
            mock_cache.set.assert_called_once()
            call_args = mock_cache.set.call_args
            assert call_args[0][0] == f"{CHANNEL_USER_DEVICE_PREFIX}123"
            assert call_args[0][1] == selection.to_dict()
            assert call_args[1]["expire"] == CHANNEL_USER_DEVICE_TTL

    @pytest.mark.asyncio
    async def test_clear_selection(self):
        """Test clearing device selection."""
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.delete = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.clear_selection(123)

            assert result is True
            mock_cache.delete.assert_called_once_with(
                f"{CHANNEL_USER_DEVICE_PREFIX}123"
            )

    @pytest.mark.asyncio
    async def test_set_local_device(self):
        """Test setting local device selection."""
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_local_device(
                123, "device-123", "My Mac"
            )

            assert result is True
            call_args = mock_cache.set.call_args
            data = call_args[0][1]
            assert data["device_type"] == "local"
            assert data["device_id"] == "device-123"
            assert data["device_name"] == "My Mac"

    @pytest.mark.asyncio
    async def test_set_cloud_executor(self):
        """Test setting cloud executor selection."""
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_cloud_executor(123)

            assert result is True
            call_args = mock_cache.set.call_args
            data = call_args[0][1]
            assert data["device_type"] == "cloud"

    @pytest.mark.asyncio
    async def test_set_chat_mode(self):
        """Test persisting chat mode as an explicit selection."""
        with patch(
            "app.services.channels.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_chat_mode(123)

            assert result is True
            mock_cache.set.assert_awaited_once_with(
                f"{CHANNEL_USER_DEVICE_PREFIX}123",
                {
                    "device_type": "chat",
                    "device_id": None,
                    "device_name": None,
                },
                expire=CHANNEL_USER_DEVICE_TTL,
            )


class TestModuleInstance:
    """Tests for module-level instance."""

    def test_device_selection_manager_exists(self):
        """Test that device_selection_manager instance exists."""
        assert device_selection_manager is not None
        assert isinstance(device_selection_manager, DeviceSelectionManager)
