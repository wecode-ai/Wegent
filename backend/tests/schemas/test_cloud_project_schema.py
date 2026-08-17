# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.cloud_project import CloudProjectCreate


def test_aitable_project_keeps_only_non_sensitive_locator_config() -> None:
    project = CloudProjectCreate(
        name="AI Table",
        task_provider="dingtalk_aitable",
        provider_config={
            "base_id": " base-1 ",
            "table_id": " table-1 ",
            "source_url": "https://alidocs.dingtalk.com/i/nodes/base-1",
        },
    )

    assert project.provider_config["base_id"] == "base-1"
    assert project.provider_config["table_id"] == "table-1"


def test_aitable_project_rejects_access_tokens() -> None:
    with pytest.raises(ValidationError, match="managed by the local Executor"):
        CloudProjectCreate(
            name="AI Table",
            task_provider="dingtalk_aitable",
            provider_config={
                "base_id": "base-1",
                "table_id": "table-1",
                "token": "must-not-be-stored",
            },
        )
