# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Protocol coverage for versioned external assignment against a recording provider."""

from unittest.mock import Mock

from app.core.provider_credentials import store_provider_config
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_items.external_provider import external_loop_item_provider
from tests.e2e._dingtalk_card_server import GITLAB_ISSUE_PATH, RecordingGitLabServer
from tests.services.test_external_loop_item_execution import _make_gitlab_project


def test_version_read_and_assignment_use_two_provider_reads_before_write(
    test_db, test_user, monkeypatch
):
    project = _make_gitlab_project(test_db, test_user)
    server = RecordingGitLabServer(
        title="Versioned provider assignment", description="", labels=[]
    )
    server.start()
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", Mock())
    try:
        project.metadata_json = {
            **project.metadata_json,
            "provider_config": store_provider_config(
                "gitlab",
                {
                    "repository": "wegent/card-e2e",
                    "api_base": server.api_base,
                    "token": "protocol-test-token",
                },
            ),
        }
        test_db.commit()
        item_id = f"{project.project_key}-1"
        current = external_loop_item_provider.get(test_db, item_id, test_user.id)

        result = external_loop_item_provider.assign(
            test_db,
            item_id,
            test_user.id,
            LoopItemAssign(
                version=current["version"],
                assignee_type="user",
                assignee_id=str(test_user.id),
                notify_assignee=False,
            ),
        )

        assert result["assignee_user_id"] == test_user.id
        assert [(method, path) for method, path, _ in server.requests] == [
            ("GET", GITLAB_ISSUE_PATH),
            ("GET", GITLAB_ISSUE_PATH),
            ("PUT", GITLAB_ISSUE_PATH),
        ]
        assert f"wegent:assignee:user:{test_user.id}" in server.requests[-1][2][
            "labels"
        ].split(",")
    finally:
        server.stop()
