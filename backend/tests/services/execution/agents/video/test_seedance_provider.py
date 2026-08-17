# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.video.providers import get_video_provider
from app.services.execution.agents.video.providers.seedance import (
    SeedanceProvider,
    _content_item_for_log,
    _media_url_diagnostics,
    _media_url_for_log,
    _reject_credential_media_urls,
    _response_value_for_log,
)


class _Response:
    status_code = 200
    text = ""

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class _Client:
    def __init__(self):
        self.post_kwargs = None
        self.get_kwargs = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def post(self, url, **kwargs):
        self.post_kwargs = {"url": url, **kwargs}
        return _Response({"id": "job-1"})

    async def get(self, url, **kwargs):
        self.get_kwargs = {"url": url, **kwargs}
        return _Response({"status": "running", "progress": 0})


def test_factory_does_not_override_default_model_with_none() -> None:
    provider = get_video_provider(
        "seedance",
        {
            "base_url": "https://example.com",
            "api_key": "test-key",
            "videoConfig": {},
        },
    )

    assert "model" not in provider.video_config


def test_media_url_for_log_removes_signed_query() -> None:
    item = {
        "type": "image_url",
        "image_url": {
            "url": (
                "https://cdn.example.com/path/image.png"
                "?credential=secret&signature=value"
            )
        },
    }

    assert (
        _media_url_for_log(item) == "https://cdn.example.com/path/image.png?<redacted>"
    )


def test_media_url_for_log_keeps_public_cdn_url() -> None:
    item = {
        "type": "image_url",
        "image_url": {
            "url": "https://cdn.example.com/path/image.png",
        },
    }

    assert _media_url_for_log(item) == "https://cdn.example.com/path/image.png"


def test_media_url_diagnostics_exposes_credential_parameter_names() -> None:
    item = {
        "type": "image_url",
        "image_url": {
            "url": (
                "https://cdn.example.com/path/image.png"
                "?credential=secret&signature=value&style=preview"
            ),
        },
    }

    assert _media_url_diagnostics(item) == {
        "has_query": True,
        "query_keys": ["credential", "signature", "style"],
        "credential_query_detected": True,
        "credential_query_keys": ["credential", "signature"],
    }


def test_rejects_credential_media_urls() -> None:
    with pytest.raises(ValueError, match="public CDN endpoint"):
        _reject_credential_media_urls(
            [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": (
                            "https://storage.example.com/image.png"
                            "?credential=secret&signature=value"
                        ),
                    },
                    "role": "reference_image",
                }
            ]
        )


@pytest.mark.asyncio
async def test_seedance_does_not_send_credential_media_url(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
    )

    with pytest.raises(ValueError, match="public CDN endpoint"):
        await provider.create_job(
            prompt="Generate a video",
            reference_images=[
                {
                    "url": (
                        "https://storage.example.com/image.png"
                        "?credential=secret&signature=value"
                    )
                }
            ],
            image_mode="reference",
        )

    assert client.post_kwargs is None


def test_allows_scoped_application_token() -> None:
    _reject_credential_media_urls(
        [
            {
                "type": "image_url",
                "image_url": {
                    "url": "https://backend.example.com/image.png?token=scoped",
                },
                "role": "reference_image",
            }
        ]
    )


@pytest.mark.asyncio
async def test_seedance_passes_resolved_headers_without_query_params(
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
        video_config={"model": "seedance-test"},
        default_headers={"x-user-context": "resolved-user"},
    )

    await provider.create_job(prompt="Generate a video")
    await provider.get_status("job-1")

    assert "params" not in client.post_kwargs
    assert "params" not in client.get_kwargs
    assert client.post_kwargs["headers"]["x-user-context"] == "resolved-user"
    assert client.get_kwargs["headers"]["x-user-context"] == "resolved-user"


@pytest.mark.asyncio
async def test_seedance_leaves_missing_progress_for_poller_estimation(
    monkeypatch,
) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
    )

    status = await provider.get_status("job-1")

    assert status.progress == 0


@pytest.mark.asyncio
async def test_seedance_assigns_extra_images_as_references(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
        video_config={"model": "seedance-test"},
    )

    await provider.create_job(
        prompt="Generate a video",
        image_mode="first_frame",
        reference_images=[
            {"url": "https://example.com/first.png"},
            {"url": "https://example.com/last.png"},
            {"url": "https://example.com/reference.png"},
        ],
    )

    image_content = client.post_kwargs["json"]["content"][1:]
    assert [item["role"] for item in image_content] == [
        "first_frame",
        "last_frame",
        "reference_image",
    ]


@pytest.mark.asyncio
async def test_seedance_passes_through_external_content_blocks(monkeypatch) -> None:
    client = _Client()
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.httpx.AsyncClient",
        lambda **kwargs: client,
    )
    provider = SeedanceProvider(
        base_url="https://example.com",
        api_key="test-key",
    )
    monkeypatch.setattr(
        "app.services.execution.agents.video.providers.seedance.build_external_provider_content",
        lambda *, media_type, descriptor, role, **_: {
            "type": f"external_{media_type}_reference",
            f"external_{media_type}_reference": descriptor["external_reference"]["id"],
            "role": role,
        },
    )

    await provider.create_job(
        prompt="Generate a video",
        reference_videos=[
            {"external_reference": {"id": "video-123"}},
        ],
        reference_audios=[
            {"external_reference": {"id": "audio-456"}},
        ],
    )

    assert client.post_kwargs["json"]["content"][1:] == [
        {
            "type": "external_video_reference",
            "external_video_reference": "video-123",
            "role": "reference_video",
        },
        {
            "type": "external_audio_reference",
            "external_audio_reference": "audio-456",
            "role": "reference_audio",
        },
    ]


def test_seedance_request_log_preserves_text_and_external_content() -> None:
    assert _content_item_for_log(
        {
            "type": "text",
            "text": "Generate a video",
        }
    ) == {
        "type": "text",
        "text": "Generate a video",
    }
    assert _content_item_for_log(
        {
            "type": "external_video_reference",
            "external_video_reference": "video-123",
            "role": "reference_video",
        }
    ) == {
        "type": "external_video_reference",
        "external_video_reference": "video-123",
        "role": "reference_video",
    }
    assert _content_item_for_log(
        {
            "type": "external_audio_reference",
            "external_audio_reference": "audio-456",
            "role": "reference_audio",
        }
    ) == {
        "type": "external_audio_reference",
        "external_audio_reference": "audio-456",
        "role": "reference_audio",
    }


def test_seedance_request_log_redacts_only_url_credentials() -> None:
    assert _content_item_for_log(
        {
            "type": "image_url",
            "image_url": {
                "url": "https://cdn.example.com/image.png?signature=secret",
            },
            "role": "reference_image",
        }
    ) == {
        "type": "image_url",
        "image_url": {
            "url": "https://cdn.example.com/image.png?<redacted>",
        },
        "role": "reference_image",
        "has_query": True,
        "query_keys": ["signature"],
        "credential_query_detected": True,
        "credential_query_keys": ["signature"],
    }
    assert _content_item_for_log(
        {
            "type": "image_url",
            "image_url": {
                "url": "https://cdn.example.com/image.png",
            },
            "role": "reference_image",
        }
    ) == {
        "type": "image_url",
        "image_url": {
            "url": "https://cdn.example.com/image.png",
        },
        "role": "reference_image",
        "has_query": False,
        "query_keys": [],
        "credential_query_detected": False,
        "credential_query_keys": [],
    }


def test_seedance_response_log_redacts_nested_url_queries() -> None:
    assert _response_value_for_log(
        {
            "content": {
                "video_url": "https://cdn.example.com/video.mp4?token=temporary",
            },
            "status": "succeeded",
        }
    ) == {
        "content": {
            "video_url": "https://cdn.example.com/video.mp4?<redacted>",
        },
        "status": "succeeded",
    }
