# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramChannelProvider."""

from types import SimpleNamespace
from unittest.mock import patch

from app.services.channels.telegram.service import (
    TELEGRAM_GET_UPDATES_READ_TIMEOUT_SECONDS,
    TELEGRAM_REQUEST_TIMEOUT_SECONDS,
    TelegramChannelProvider,
)


class FakeApplicationBuilder:
    """Records ApplicationBuilder calls without creating network clients."""

    def __init__(self):
        self.application = SimpleNamespace(bot=SimpleNamespace())
        self.calls = []

    def _record(self, name: str, value):
        self.calls.append((name, value))
        return self

    def token(self, value):
        return self._record("token", value)

    def connect_timeout(self, value):
        return self._record("connect_timeout", value)

    def read_timeout(self, value):
        return self._record("read_timeout", value)

    def write_timeout(self, value):
        return self._record("write_timeout", value)

    def pool_timeout(self, value):
        return self._record("pool_timeout", value)

    def get_updates_connect_timeout(self, value):
        return self._record("get_updates_connect_timeout", value)

    def get_updates_read_timeout(self, value):
        return self._record("get_updates_read_timeout", value)

    def get_updates_write_timeout(self, value):
        return self._record("get_updates_write_timeout", value)

    def get_updates_pool_timeout(self, value):
        return self._record("get_updates_pool_timeout", value)

    def build(self):
        self.calls.append(("build", None))
        return self.application


def _telegram_channel() -> SimpleNamespace:
    return SimpleNamespace(
        id=53,
        name="telegram",
        channel_type="telegram",
        is_enabled=True,
        config={"bot_token": "123:token", "use_inline_keyboard": True},
        default_team_id=38,
        default_model_name="",
    )


def test_build_application_configures_telegram_network_timeouts():
    provider = TelegramChannelProvider(_telegram_channel())
    builder = FakeApplicationBuilder()

    with patch(
        "app.services.channels.telegram.service.Application.builder",
        return_value=builder,
    ):
        application = provider._build_application()

    assert application is builder.application
    assert builder.calls == [
        ("token", "123:token"),
        ("connect_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("read_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("write_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("pool_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("get_updates_connect_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("get_updates_read_timeout", TELEGRAM_GET_UPDATES_READ_TIMEOUT_SECONDS),
        ("get_updates_write_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("get_updates_pool_timeout", TELEGRAM_REQUEST_TIMEOUT_SECONDS),
        ("build", None),
    ]
