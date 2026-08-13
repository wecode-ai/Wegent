# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException, Response

from wecode.api.knowledge_video_play import resolve_video_play_url


@pytest.mark.asyncio
async def test_resolve_video_play_url_uses_attachment_mime_type() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=11, attachment_id=22
    )
    user = SimpleNamespace(id=7)
    context = SimpleNamespace(
        type_data={"fid": "123", "mime_type": "video/webm"},
        mime_type="video/webm",
    )

    with (
        patch(
            "wecode.api.knowledge_video_play._get_kb_video_attachment",
            return_value=context,
        ) as get_attachment,
        patch(
            "wecode.api.knowledge_video_play.weibo_media_service.get_download_url",
            return_value="https://cdn.example.com/video.webm",
        ),
    ):
        raw_response = Response()
        response = await resolve_video_play_url(
            11,
            response=raw_response,
            db=db,
            current_user=user,
        )

    get_attachment.assert_called_once_with(db, 22, 7, document_id=11)
    assert response.url == "https://cdn.example.com/video.webm"
    assert response.mime_type == "video/webm"
    assert raw_response.headers["cache-control"] == "no-store, private"
    filters = db.query.return_value.filter.call_args.args
    assert any("knowledge_documents.is_active" in str(value) for value in filters)


@pytest.mark.asyncio
async def test_resolve_video_play_url_hides_missing_document() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    with pytest.raises(HTTPException) as exc_info:
        await resolve_video_play_url(
            999,
            response=Response(),
            db=db,
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_resolve_video_play_url_rejects_invalid_fid() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=11, attachment_id=22
    )
    context = SimpleNamespace(type_data={"fid": "invalid"}, mime_type="video/mp4")

    with patch(
        "wecode.api.knowledge_video_play._get_kb_video_attachment",
        return_value=context,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await resolve_video_play_url(
                11,
                response=Response(),
                db=db,
                current_user=SimpleNamespace(id=7),
            )

    assert exc_info.value.status_code == 400
