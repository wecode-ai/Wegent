from types import SimpleNamespace

import pytest

from app.services.chat.trigger import unified


def _request(supports_video: bool | None):
    model_capabilities = {}
    if supports_video is not None:
        model_capabilities["supportsVideo"] = supports_video
    return SimpleNamespace(
        model_config={
            "model_id": "test-model",
            "modelCapabilities": model_capabilities,
        }
    )


def _context(extension: str):
    return SimpleNamespace(
        context_type="attachment",
        file_extension=extension,
    )


def test_video_context_requires_video_capable_model(monkeypatch):
    monkeypatch.setattr(
        unified.context_service,
        "get_attachments_by_subtask",
        lambda db, subtask_id: [_context(".mp4")],
    )

    with pytest.raises(ValueError, match="does not support video input attachments"):
        unified._ensure_video_context_supported(
            db=object(),
            request=_request(False),
            user_subtask_id=123,
        )


def test_video_context_allows_video_capable_model(monkeypatch):
    monkeypatch.setattr(
        unified.context_service,
        "get_attachments_by_subtask",
        lambda db, subtask_id: [_context(".mp4")],
    )

    unified._ensure_video_context_supported(
        db=object(),
        request=_request(True),
        user_subtask_id=123,
    )


def test_non_video_context_does_not_require_video_capable_model(monkeypatch):
    monkeypatch.setattr(
        unified.context_service,
        "get_attachments_by_subtask",
        lambda db, subtask_id: [_context(".txt")],
    )

    unified._ensure_video_context_supported(
        db=object(),
        request=_request(False),
        user_subtask_id=123,
    )
