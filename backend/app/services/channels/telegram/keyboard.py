# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Inline Keyboard Builder.

This module provides utilities for building Telegram inline keyboards
for interactive commands like model selection, device selection, and
execution mode switching.
"""

import logging
from enum import Enum
from typing import List, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

logger = logging.getLogger(__name__)


class CallbackAction(str, Enum):
    """Callback action types for inline keyboard buttons."""

    SELECT_MODEL = "model"
    SELECT_DEVICE = "device"
    SET_MODE = "mode"
    CANCEL = "cancel"


class TelegramKeyboardBuilder:
    """
    Builder for Telegram inline keyboards.

    Creates interactive keyboard layouts for various commands,
    allowing users to select options via button clicks.
    """

    # Maximum buttons per row
    MAX_BUTTONS_PER_ROW = 2

    @staticmethod
    def build_models_keyboard(
        models: List[dict],
        current_model_name: Optional[str] = None,
    ) -> InlineKeyboardMarkup:
        """
        Build inline keyboard for model selection.

        Args:
            models: List of model dictionaries with 'name', 'displayName', 'provider'
            current_model_name: Currently selected model name (to mark with ✓)

        Returns:
            InlineKeyboardMarkup with model selection buttons
        """
        keyboard = []
        row = []

        for idx, model in enumerate(models, start=1):
            model_name = model.get("name", "")
            display_name = model.get("displayName") or model_name
            provider = model.get("provider", "")

            # Truncate long names
            if len(display_name) > 20:
                display_name = display_name[:17] + "..."

            # Mark current selection
            prefix = "✓ " if model_name == current_model_name else ""
            button_text = f"{prefix}{idx}. {display_name}"

            # Callback data format: model:{index}
            callback_data = f"{CallbackAction.SELECT_MODEL.value}:{idx}"

            row.append(InlineKeyboardButton(button_text, callback_data=callback_data))

            if len(row) >= TelegramKeyboardBuilder.MAX_BUTTONS_PER_ROW:
                keyboard.append(row)
                row = []

        # Add remaining buttons
        if row:
            keyboard.append(row)

        # Add cancel button
        keyboard.append(
            [
                InlineKeyboardButton(
                    "❌ 取消",
                    callback_data=f"{CallbackAction.CANCEL.value}:models",
                )
            ]
        )

        return InlineKeyboardMarkup(keyboard)

    @staticmethod
    def build_devices_keyboard(
        devices: List[dict],
        current_device_id: Optional[str] = None,
    ) -> InlineKeyboardMarkup:
        """
        Build inline keyboard for device selection.

        Args:
            devices: List of device dictionaries with 'device_id', 'name', 'status'
            current_device_id: Currently selected device ID (to mark with ⭐)

        Returns:
            InlineKeyboardMarkup with device selection buttons
        """
        keyboard = []
        row = []

        # Filter online devices
        online_devices = [d for d in devices if d.get("status") != "offline"]

        for idx, device in enumerate(online_devices, start=1):
            device_id = device.get("device_id", "")
            device_name = device.get("name", device_id[:8])
            status = device.get("status", "")

            # Truncate long names
            if len(device_name) > 15:
                device_name = device_name[:12] + "..."

            # Mark current selection and busy status
            prefix = ""
            if device_id == current_device_id:
                prefix = "⭐ "
            elif status == "busy":
                prefix = "🔴 "

            button_text = f"{prefix}{idx}. {device_name}"

            # Callback data format: device:{index}
            callback_data = f"{CallbackAction.SELECT_DEVICE.value}:{idx}"

            row.append(InlineKeyboardButton(button_text, callback_data=callback_data))

            if len(row) >= TelegramKeyboardBuilder.MAX_BUTTONS_PER_ROW:
                keyboard.append(row)
                row = []

        # Add remaining buttons
        if row:
            keyboard.append(row)

        if not online_devices:
            keyboard.append(
                [InlineKeyboardButton("暂无在线设备", callback_data="noop")]
            )

        # Add cancel button
        keyboard.append(
            [
                InlineKeyboardButton(
                    "❌ 取消",
                    callback_data=f"{CallbackAction.CANCEL.value}:devices",
                )
            ]
        )

        return InlineKeyboardMarkup(keyboard)

    @staticmethod
    def build_mode_keyboard(current_mode: Optional[str] = None) -> InlineKeyboardMarkup:
        """
        Build inline keyboard for execution mode selection.

        Args:
            current_mode: Current execution mode ('chat', 'device', 'cloud')

        Returns:
            InlineKeyboardMarkup with mode selection buttons
        """
        modes = [
            ("chat", "💬 对话模式", "Direct AI conversation"),
            ("device", "💻 设备模式", "Execute on local device"),
            ("cloud", "☁️ 云端模式", "Execute on cloud container"),
        ]

        keyboard = []
        for mode_key, mode_name, mode_desc in modes:
            prefix = "✓ " if mode_key == current_mode else ""
            button_text = f"{prefix}{mode_name}"
            callback_data = f"{CallbackAction.SET_MODE.value}:{mode_key}"
            keyboard.append(
                [InlineKeyboardButton(button_text, callback_data=callback_data)]
            )

        # Add cancel button
        keyboard.append(
            [
                InlineKeyboardButton(
                    "❌ 取消",
                    callback_data=f"{CallbackAction.CANCEL.value}:mode",
                )
            ]
        )

        return InlineKeyboardMarkup(keyboard)

    @staticmethod
    def parse_callback_data(callback_data: str) -> tuple[str, str]:
        """
        Parse callback data from inline keyboard button.

        Args:
            callback_data: Callback data string in format 'action:value'

        Returns:
            Tuple of (action, value)
        """
        if ":" in callback_data:
            parts = callback_data.split(":", 1)
            return parts[0], parts[1]
        return callback_data, ""
