# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo channel provider."""

from app.services.channels.base import BaseChannelProvider, ChannelLike


class WeiboChannelProvider(BaseChannelProvider):
    """Minimal Weibo provider skeleton."""

    def __init__(self, channel: ChannelLike):
        super().__init__(channel)

    async def start(self) -> bool:
        self._set_error("Weibo provider is not implemented")
        return False

    async def stop(self) -> None:
        self._set_running(False)
