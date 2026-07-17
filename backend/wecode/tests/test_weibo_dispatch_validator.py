# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for the Weibo dispatch validator.

The validator is registered via register_dispatch_validator() and runs AFTER
the universal preflight. It receives an already-validated MultimodalDispatchContext
and only *injects* Weibo-specific fields via dataclasses.replace — it does NOT
skip the universal validation.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.knowledge.multimodal_dispatch import MultimodalDispatchContext
from wecode.config.multimodal_config import multimodal_settings
from wecode.service.knowledge.weibo_dispatch_validator import (
    weibo_dispatch_validator,
)


def _make_video_ctx(**overrides) -> MultimodalDispatchContext:
    """Build a minimal video ctx as the universal flow would construct it."""
    defaults = dict(
        media_type="video",
        model_ref={"name": "gemini", "namespace": "default", "type": "public"},
        uploader_id=1,
        uploader_name="tester",
        original_filename="test.mp4",
        video_source_ref=None,
    )
    defaults.update(overrides)
    return MultimodalDispatchContext(**defaults)


def _make_image_ctx(**overrides) -> MultimodalDispatchContext:
    """Build a minimal image ctx as the universal flow would construct it."""
    defaults = dict(
        media_type="image",
        model_ref={"name": "gemini", "namespace": "default", "type": "public"},
        uploader_id=1,
        uploader_name="tester",
        original_filename="test.jpg",
        content_download_path="/api/internal/attachments/1/download",
    )
    defaults.update(overrides)
    return MultimodalDispatchContext(**defaults)


def _make_fake_db(attachment=None):
    """Build a fake DB session that returns ``attachment`` for any query."""
    query = MagicMock()
    query.filter.return_value = query
    query.first.return_value = attachment
    db = SimpleNamespace(query=MagicMock(return_value=query))
    return db


def _make_user(uid=1, name="tester"):
    return SimpleNamespace(id=uid, user_name=name)


def _make_kb(model_ref=None):
    return SimpleNamespace(
        json={"spec": {"multimodalAnalysisModelRef": model_ref or {"name": "gemini"}}}
    )


class TestRegistration:
    """The validator is registered at import time via register_dispatch_validator."""

    def test_validator_is_registered(self):
        from app.services.knowledge.multimodal_dispatch import (
            build_dispatch_validator,
        )

        assert build_dispatch_validator() is weibo_dispatch_validator


class TestVideoWithFid:
    """Video attachments with a fid get Weibo source + GCS paths injected."""

    def test_injects_fid_and_paths(self):
        """video+fid → replace injects fid + GCS paths, preserves universal fields."""
        base_ctx = _make_video_ctx(
            model_ref={"name": "gemini-pro"},
            uploader_id=42,
            uploader_name="alice",
            original_filename="clip.mp4",
        )
        attachment = SimpleNamespace(
            id=42,
            type_data={"fid": 12345, "storage_backend": "weibo"},
        )
        db = _make_fake_db(attachment)

        result = weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(),
            attachment_id=42,
            uploader=_make_user(),
            file_extension="mp4",
        )

        # Injected fields
        assert result.video_source_ref == {"fid": 12345}
        assert (
            result.video_download_url_path
            == "/api/internal/attachments/42/video-download-url"
        )
        assert result.gcs_upload_path == multimodal_settings.MULTIMODAL_GCS_UPLOAD_PATH
        assert result.gcs_delete_path is None
        # Universal fields preserved (replace doesn't drop them)
        assert result.media_type == "video"
        assert result.model_ref == {"name": "gemini-pro"}
        assert result.uploader_id == 42
        assert result.uploader_name == "alice"
        assert result.original_filename == "clip.mp4"

    def test_no_staging_switch_flip(self, monkeypatch):
        """The global staging switch is never touched (no concurrency race)."""
        from app.core.config import settings as app_settings

        monkeypatch.setattr(
            app_settings, "KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED", False
        )
        base_ctx = _make_video_ctx()
        attachment = SimpleNamespace(id=42, type_data={"fid": 1})
        db = _make_fake_db(attachment)

        weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(),
            attachment_id=42,
            uploader=_make_user(),
            file_extension="mp4",
        )

        # The switch remains unchanged — the validator injects fields post-hoc.
        assert app_settings.KNOWLEDGE_MULTIMODAL_VIDEO_STAGING_ENABLED is False


class TestVideoWithoutFid:
    """Video attachments without a fid return ctx unchanged (defer to downstream gate)."""

    def test_returns_ctx_unchanged_when_no_fid(self):
        base_ctx = _make_video_ctx()
        attachment = SimpleNamespace(id=42, type_data={})
        db = _make_fake_db(attachment)

        result = weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(),
            attachment_id=42,
            uploader=_make_user(),
            file_extension="mp4",
        )

        # ctx returned unchanged — downstream closed-loop gate rejects it.
        assert result is base_ctx
        assert result.video_source_ref is None


class TestImage:
    """Image attachments get the GCS upload path injected."""

    def test_injects_gcs_path(self):
        base_ctx = _make_image_ctx(original_filename="pic.jpg")
        db = _make_fake_db()

        result = weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(),
            attachment_id=10,
            uploader=_make_user(),
            file_extension="jpg",
        )

        assert result.media_type == "image"
        assert result.gcs_upload_path == multimodal_settings.MULTIMODAL_GCS_UPLOAD_PATH
        # Universal fields preserved
        assert result.content_download_path == "/api/internal/attachments/1/download"
        assert result.original_filename == "pic.jpg"
        assert result.gcs_delete_path is None

    def test_preserves_uploader_identity(self):
        base_ctx = _make_image_ctx(
            model_ref={"name": "gemini-pro"},
            uploader_id=99,
            uploader_name="alice",
        )
        db = _make_fake_db()

        result = weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(model_ref={"name": "gemini-pro"}),
            attachment_id=10,
            uploader=_make_user(uid=99, name="alice"),
            file_extension="png",
        )

        assert result.uploader_id == 99
        assert result.uploader_name == "alice"
        assert result.model_ref == {"name": "gemini-pro"}


class TestNonMultimodal:
    """Non-video, non-image media types return ctx unchanged."""

    def test_returns_ctx_unchanged_for_other_media_type(self):
        base_ctx = _make_image_ctx(media_type="other")
        db = _make_fake_db()

        result = weibo_dispatch_validator(
            base_ctx,
            db=db,
            knowledge_base=_make_kb(),
            attachment_id=1,
            uploader=_make_user(),
            file_extension="pdf",
        )

        assert result is base_ctx
