# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace


@pytest.mark.asyncio
async def test_store_device_capabilities_state_preserves_plugin_report(monkeypatch):
    stored = {}

    async def fake_store(user_id, device_id, capabilities):
        stored["user_id"] = user_id
        stored["device_id"] = device_id
        stored["capabilities"] = capabilities
        return True

    monkeypatch.setattr(
        device_namespace.device_service,
        "get_device_capabilities_state",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        device_namespace.device_service,
        "store_device_capabilities_state",
        fake_store,
    )

    await device_namespace._store_device_capabilities_state(
        1,
        "device-1",
        {
            "revision": 2,
            "digest": "sha256:test",
            "full": True,
            "skills": [{"name": "browser", "source": "local_user"}],
            "mcps": [{"name": "docs", "source": "wegent"}],
            "plugins": [
                {
                    "name": "context7",
                    "marketplace": "claude-plugins-official",
                    "scope": "user",
                    "version": "1057d02c5307",
                    "source": "local_user",
                }
            ],
        },
    )

    assert stored["capabilities"]["plugins"] == [
        {
            "name": "context7",
            "marketplace": "claude-plugins-official",
            "scope": "user",
            "version": "1057d02c5307",
            "source": "local_user",
        }
    ]
