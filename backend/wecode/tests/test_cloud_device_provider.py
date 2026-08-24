# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wecode cloud device provider creation behavior."""

import base64
from unittest.mock import AsyncMock

import pytest

from app.models.kind import Kind
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
async def test_slot_usage_preserves_unbounded_cloud_device_semantics(
    test_db, monkeypatch
):
    """Cloud devices should keep reporting running tasks with max=0."""
    provider = CloudDeviceProvider(client=_FakeNevisClient())
    monkeypatch.setattr(
        provider,
        "_get_online_info",
        AsyncMock(return_value={"running_task_ids": [101, 202]}),
    )
    monkeypatch.setattr(
        provider_module.task_stores.task_store,
        "list_by_ids",
        lambda db, task_ids: [],
    )

    result = await provider.get_slot_usage(
        db=test_db,
        user_id=7,
        device_id="cloud-device-1",
    )

    assert result == {
        "used": 2,
        "max": 0,
        "running_tasks": [],
    }


@pytest.mark.asyncio
async def test_create_device_passes_runtime_envs_to_nevis(test_db, monkeypatch):
    """Cloud device creation should set stable Worktree runtime envs on the VM."""
    client = _FakeNevisClient()
    provider = CloudDeviceProvider(client=client)
    monkeypatch.setattr(
        provider_module.nevis_settings,
        "NEVIS_OPENCLAW_INSTALL_SCRIPT_URL",
        "",
    )

    result = await provider.create_device(
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

    envs = client.create_sandbox_kwargs["envs"]
    assert envs["GIT_INTRA_WEIBO_COM_TOKEN"] == "git-intra-token"
    assert envs["GITLAB_WEIBO_CN_TOKEN"] == "gitlab-weibo-token"
    assert envs["DEVICE_TYPE"] == "cloud"
    assert envs["WEGENT_EXECUTOR_HOME"] == "/home/ubuntu/.wegent-executor"
    assert envs["LOCAL_WORKSPACE_ROOT"] == ("/home/ubuntu/.wegent-executor/workspace")
    assert envs["WEGENT_EXECUTOR_HOME_ID"] == result["device_id"]
    assert envs["WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"] == "true"


@pytest.mark.asyncio
async def test_create_device_generates_and_persists_ubuntu_password(
    test_db, monkeypatch
):
    """Cloud device creation should set and store the ubuntu login password."""
    client = _FakeNevisClient()
    provider = CloudDeviceProvider(client=client)
    monkeypatch.setattr(
        provider_module.nevis_settings,
        "NEVIS_OPENCLAW_INSTALL_SCRIPT_URL",
        "",
    )
    monkeypatch.setattr(
        provider_module.secrets,
        "token_urlsafe",
        lambda token_bytes: "generated-ubuntu-password",
    )

    result = await provider.create_device(
        db=test_db,
        user_id=7,
        user_name="alice",
        auth_token="device-api-key",
        backend_url="https://backend.example.com",
    )

    user_data = client.create_sandbox_kwargs["user_data"]
    script = base64.b64decode(user_data).decode("utf-8")
    assert 'echo "ubuntu:generated-ubuntu-password" | sudo chpasswd' in script

    device = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == 7,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == result["device_id"],
        )
        .one()
    )
    cloud_config = device.json["spec"]["cloudConfig"]
    assert cloud_config["ubuntuInitialPassword"] == "generated-ubuntu-password"
