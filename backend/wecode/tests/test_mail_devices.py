# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for mail device extension dispatch."""

from types import SimpleNamespace

import pytest

from wecode.api import mail_devices
from wecode.schemas.mail import MailConfigRequest


class _FakeDeviceService:
    def get_device_by_device_id(self, db, user_id: int, device_id: str):
        return SimpleNamespace(json={"spec": {"deviceType": "local"}})

    async def get_device_online_info_by_type(
        self, user_id: int, device_id: str, device_type
    ):
        return {"socket_id": "socket-1"}


class _FakeSocketIo:
    def __init__(self):
        self.call_args = None

    async def call(self, event, payload, **kwargs):
        self.call_args = (event, payload, kwargs)
        return {
            "success": True,
            "message": "Mail config created",
            "account_name": "alice-mail",
            "config_path": "/home/alice/.config/himalaya/config.toml",
        }


@pytest.mark.asyncio
async def test_create_mail_config_dispatches_global_skill_extension(monkeypatch):
    socket = _FakeSocketIo()
    monkeypatch.setattr(mail_devices, "device_service", _FakeDeviceService())
    monkeypatch.setattr(mail_devices, "get_sio", lambda: socket)

    response = await mail_devices.create_mail_config(
        device_id="device-1",
        request=MailConfigRequest(
            task_id=123,
            account_prefix="alice",
            email_domain="@staff.weibo.com",
            password="mail-password",
        ),
        db=SimpleNamespace(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    event, payload, kwargs = socket.call_args
    assert event == "device:run_extension"
    assert payload["extension_scope"] == "global"
    assert payload["extension_name"] == "mail"
    assert payload["script_path"] == "scripts/mail-executor-ext.sh"
    assert kwargs == {
        "to": "socket-1",
        "namespace": "/local-executor",
        "timeout": 60,
    }
