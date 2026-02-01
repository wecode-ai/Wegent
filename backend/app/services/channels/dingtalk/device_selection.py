# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk User Device Selection Management.

This module re-exports the generic device selection for backward compatibility.
The actual implementation is in app.services.channels.device_selection.
"""

# Re-export all from generic device_selection module for backward compatibility
from app.services.channels.device_selection import (
    DeviceSelection,
    DeviceSelectionManager,
    DeviceType,
    device_selection_manager,
)

__all__ = [
    "DeviceType",
    "DeviceSelection",
    "DeviceSelectionManager",
    "device_selection_manager",
]
