# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from PIL import Image

from app.api.endpoints.admin import public_teams


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 24), color=(68, 104, 229)).save(output, format="PNG")
    return output.getvalue()


def test_admin_uploads_and_serves_public_team_icon(
    test_client,
    test_admin_token,
):
    uploaded = test_client.post(
        "/api/admin/public-teams/icon-assets",
        files={"file": ("team.png", _png_bytes(), "image/png")},
        headers=_headers(test_admin_token),
    )

    assert uploaded.status_code == 201
    asset = uploaded.json()
    assert asset["url"] == (
        f"/api/resource-library/assets/team-icons/{asset['asset_id']}"
    )

    served = test_client.get(asset["url"])

    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"
    assert served.headers["cache-control"] == "public, max-age=31536000, immutable"
    with Image.open(io.BytesIO(served.content)) as image:
        assert image.format == "WEBP"
        assert image.size == (512, 512)

    deleted = test_client.delete(
        f"/api/admin/public-teams/icon-assets/{asset['asset_id']}",
        headers=_headers(test_admin_token),
    )

    assert deleted.status_code == 204
    assert test_client.get(asset["url"]).status_code == 404


def test_non_admin_cannot_upload_public_team_icon(
    test_client,
    test_token,
):
    response = test_client.post(
        "/api/admin/public-teams/icon-assets",
        files={"file": ("team.png", _png_bytes(), "image/png")},
        headers=_headers(test_token),
    )

    assert response.status_code == 403


def test_public_team_icon_rejects_invalid_image(
    test_client,
    test_admin_token,
):
    response = test_client.post(
        "/api/admin/public-teams/icon-assets",
        files={"file": ("team.png", b"not-an-image", "image/png")},
        headers=_headers(test_admin_token),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid image file"


def test_public_team_icon_rejects_excessive_pixel_dimensions(monkeypatch):
    image = MagicMock()
    image.format = "PNG"
    image.width = 4097
    image.height = 4097
    image.__enter__.return_value = image
    monkeypatch.setattr(public_teams.Image, "open", lambda _content: image)

    with pytest.raises(HTTPException) as exc_info:
        public_teams._normalize_team_icon(b"compressed-image")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Team icon dimensions are too large"
    image.convert.assert_not_called()
