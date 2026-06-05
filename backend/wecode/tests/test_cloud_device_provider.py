# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wecode cloud device provider creation behavior."""

import pytest

from wecode.service import cloud_device_provider as provider_module
from wecode.service.cloud_device_provider import CloudDeviceProvider


class _FakeNevisClient:
    def __init__(self):
        self.create_sandbox_kwargs = None

    def is_configured(self):
        return True

    async def create_sandbox(self, **kwargs):
        self.create_sandbox_kwargs = kwargs
        return {"id": "sandbox-1"}


@pytest.mark.asyncio
async def test_create_device_passes_git_token_envs_to_nevis(test_db, monkeypatch):
    """Cloud device creation should set git token envs on the Nevis VM."""
    client = _FakeNevisClient()
    provider = CloudDeviceProvider(client=client)
    monkeypatch.setattr(
        provider_module.nevis_settings,
        "NEVIS_OPENCLAW_INSTALL_SCRIPT_URL",
        "",
    )

    await provider.create_device(
        db=test_db,
        user_id=7,
        user_name="alice",
        auth_token="device-api-key",
        backend_url="https://backend.example.com",
        git_tokens=[
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "git-intra-token",
            },
            {
                "type": "gitlab",
                "git_domain": "gitlab.weibo.cn",
                "git_token": "gitlab-weibo-token",
            },
        ],
    )

    assert client.create_sandbox_kwargs["envs"] == {
        "GIT_INTRA_WEIBO_COM_TOKEN": "git-intra-token",
        "GITLAB_WEIBO_CN_TOKEN": "gitlab-weibo-token",
    }
