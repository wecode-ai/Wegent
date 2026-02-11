# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramKeyboardBuilder."""

from unittest.mock import MagicMock

import pytest

from app.services.channels.telegram.keyboard import (
    CallbackAction,
    TelegramKeyboardBuilder,
)


class TestTelegramKeyboardBuilder:
    """Tests for TelegramKeyboardBuilder."""

    def test_build_models_keyboard_basic(self):
        """Test building models keyboard with basic models."""
        models = [
            {"name": "model1", "displayName": "Model 1", "provider": "openai"},
            {"name": "model2", "displayName": "Model 2", "provider": "anthropic"},
        ]

        keyboard = TelegramKeyboardBuilder.build_models_keyboard(models)

        assert keyboard is not None
        # Should have model rows + cancel button
        assert len(keyboard.inline_keyboard) >= 2

    def test_build_models_keyboard_with_current_selection(self):
        """Test building models keyboard with current selection marked."""
        models = [
            {"name": "model1", "displayName": "Model 1", "provider": "openai"},
            {"name": "model2", "displayName": "Model 2", "provider": "anthropic"},
        ]

        keyboard = TelegramKeyboardBuilder.build_models_keyboard(
            models, current_model_name="model1"
        )

        # First model should have checkmark
        first_button = keyboard.inline_keyboard[0][0]
        assert "✓" in first_button.text

    def test_build_models_keyboard_truncates_long_names(self):
        """Test that long model names are truncated."""
        models = [
            {
                "name": "model1",
                "displayName": "A Very Long Model Name That Should Be Truncated",
                "provider": "openai",
            },
        ]

        keyboard = TelegramKeyboardBuilder.build_models_keyboard(models)

        first_button = keyboard.inline_keyboard[0][0]
        # Should be truncated with ...
        assert "..." in first_button.text or len(first_button.text) <= 30

    def test_build_devices_keyboard_basic(self):
        """Test building devices keyboard with basic devices."""
        devices = [
            {"device_id": "dev1", "name": "Device 1", "status": "online"},
            {"device_id": "dev2", "name": "Device 2", "status": "online"},
        ]

        keyboard = TelegramKeyboardBuilder.build_devices_keyboard(devices)

        assert keyboard is not None
        # Should have device rows + cancel button
        assert len(keyboard.inline_keyboard) >= 2

    def test_build_devices_keyboard_filters_offline(self):
        """Test that offline devices are filtered out."""
        devices = [
            {"device_id": "dev1", "name": "Device 1", "status": "online"},
            {"device_id": "dev2", "name": "Device 2", "status": "offline"},
        ]

        keyboard = TelegramKeyboardBuilder.build_devices_keyboard(devices)

        # Should only have 1 device button + cancel
        # Cancel button is always last
        non_cancel_rows = [
            row
            for row in keyboard.inline_keyboard
            if not any("取消" in btn.text for btn in row)
        ]
        assert len(non_cancel_rows) == 1

    def test_build_devices_keyboard_marks_current(self):
        """Test that current device is marked."""
        devices = [
            {"device_id": "dev1", "name": "Device 1", "status": "online"},
            {"device_id": "dev2", "name": "Device 2", "status": "online"},
        ]

        keyboard = TelegramKeyboardBuilder.build_devices_keyboard(
            devices, current_device_id="dev1"
        )

        first_button = keyboard.inline_keyboard[0][0]
        assert "⭐" in first_button.text

    def test_build_devices_keyboard_marks_busy(self):
        """Test that busy devices are marked."""
        devices = [
            {"device_id": "dev1", "name": "Device 1", "status": "busy"},
        ]

        keyboard = TelegramKeyboardBuilder.build_devices_keyboard(devices)

        first_button = keyboard.inline_keyboard[0][0]
        assert "🔴" in first_button.text

    def test_build_devices_keyboard_empty(self):
        """Test building keyboard with no online devices."""
        devices = [
            {"device_id": "dev1", "name": "Device 1", "status": "offline"},
        ]

        keyboard = TelegramKeyboardBuilder.build_devices_keyboard(devices)

        # Should have "no devices" message + cancel
        assert any(
            "暂无" in btn.text for row in keyboard.inline_keyboard for btn in row
        )

    def test_build_mode_keyboard(self):
        """Test building execution mode keyboard."""
        keyboard = TelegramKeyboardBuilder.build_mode_keyboard()

        assert keyboard is not None
        # Should have 3 modes + cancel button
        assert len(keyboard.inline_keyboard) == 4

        # Check mode names
        mode_texts = [row[0].text for row in keyboard.inline_keyboard if len(row) == 1]
        assert any("对话" in text for text in mode_texts)
        assert any("设备" in text for text in mode_texts)
        assert any("云端" in text for text in mode_texts)

    def test_build_mode_keyboard_marks_current(self):
        """Test that current mode is marked."""
        keyboard = TelegramKeyboardBuilder.build_mode_keyboard(current_mode="chat")

        # Find chat mode button
        chat_button = None
        for row in keyboard.inline_keyboard:
            for btn in row:
                if "对话" in btn.text:
                    chat_button = btn
                    break

        assert chat_button is not None
        assert "✓" in chat_button.text

    def test_parse_callback_data_with_value(self):
        """Test parsing callback data with action and value."""
        action, value = TelegramKeyboardBuilder.parse_callback_data("model:5")

        assert action == "model"
        assert value == "5"

    def test_parse_callback_data_without_value(self):
        """Test parsing callback data without value."""
        action, value = TelegramKeyboardBuilder.parse_callback_data("cancel")

        assert action == "cancel"
        assert value == ""

    def test_parse_callback_data_with_colon_in_value(self):
        """Test parsing callback data with colon in value."""
        action, value = TelegramKeyboardBuilder.parse_callback_data("mode:chat:extra")

        assert action == "mode"
        assert value == "chat:extra"

    def test_callback_action_enum(self):
        """Test CallbackAction enum values."""
        assert CallbackAction.SELECT_MODEL.value == "model"
        assert CallbackAction.SELECT_DEVICE.value == "device"
        assert CallbackAction.SET_MODE.value == "mode"
        assert CallbackAction.CANCEL.value == "cancel"
