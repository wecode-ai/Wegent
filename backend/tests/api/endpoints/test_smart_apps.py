# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import ANY, Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.endpoints import smart_apps
from app.services.marketplace_artifact_storage import MarketplaceArtifactStorageError
from app.services.smart_app_download_link import build_smart_app_download_url
from app.services.smart_app_marketplace_service import SmartAppArtifactDownload


def test_init_submission_reports_storage_unavailable(monkeypatch) -> None:
    def fail_init(*_args, **_kwargs):
        raise MarketplaceArtifactStorageError("connection refused")

    monkeypatch.setattr(
        smart_apps.smart_app_marketplace_service,
        "init_submission",
        fail_init,
    )

    with pytest.raises(HTTPException) as raised:
        smart_apps.init_submission(
            request=Mock(),
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    assert raised.value.status_code == 503
    assert raised.value.detail == {
        "code": "smart_app_storage_unavailable",
        "message": "Smart app file storage is unavailable",
    }


def test_ticketed_artifact_download_streams_through_backend(
    test_client: TestClient, monkeypatch
) -> None:
    resolve_artifact = Mock(
        return_value=SmartAppArtifactDownload(
            storage_key="smart-apps/releases/3/8/package.zip",
            filename="research-desk-1.0.0.zip",
            size_bytes=9,
        )
    )
    open_download = Mock(return_value=iter([b"smart-", b"app"]))
    monkeypatch.setattr(
        smart_apps.smart_app_marketplace_service,
        "download_artifact",
        resolve_artifact,
    )
    monkeypatch.setattr(
        smart_apps.marketplace_artifact_storage,
        "open_download",
        open_download,
    )
    download_url, _expires_at = build_smart_app_download_url(
        smart_app_id=3,
        release_id=8,
        user_id=7,
    )

    response = test_client.get(download_url)

    assert response.status_code == 200
    assert response.content == b"smart-app"
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-length"] == "9"
    assert response.headers["cache-control"] == "private, no-store"
    assert "research-desk-1.0.0.zip" in response.headers["content-disposition"]
    resolve_artifact.assert_called_once_with(
        ANY,
        smart_app_id=3,
        release_id=8,
        user_id=7,
    )
    open_download.assert_called_once_with("smart-apps/releases/3/8/package.zip")


def test_ticketed_artifact_download_rejects_wrong_app_scope(
    test_client: TestClient,
) -> None:
    download_url, _expires_at = build_smart_app_download_url(
        smart_app_id=3,
        release_id=8,
        user_id=7,
    )

    response = test_client.get(
        download_url.replace("/marketplace/3/", "/marketplace/4/")
    )

    assert response.status_code == 403
