# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.api_key import KEY_TYPE_PLUGIN_RELEASE, APIKey
from app.models.user import User
from app.schemas.plugin_publication import PluginReleasePublishResponse
from app.services.plugin_publication_artifact import expected_release_idempotency_key
from app.services.plugin_publication_service import plugin_publication_service

RELEASE_URL = "/api/internal/plugins/releases"
GITLAB_EVENTS_URL = "/api/internal/plugins/gitlab/events"


def _plugin_zip() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "pipeline-plugin",
                    "version": "1.2.3",
                    "description": "Pipeline contract",
                }
            ),
        )
    return output.getvalue()


def _release_key(db: Session, user: User) -> str:
    raw_key = "wg-plugin-release-test"
    db.add(
        APIKey(
            user_id=user.id,
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            key_prefix="wg-plugin...",
            name="Plugin release test",
            key_type=KEY_TYPE_PLUGIN_RELEASE,
            expires_at=(
                datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)
            ),
        )
    )
    db.commit()
    return raw_key


def _metadata(package: bytes) -> dict:
    return {
        "schemaVersion": 1,
        "changed": True,
        "plugin": {
            "slug": "pipeline-plugin",
            "version": "1.2.3",
            "listingType": "plugin",
        },
        "artifact": {
            "file": "plugin.zip",
            "sha256": hashlib.sha256(package).hexdigest(),
            "sizeBytes": len(package),
        },
        "source": {
            "projectId": "42",
            "ref": "master",
            "sourceCommitSha": "a" * 40,
            "pipelineId": 99,
            "pipelineUrl": "https://git.invalid/pipelines/99",
            "metadata": {"projectPath": "wework-plugins"},
        },
        "requestId": 12,
        "revision": 3,
    }


def test_release_endpoint_accepts_exact_multipart_envelope(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch,
):
    package = _plugin_zip()
    raw_key = _release_key(test_db, test_user)
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "42")
    monkeypatch.setattr(
        settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH", "master"
    )
    captured = {}

    def publish(db, **kwargs):
        del db
        captured.update(kwargs)
        metadata = kwargs["metadata"]
        return PluginReleasePublishResponse(
            pluginId=21,
            releaseId=34,
            created=True,
            slug=metadata.plugin.slug,
            version=metadata.plugin.version,
            sha256=metadata.artifact.sha256,
        )

    monkeypatch.setattr(
        plugin_publication_service, "publish_enterprise_release", publish
    )

    metadata = _metadata(package)
    response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (
                None,
                json.dumps(metadata),
                "application/json",
            ),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": f"Bearer {raw_key}",
            "Idempotency-Key": expected_release_idempotency_key(metadata),
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "pluginId": 21,
        "releaseId": 34,
        "created": True,
        "catalogNamespace": "enterprise",
        "slug": "pipeline-plugin",
        "version": "1.2.3",
        "sha256": hashlib.sha256(package).hexdigest(),
    }
    assert captured["metadata"].requestId == 12
    assert captured["metadata"].revision == 3
    assert captured["metadata"].source.metadata.projectPath == "wework-plugins"
    release_key = (
        test_db.query(APIKey).filter(APIKey.key_type == KEY_TYPE_PLUGIN_RELEASE).one()
    )
    assert captured["release_key_id"] == release_key.id


def test_release_endpoint_rejects_wrong_key_type_and_artifact_hash(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key,
    monkeypatch,
):
    package = _plugin_zip()
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "42")
    metadata = _metadata(package)
    idempotency_key = expected_release_idempotency_key(metadata)
    personal_raw_key, _ = test_api_key
    personal_response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (None, json.dumps(metadata), "application/json"),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": f"Bearer {personal_raw_key}",
            "Idempotency-Key": idempotency_key,
        },
    )
    assert personal_response.status_code == 401

    raw_key = _release_key(test_db, test_user)
    metadata["artifact"]["sha256"] = "0" * 64
    idempotency_key = expected_release_idempotency_key(metadata)
    hash_response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (None, json.dumps(metadata), "application/json"),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": f"Bearer {raw_key}",
            "Idempotency-Key": idempotency_key,
        },
    )
    assert hash_response.status_code == 422


def test_release_endpoint_requires_bearer_authorization_scheme(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch,
):
    package = _plugin_zip()
    raw_key = _release_key(test_db, test_user)
    metadata = _metadata(package)
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "42")

    response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (None, json.dumps(metadata), "application/json"),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": raw_key,
            "Idempotency-Key": expected_release_idempotency_key(metadata),
        },
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_release_endpoint_requires_configured_gitlab_project(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch,
):
    package = _plugin_zip()
    raw_key = _release_key(test_db, test_user)
    metadata = _metadata(package)
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "")

    response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (None, json.dumps(metadata), "application/json"),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": f"Bearer {raw_key}",
            "Idempotency-Key": expected_release_idempotency_key(metadata),
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Plugin publication GitLab project is not configured"
    )


def test_release_endpoint_rejects_malformed_idempotency_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch,
):
    package = _plugin_zip()
    raw_key = _release_key(test_db, test_user)
    metadata = _metadata(package)
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "42")

    response = test_client.post(
        RELEASE_URL,
        files={
            "metadata": (None, json.dumps(metadata), "application/json"),
            "package": ("plugin.zip", package, "application/zip"),
        },
        headers={
            "Authorization": f"Bearer {raw_key}",
            "Idempotency-Key": "x" * 81,
        },
    )

    assert response.status_code == 422


def test_gitlab_webhook_rejects_events_from_another_project(
    test_client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(
        settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET", "webhook-secret"
    )
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID", "42")

    response = test_client.post(
        GITLAB_EVENTS_URL,
        json={
            "project": {"id": 41},
            "object_attributes": {"ref": "wework/publication-12-r3"},
        },
        headers={
            "X-Gitlab-Token": "webhook-secret",
            "X-Gitlab-Event": "Pipeline Hook",
            "X-Gitlab-Event-UUID": "wrong-project-event",
        },
    )

    assert response.status_code == 403
