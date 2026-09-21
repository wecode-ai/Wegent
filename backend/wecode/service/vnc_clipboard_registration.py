# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Register cloud-only VNC clipboard commands in the device command service."""

from app.schemas.device import DeviceType
from app.services.device.command_registry import LocalDeviceCommandDefinition
from app.services.device.command_service import register_device_command
from wecode.service.vnc_clipboard_commands import (
    VNC_CLIPBOARD_READ_COMMAND,
    VNC_CLIPBOARD_WRITE_COMMAND,
)


def register_vnc_clipboard_commands() -> None:
    for key, command in (
        ("vnc_clipboard_read", VNC_CLIPBOARD_READ_COMMAND),
        ("vnc_clipboard_write", VNC_CLIPBOARD_WRITE_COMMAND),
    ):
        register_device_command(
            key,
            LocalDeviceCommandDefinition(command=command),
            allowed_device_types=frozenset({DeviceType.CLOUD}),
        )
