# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Channels service module.

This module provides support for multiple IM platform integrations:
- DingTalk (Stream mode)
- Feishu/Lark (planned)
- Telegram (planned)
- Slack (planned)
- WeChat Work (planned)

Each channel is configured via the database (Messager CRD in kinds table) and managed
by the ChannelManager singleton.

Architecture:
- BaseChannelProvider: Abstract base class for channel providers (connection lifecycle)
- BaseChannelHandler: Abstract base class for message handlers (message processing)
- BaseChannelCallbackService: Abstract base class for callback services (task results)
- ChannelManager: Singleton manager for all channel instances
- ChannelCallbackRegistry: Registry for callback services

Generic Utilities (channel-agnostic):
- commands: Command parsing (/new, /help, /devices, /use, /status)
- device_selection: Device selection management (chat/local/cloud modes)
- emitter: Response emitters (SyncResponseEmitter, CompositeEmitter)
"""

from app.services.channels.base import BaseChannelProvider
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelCallbackRegistry,
    ChannelType,
    get_callback_registry,
)
from app.services.channels.commands import (
    DEVICE_ITEM_TEMPLATE,
    DEVICES_EMPTY,
    DEVICES_FOOTER,
    DEVICES_HEADER,
    HELP_MESSAGE,
    STATUS_TEMPLATE,
    CommandType,
    ParsedCommand,
    parse_command,
)
from app.services.channels.device_selection import (
    DeviceSelection,
    DeviceSelectionManager,
    DeviceType,
    device_selection_manager,
)
from app.services.channels.emitter import CompositeEmitter, SyncResponseEmitter
from app.services.channels.handler import (
    BaseChannelHandler,
    MessageContext,
    UserMappingConfig,
)
from app.services.channels.manager import ChannelManager, get_channel_manager

__all__ = [
    # Base classes
    "BaseChannelProvider",
    "BaseChannelHandler",
    "BaseChannelCallbackService",
    "BaseCallbackInfo",
    # Data classes
    "MessageContext",
    "UserMappingConfig",
    "ParsedCommand",
    "DeviceSelection",
    # Enums
    "ChannelType",
    "CommandType",
    "DeviceType",
    # Manager and Registry
    "ChannelManager",
    "ChannelCallbackRegistry",
    "DeviceSelectionManager",
    "device_selection_manager",
    # Emitters
    "SyncResponseEmitter",
    "CompositeEmitter",
    # Command utilities
    "parse_command",
    "HELP_MESSAGE",
    "STATUS_TEMPLATE",
    "DEVICES_HEADER",
    "DEVICES_EMPTY",
    "DEVICES_FOOTER",
    "DEVICE_ITEM_TEMPLATE",
    # Factory functions
    "get_channel_manager",
    "get_callback_registry",
]
