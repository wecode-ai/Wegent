# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.channels.callback import ChannelType
from app.services.channels.manager import ChannelManager


def test_channel_type_includes_weibo():
    assert ChannelType.WEIBO.value == "weibo"


def test_channel_manager_registers_weibo_provider():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()

    assert "weibo" in manager.get_supported_channel_types()
