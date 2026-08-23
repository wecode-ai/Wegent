# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for optional Seedance asset-library staging."""

from typing import Any

import pytest

from app.core.config import settings
from app.services.execution.agents.video.providers.seedance_assets import (
    prepare_seedance_reference_images,
)


class _Response:
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        self.status_code = 200
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self.payload


class _Client:
    def __init__(self, responses: list[_Response]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append({"url": url, **kwargs})
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_asset_staging_is_skipped_without_group_id(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SEEDANCE_ASSET_GROUP_ID", "")
    client = _Client([])
    images = [{"url": "https://example.com/reference.png"}]

    prepared, _ = await prepare_seedance_reference_images(
        client=client,  # type: ignore[arg-type]
        reference_images=images,
        reference_image=None,
        wecode_user="yansheng3",
    )

    assert prepared == images
    assert client.calls == []


@pytest.mark.asyncio
async def test_asset_staging_passes_asset_url_to_seedance(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SEEDANCE_ASSET_GROUP_ID", "group-1")
    monkeypatch.setattr(
        settings,
        "SEEDANCE_ASSET_BASE_URL",
        "https://asset.example.com/seedance",
    )
    client = _Client([_Response({"Id": "asset-1", "Status": "Active"})])

    prepared, _ = await prepare_seedance_reference_images(
        client=client,  # type: ignore[arg-type]
        reference_images=[{"url": "https://example.com/reference.png"}],
        reference_image=None,
        wecode_user="yansheng3",
    )

    assert prepared == [{"url": "asset://asset-1"}]
    assert client.calls[0]["url"].endswith("/CreateAsset")
    assert client.calls[0]["json"]["GroupId"] == "group-1"
    assert client.calls[0]["headers"]["wecode-user"] == "yansheng3"
