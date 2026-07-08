# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.project import ProjectConfig


def test_workspace_project_can_be_cross_device_without_execution_target():
    config = ProjectConfig.model_validate({"mode": "workspace"})

    assert config.is_workspace is True
    assert config.execution is None
    assert config.workspace is None


def test_workspace_project_git_config_accepts_cloud_relative_checkout_path():
    config = ProjectConfig.model_validate(
        {
            "mode": "workspace",
            "execution": {"targetType": "cloud"},
            "team": {"id": 12, "namespace": "default"},
            "workspace": {"source": "git", "checkoutPath": "projects/demo"},
            "git": {
                "url": "https://github.com/example/repo.git",
                "repo": "example/repo",
                "domain": "github.com",
                "branch": "main",
            },
        }
    )

    assert config.is_workspace is True
    assert config.workspace.checkoutPath == "projects/demo"


def test_workspace_project_git_config_defaults_checkout_path_to_safe_repo_key():
    config = ProjectConfig.model_validate(
        {
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git"},
            "git": {
                "url": "https://github.com/wecode-ai/Wegent.git",
                "repo": "wecode-ai/Wegent",
                "domain": "github.com",
                "branch": "main",
            },
        }
    )

    assert config.workspace.checkoutPath == "Wegent"


def test_workspace_project_rejects_cloud_absolute_checkout_path():
    with pytest.raises(ValidationError):
        ProjectConfig.model_validate(
            {
                "mode": "workspace",
                "execution": {"targetType": "cloud"},
                "team": {"id": 12, "namespace": "default"},
                "workspace": {"source": "git", "checkoutPath": "/tmp/repo"},
                "git": {"url": "https://github.com/example/repo.git"},
            }
        )


def test_workspace_project_local_path_requires_local_target():
    with pytest.raises(ValidationError):
        ProjectConfig.model_validate(
            {
                "mode": "workspace",
                "execution": {"targetType": "cloud"},
                "team": {"id": 12, "namespace": "default"},
                "workspace": {"source": "local_path", "localPath": "/Users/me/repo"},
            }
        )


def test_workspace_project_accepts_cloud_device_path():
    config = ProjectConfig.model_validate(
        {
            "mode": "workspace",
            "execution": {"targetType": "cloud", "deviceId": "cloud-crd"},
            "team": {"id": 12, "namespace": "default"},
            "workspace": {"source": "device_path", "devicePath": "/workspace/repo"},
        }
    )

    assert config.execution.targetType == "cloud"
    assert config.execution.deviceId == "cloud-crd"
    assert config.workspace.source == "device_path"
    assert config.workspace.devicePath == "/workspace/repo"


def test_workspace_project_accepts_remote_device_path():
    config = ProjectConfig.model_validate(
        {
            "mode": "workspace",
            "execution": {"targetType": "remote", "deviceId": "remote-device"},
            "team": {"id": 12, "namespace": "default"},
            "workspace": {"source": "device_path", "devicePath": "/srv/repo"},
        }
    )

    assert config.execution.targetType == "remote"
    assert config.execution.deviceId == "remote-device"
    assert config.workspace.source == "device_path"
    assert config.workspace.devicePath == "/srv/repo"


def test_workspace_project_device_path_rejects_local_target():
    with pytest.raises(ValidationError):
        ProjectConfig.model_validate(
            {
                "mode": "workspace",
                "execution": {"targetType": "local", "deviceId": "device-1"},
                "team": {"id": 12, "namespace": "default"},
                "workspace": {"source": "device_path", "devicePath": "/tmp/repo"},
            }
        )


def test_workspace_project_remote_requires_device_id():
    with pytest.raises(ValidationError):
        ProjectConfig.model_validate(
            {
                "mode": "workspace",
                "execution": {"targetType": "remote"},
                "team": {"id": 12, "namespace": "default"},
                "workspace": {"source": "device_path", "devicePath": "/srv/repo"},
            }
        )


def test_workspace_project_device_path_requires_device_path():
    with pytest.raises(ValidationError):
        ProjectConfig.model_validate(
            {
                "mode": "workspace",
                "execution": {"targetType": "cloud", "deviceId": "cloud-crd"},
                "team": {"id": 12, "namespace": "default"},
                "workspace": {"source": "device_path"},
            }
        )


def test_project_config_accepts_model_selection_without_workspace_mode():
    config = ProjectConfig.model_validate(
        {
            "modelSelection": {
                "modelName": "overseas-gpt-5.4",
                "modelType": "user",
                "options": {"reasoning": "medium"},
            }
        }
    )

    assert config.modelSelection.modelName == "overseas-gpt-5.4"
    assert config.modelSelection.options == {"reasoning": "medium"}
