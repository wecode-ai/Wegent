# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device provider module.

This module implements a provider-based architecture for managing different
types of devices (local, cloud, etc.) using the Strategy pattern.
"""

from app.services.device.base_provider import BaseDeviceProvider
from app.services.device.local_provider import LocalDeviceProvider
from app.services.device.provider_factory import DeviceProviderFactory

__all__ = [
    "BaseDeviceProvider",
    "LocalDeviceProvider",
    "DeviceProviderFactory",
]
