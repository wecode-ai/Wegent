# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.exceptions import CustomHTTPException
from app.services.knowledge.folder_policy import (
    DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
    DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE,
    FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
    FOLDER_DEPTH_EXCEEDED_MESSAGE,
)


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_folder_returns_stable_error_code_for_depth_limit(
    test_client: TestClient,
    test_token: str,
):
    with patch(
        "app.api.endpoints.knowledge.KnowledgeFolderService.create_folder",
        side_effect=CustomHTTPException(
            status_code=400,
            detail=FOLDER_DEPTH_EXCEEDED_MESSAGE,
            error_code=FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
        ),
    ):
        response = test_client.post(
            "/api/knowledge-bases/1/folders",
            json={"name": "too-deep", "parent_id": 999},
            headers=_auth_header(test_token),
        )

    assert response.status_code == 400
    payload = response.json()
    assert payload["detail"] == FOLDER_DEPTH_EXCEEDED_MESSAGE
    assert payload["error_code"] == FOLDER_DEPTH_EXCEEDED_ERROR_CODE


def test_move_document_returns_stable_error_code_for_target_folder_depth_limit(
    test_client: TestClient,
    test_token: str,
):
    with patch(
        "app.api.endpoints.knowledge.KnowledgeFolderService.move_document",
        side_effect=CustomHTTPException(
            status_code=400,
            detail=DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE,
            error_code=DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE,
        ),
    ):
        response = test_client.put(
            "/api/knowledge-documents/9/move",
            json={"folder_id": 999},
            headers=_auth_header(test_token),
        )

    assert response.status_code == 400
    payload = response.json()
    assert payload["detail"] == DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE
    assert payload["error_code"] == DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE
