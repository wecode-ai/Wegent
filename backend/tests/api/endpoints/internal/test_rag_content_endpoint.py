# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import pytest
from fastapi.responses import StreamingResponse

from app.api.endpoints.internal.rag_content import stream_rag_attachment_content
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.auth.rag_download_token import create_rag_download_token


def _create_attachment_context(test_db, attachment_id: int = 301) -> SubtaskContext:
    context = SubtaskContext(
        id=attachment_id,
        subtask_id=0,
        user_id=8,
        context_type=ContextType.ATTACHMENT.value,
        name="release-plan.txt",
        status=ContextStatus.READY.value,
        type_data={
            "original_filename": "release-plan.txt",
            "file_extension": ".txt",
            "file_size": 12,
            "mime_type": "text/plain",
            "storage_backend": "mysql",
            "storage_key": "attachments/release-plan.txt",
        },
    )
    test_db.add(context)
    test_db.commit()
    return context


def test_internal_rag_content_rejects_missing_auth(test_client) -> None:
    response = test_client.get("/api/internal/rag/content/301")

    assert response.status_code == 401


def test_internal_rag_content_rejects_invalid_auth(test_client) -> None:
    response = test_client.get(
        "/api/internal/rag/content/301",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401


def test_internal_rag_content_streams_allowed_attachment(test_client, test_db) -> None:
    context = _create_attachment_context(test_db)
    token = create_rag_download_token(attachment_id=context.id)

    with patch(
        "app.api.endpoints.internal.rag_content.context_service.get_attachment_binary_data",
        return_value=b"release plan",
    ):
        response = test_client.get(
            f"/api/internal/rag/content/{context.id}",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.content == b"release plan"
    assert response.headers["content-type"].startswith("text/plain")


@pytest.mark.asyncio
async def test_internal_rag_content_returns_streaming_response(test_db) -> None:
    context = _create_attachment_context(test_db)

    with (
        patch(
            "app.api.endpoints.internal.rag_content.context_service.get_context_optional",
            return_value=context,
        ),
        patch(
            "app.api.endpoints.internal.rag_content.context_service.get_attachment_binary_data",
            return_value=b"release plan",
        ),
    ):
        response = await stream_rag_attachment_content(
            attachment_id=context.id,
            _=None,
            db=test_db,
        )

    assert isinstance(response, StreamingResponse)
