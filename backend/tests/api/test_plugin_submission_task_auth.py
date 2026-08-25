"""Task-token authentication for Plugin Creator workspace publication."""

from datetime import datetime

from fastapi.testclient import TestClient

from app.schemas.installed_plugin import (
    PluginSubmissionInitResponse,
    PluginSubmissionItem,
)


def test_task_token_can_initialize_personal_plugin_submission(
    test_client: TestClient,
    test_task_token: str,
    mocker,
) -> None:
    init_submission = mocker.patch(
        "app.api.endpoints.installed_plugins.plugin_marketplace_service.init_submission",
        return_value=PluginSubmissionInitResponse(
            submissionId=31,
            pluginId=41,
            releaseId=51,
            uploadUrl="http://storage.invalid/upload",
            expiresAt=datetime(2026, 8, 25, 12, 0, 0),
        ),
    )

    response = test_client.post(
        "/api/plugins/submissions/init",
        headers={"Authorization": f"Bearer {test_task_token}"},
        json={
            "slug": "workspace-plugin",
            "displayName": "Workspace Plugin",
            "version": "0.1.0",
            "filename": "workspace-plugin.zip",
            "sha256": "a" * 64,
            "sizeBytes": 128,
            "listingType": "plugin",
            "visibility": "personal",
            "targets": [],
            "allowCopy": False,
        },
    )

    assert response.status_code == 201
    assert response.json()["submissionId"] == 31
    init_submission.assert_called_once()


def test_task_token_can_read_own_plugin_submission(
    test_client: TestClient,
    test_task_token: str,
    mocker,
) -> None:
    get_submission = mocker.patch(
        "app.api.endpoints.installed_plugins.plugin_marketplace_service.get_submission",
        return_value=PluginSubmissionItem(
            id=31,
            pluginId=41,
            releaseId=51,
            purpose="restricted_share",
            status="approved",
            submittedAt=datetime(2026, 8, 25, 12, 0, 0),
        ),
    )

    response = test_client.get(
        "/api/plugins/submissions/31",
        headers={"Authorization": f"Bearer {test_task_token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    get_submission.assert_called_once()
