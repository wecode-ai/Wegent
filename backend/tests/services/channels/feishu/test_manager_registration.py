# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.channels.manager import ChannelManager


def test_manager_supports_feishu_channel_type():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()

    assert "feishu" in manager.get_supported_channel_types()
