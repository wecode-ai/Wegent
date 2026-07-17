# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for the internal video-download-url resolver endpoint."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.config import settings
from app.models.subtask_context import ContextType
from wecode.api.internal import attachments_video


@pytest.fixture(autouse=True)
def _configure_token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _internal_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"}


def _make_app() -> FastAPI:
    app = FastAPI()
    # The router already has prefix="/attachments"; we add "/internal".
    app.include_router(attachments_video.router, prefix="/internal")
    return app


def _make_attachment(attachment_id: int, fid=None, user_id=1):
    """Build a fake SubtaskContext-like object."""
    type_data = {}
    if fid is not None:
        # Weibo-backed video attachments carry both the fid and the
        # storage_backend marker that the endpoint's scoping check requires.
        type_data = {"fid": fid, "storage_backend": "weibo"}
    return SimpleNamespace(
        id=attachment_id,
        context_type=ContextType.ATTACHMENT.value,
        type_data=type_data,
        user_id=user_id,
    )


class TestResolveVideoDownloadUrl:
    """resolve_video_download_url converts a Weibo fid to a CDN URL."""

    def test_success_returns_url_and_ttl(self, httpx_mock):
        attachment = _make_attachment(42, fid=12345)
        # Query 1: SubtaskContext, Query 2: KnowledgeDocument (scoping check),
        # Query 3: User (uploader for Weibo auth signing).
        kb_doc = SimpleNamespace(id=1, attachment_id=42, kind_id=10)
        mock_query = MagicMock()
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = attachment
        kb_query = MagicMock()
        kb_query.filter.return_value = kb_query
        kb_query.first.return_value = kb_doc
        mock_user = SimpleNamespace(id=1, user_name="tester")
        user_query = MagicMock()
        user_query.filter.return_value = user_query
        user_query.first.return_value = mock_user
        mock_db = SimpleNamespace(
            query=MagicMock(side_effect=[mock_query, kb_query, user_query])
        )

        app = _make_app()
        from app.api.dependencies import get_db

        app.dependency_overrides[get_db] = lambda: mock_db

        with patch.object(attachments_video, "context_service") as mock_ctx:
            mock_ctx.is_video_context.return_value = True
            with patch.object(attachments_video, "weibo_media_service") as mock_media:
                mock_media.get_download_url.return_value = (
                    "https://cdn.example.com/video.mp4"
                )

                response = TestClient(app).get(
                    "/internal/attachments/42/video-download-url",
                    headers=_internal_headers(),
                )

        assert response.status_code == 200
        body = response.json()
        assert body["url"] == "https://cdn.example.com/video.mp4"
        assert body["expires_in"] == 1800

    def test_attachment_not_found_returns_404(self):
        mock_query = MagicMock()
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None
        mock_db = SimpleNamespace(query=MagicMock(return_value=mock_query))

        app = _make_app()
        from app.api.dependencies import get_db

        app.dependency_overrides[get_db] = lambda: mock_db

        response = TestClient(app).get(
            "/internal/attachments/999/video-download-url",
            headers=_internal_headers(),
        )
        assert response.status_code == 404

    def test_no_fid_returns_404(self):
        """Attachment exists, linked to a KB doc, is a Weibo video, but has no fid → 400."""
        # Build an attachment that passes the storage_backend + video checks
        # (so the scoping guard passes) but lacks the fid itself.
        attachment = SimpleNamespace(
            id=42,
            context_type=ContextType.ATTACHMENT.value,
            type_data={"storage_backend": "weibo"},  # no fid
            user_id=1,
        )
        kb_doc = SimpleNamespace(id=1, attachment_id=42, kind_id=10)
        mock_query = MagicMock()
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = attachment
        kb_query = MagicMock()
        kb_query.filter.return_value = kb_query
        kb_query.first.return_value = kb_doc
        mock_db = SimpleNamespace(query=MagicMock(side_effect=[mock_query, kb_query]))

        app = _make_app()
        from app.api.dependencies import get_db

        app.dependency_overrides[get_db] = lambda: mock_db

        with patch.object(attachments_video, "context_service") as mock_ctx:
            mock_ctx.is_video_context.return_value = True
            response = TestClient(app).get(
                "/internal/attachments/42/video-download-url",
                headers=_internal_headers(),
            )
        # No fid on a Weibo-backed video is a data-integrity issue → 400.
        assert response.status_code == 400

    def test_download_url_returns_none_returns_502(self):
        attachment = _make_attachment(42, fid=12345)
        kb_doc = SimpleNamespace(id=1, attachment_id=42, kind_id=10)
        mock_query = MagicMock()
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = attachment
        kb_query = MagicMock()
        kb_query.filter.return_value = kb_query
        kb_query.first.return_value = kb_doc
        mock_user = SimpleNamespace(id=1)
        user_query = MagicMock()
        user_query.filter.return_value = user_query
        user_query.first.return_value = mock_user
        mock_db = SimpleNamespace(
            query=MagicMock(side_effect=[mock_query, kb_query, user_query])
        )

        app = _make_app()
        from app.api.dependencies import get_db

        app.dependency_overrides[get_db] = lambda: mock_db

        with patch.object(attachments_video, "context_service") as mock_ctx:
            mock_ctx.is_video_context.return_value = True
            with patch.object(attachments_video, "weibo_media_service") as mock_media:
                mock_media.get_download_url.return_value = None

                response = TestClient(app).get(
                    "/internal/attachments/42/video-download-url",
                    headers=_internal_headers(),
                )
        assert response.status_code == 502

    def test_download_url_raises_exception_returns_502(self):
        attachment = _make_attachment(42, fid=12345)
        kb_doc = SimpleNamespace(id=1, attachment_id=42, kind_id=10)
        mock_query = MagicMock()
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = attachment
        kb_query = MagicMock()
        kb_query.filter.return_value = kb_query
        kb_query.first.return_value = kb_doc
        mock_user = SimpleNamespace(id=1)
        user_query = MagicMock()
        user_query.filter.return_value = user_query
        user_query.first.return_value = mock_user
        mock_db = SimpleNamespace(
            query=MagicMock(side_effect=[mock_query, kb_query, user_query])
        )

        app = _make_app()
        from app.api.dependencies import get_db

        app.dependency_overrides[get_db] = lambda: mock_db

        with patch.object(attachments_video, "context_service") as mock_ctx:
            mock_ctx.is_video_context.return_value = True
            with patch.object(attachments_video, "weibo_media_service") as mock_media:
                mock_media.get_download_url.side_effect = RuntimeError("network error")

                response = TestClient(app).get(
                    "/internal/attachments/42/video-download-url",
                    headers=_internal_headers(),
                )
        assert response.status_code == 502
