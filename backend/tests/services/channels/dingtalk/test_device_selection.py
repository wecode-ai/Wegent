# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk device selection manager."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.channels.dingtalk.device_selection import (
    DINGTALK_USER_DEVICE_PREFIX,
    DINGTALK_USER_DEVICE_TTL,
    DeviceSelection,
    DeviceSelectionManager,
    DeviceType,
    device_selection_manager,
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


class TestDeviceSelectionManager:
    """Tests for DeviceSelectionManager."""

    def test_generate_key(self):
        """Test Redis key generation."""
        key = DeviceSelectionManager._generate_key(123)
        assert key == f"{DINGTALK_USER_DEVICE_PREFIX}123"

    @pytest.mark.asyncio
    async def test_get_selection_no_cache(self):
        """Test getting selection when no cache exists."""
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=None)

            selection = await DeviceSelectionManager.get_selection(123)

            assert selection.device_type == DeviceType.CHAT
            mock_cache.get.assert_called_once_with(f"{DINGTALK_USER_DEVICE_PREFIX}123")

    @pytest.mark.asyncio
    async def test_get_selection_with_cache(self):
        """Test getting selection from cache."""
        cached_data = {
            "device_type": "local",
            "device_id": "device-123",
            "device_name": "My Mac",
        }
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=cached_data)

            selection = await DeviceSelectionManager.get_selection(123)

            assert selection.device_type == DeviceType.LOCAL
            assert selection.device_id == "device-123"
            assert selection.device_name == "My Mac"

    @pytest.mark.asyncio
    async def test_set_selection(self):
        """Test setting device selection."""
        selection = DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="device-123",
            device_name="My Mac",
        )
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_selection(123, selection)

            assert result is True
            mock_cache.set.assert_called_once()
            call_args = mock_cache.set.call_args
            assert call_args[0][0] == f"{DINGTALK_USER_DEVICE_PREFIX}123"
            assert call_args[0][1] == selection.to_dict()
            assert call_args[1]["expire"] == DINGTALK_USER_DEVICE_TTL

    @pytest.mark.asyncio
    async def test_clear_selection(self):
        """Test clearing device selection."""
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.delete = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.clear_selection(123)

            assert result is True
            mock_cache.delete.assert_called_once_with(
                f"{DINGTALK_USER_DEVICE_PREFIX}123"
            )

    @pytest.mark.asyncio
    async def test_set_local_device(self):
        """Test setting local device selection."""
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
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
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_cloud_executor(123)

            assert result is True
            call_args = mock_cache.set.call_args
            data = call_args[0][1]
            assert data["device_type"] == "cloud"

    @pytest.mark.asyncio
    async def test_set_chat_mode(self):
        """Test setting chat mode (clearing selection)."""
        with patch(
            "app.services.channels.dingtalk.device_selection.cache_manager"
        ) as mock_cache:
            mock_cache.delete = AsyncMock(return_value=True)

            result = await DeviceSelectionManager.set_chat_mode(123)

            assert result is True
            mock_cache.delete.assert_called_once()


class TestModuleInstance:
    """Tests for module-level instance."""

    def test_device_selection_manager_exists(self):
        """Test that device_selection_manager instance exists."""
        assert device_selection_manager is not None
        assert isinstance(device_selection_manager, DeviceSelectionManager)
