# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, Mock

from fastapi.testclient import TestClient

from app.api.endpoints import installed_plugins, plugin_publications, smart_apps
from app.core.config import settings
from app.services.marketplace_submission_upload import (
    build_marketplace_submission_upload_url,
    build_plugin_publication_upload_url,
)


def test_smart_app_submission_upload_streams_through_backend(
    test_client: TestClient, monkeypatch
) -> None:
    upload = Mock()
    monkeypatch.setattr(
        smart_apps.smart_app_marketplace_service,
        "upload_submission_package",
        upload,
    )
    upload_url, _ = build_marketplace_submission_upload_url(
        kind="smart_app", submission_id=9, user_id=7
    )

    response = test_client.put(
        upload_url,
        content=b"smart-app",
        headers={"Content-Type": "application/zip"},
    )

    assert response.status_code == 204
    upload.assert_called_once_with(
        ANY,
        submission_id=9,
        user_id=7,
        package=b"smart-app",
    )


def test_plugin_submission_upload_streams_through_backend(
    test_client: TestClient, monkeypatch
) -> None:
    upload = Mock()
    monkeypatch.setattr(
        installed_plugins.plugin_marketplace_service,
        "upload_submission_package",
        upload,
    )
    upload_url, _ = build_marketplace_submission_upload_url(
        kind="plugin", submission_id=11, user_id=5
    )

    response = test_client.put(
        upload_url,
        content=b"plugin",
        headers={"Content-Type": "application/zip"},
    )

    assert response.status_code == 204
    upload.assert_called_once_with(
        ANY,
        user_id=5,
        submission_id=11,
        package=b"plugin",
    )


def test_plugin_publication_upload_streams_through_backend(
    test_client: TestClient, monkeypatch
) -> None:
    upload = Mock()
    monkeypatch.setattr(
        plugin_publications.plugin_publication_service,
        "upload_revision_package",
        upload,
    )
    upload_url, _ = build_plugin_publication_upload_url(
        request_id=13, revision=2, user_id=5
    )

    response = test_client.put(
        upload_url,
        content=b"plugin",
        headers={"Content-Type": "application/zip"},
    )

    assert response.status_code == 204
    upload.assert_called_once_with(
        ANY,
        user_id=5,
        request_id=13,
        revision_number=2,
        package=b"plugin",
    )


def test_plugin_publication_upload_rejects_another_revision(
    test_client: TestClient,
) -> None:
    upload_url, _ = build_plugin_publication_upload_url(
        request_id=13, revision=2, user_id=5
    )
    stale_url = upload_url.replace("/revisions/2/", "/revisions/3/")

    response = test_client.put(stale_url, content=b"plugin")

    assert response.status_code == 403


def test_submission_upload_rejects_a_token_for_another_resource(
    test_client: TestClient,
) -> None:
    plugin_url, _ = build_marketplace_submission_upload_url(
        kind="plugin", submission_id=11, user_id=5
    )
    smart_app_url = plugin_url.replace("/plugins/", "/smart-apps/")

    response = test_client.put(smart_app_url, content=b"smart-app")

    assert response.status_code == 403


def test_submission_upload_uses_https_public_backend_url(monkeypatch) -> None:
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://wegent.example.com/",
    )

    upload_url, _ = build_marketplace_submission_upload_url(
        kind="smart_app", submission_id=9, user_id=7
    )

    assert upload_url.startswith(
        "https://wegent.example.com/api/smart-apps/submissions/9/artifact?token="
    )


def test_submission_upload_uses_loopback_backend_url(monkeypatch) -> None:
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "http://127.0.0.1:8000",
    )

    upload_url, _ = build_marketplace_submission_upload_url(
        kind="plugin", submission_id=11, user_id=5
    )

    assert upload_url.startswith(
        "http://127.0.0.1:8000/api/plugins/submissions/11/artifact?token="
    )


def test_smart_app_submission_upload_enforces_package_limit(
    test_client: TestClient, monkeypatch
) -> None:
    upload = Mock()
    monkeypatch.setattr(
        smart_apps.smart_app_marketplace_service,
        "upload_submission_package",
        upload,
    )
    monkeypatch.setattr(smart_apps, "MAX_SMART_APP_PACKAGE_SIZE_BYTES", 3)
    upload_url, _ = build_marketplace_submission_upload_url(
        kind="smart_app", submission_id=9, user_id=7
    )

    response = test_client.put(upload_url, content=b"four")

    assert response.status_code == 413
    upload.assert_not_called()
