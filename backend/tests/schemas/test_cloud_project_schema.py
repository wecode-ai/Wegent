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


@pytest.mark.parametrize("task_provider", ["github", "gitlab"])
def test_issue_security_is_independent_of_provider(
    task_provider: str,
) -> None:
    provider_config: dict[str, object]
    provider_config = {"repository": "owner/repository"}

    project = CloudProjectCreate(
        name="External project",
        task_provider=task_provider,
        provider_config=provider_config,
        visibility="public",
        public_access={"role": "Viewer"},
        default_issue_security="related",
    )
    assert project.public_access is not None
    assert project.public_access.role == "Viewer"
    assert project.default_issue_security == "related"


def test_aitable_record_security_remains_with_dingtalk() -> None:
    with pytest.raises(ValidationError, match="DingTalk table records"):
        CloudProjectCreate(
            name="AI Table",
            task_provider="dingtalk_aitable",
            provider_config={"base_id": "base-1", "table_id": "table-1"},
            default_issue_security="related",
        )
