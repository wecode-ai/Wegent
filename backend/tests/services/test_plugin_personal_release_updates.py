# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Personal release updates preserve the current sharing policy."""

import hashlib
import io
import json
import zipfile
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin, PluginRelease
from app.models.user import User
from app.schemas.installed_plugin import (
    PluginAccessTarget,
    PluginAccessUpdateRequest,
    PluginSubmissionInitRequest,
    PluginSubmissionInitResponse,
)
from app.services.plugin_marketplace_service import PluginMarketplaceService
from tests.services.test_plugin_marketplace_v2 import (
    _mock_package_storage,
    _plugin_zip,
    _upload_submission,
)


def _submission_payload(
    version: str = "1.0.0", *, package: bytes | None = None, **metadata: object
) -> dict[str, object]:
    package = package if package is not None else _plugin_zip(version=version)
    return {
        "slug": "gitlab-engineering",
        "displayName": "GitLab Engineering",
        "version": version,
        "filename": "gitlab.zip",
        "sha256": hashlib.sha256(package).hexdigest(),
        "sizeBytes": len(package),
        "purpose": "restricted_share",
        **metadata,
    }


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ({}, None),
        ({"releaseNotes": None}, None),
        (
            {"releaseNotes": "  Fix connector authentication.\n"},
            "Fix connector authentication.",
        ),
        ({"releaseNotes": "a" * 2000}, "a" * 2000),
    ],
)
def test_submission_release_notes_accepts_legacy_or_trimmed_notes(
    metadata: dict[str, str | None], expected: str | None
) -> None:
    request = PluginSubmissionInitRequest.model_validate(
        _submission_payload(**metadata)
    )

    assert request.releaseNotes == expected


@pytest.mark.parametrize("notes", ["", " \t\n", "a" * 2001])
def test_submission_release_notes_rejects_blank_or_oversized_notes(notes: str) -> None:
    with pytest.raises(ValidationError):
        PluginSubmissionInitRequest.model_validate(
            _submission_payload(releaseNotes=notes)
        )


def _complete_submission(
    service: PluginMarketplaceService,
    db: Session,
    user_id: int,
    submission: PluginSubmissionInitResponse,
    package: bytes,
) -> None:
    _upload_submission(
        service,
        db,
        user_id=user_id,
        submission_id=submission.submissionId,
        package=package,
    )
    completed = service.complete_submission(
        db, user_id=user_id, submission_id=submission.submissionId
    )
    assert completed.status == "approved"


@pytest.fixture
def shared_personal_release(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[PluginMarketplaceService, PluginSubmissionInitResponse, list[User]]:
    service = PluginMarketplaceService(release_notifier=Mock(return_value=0))
    _mock_package_storage(monkeypatch, {})
    recipients = [
        User(
            user_name=f"release-recipient-{index}",
            password_hash=test_user.password_hash,
            email=f"release-recipient-{index}@example.com",
            is_active=True,
        )
        for index in range(2)
    ]
    test_db.add_all(recipients)
    test_db.commit()
    package = _plugin_zip()
    initial = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest.model_validate(
            _submission_payload(
                package=package,
                targets=[
                    PluginAccessTarget(
                        entityType="user", entityId=str(recipients[0].id)
                    )
                ],
                allowCopy=True,
            )
        ),
    )
    _complete_submission(service, test_db, test_user.id, initial, package)
    assert test_db.get(PluginRelease, initial.releaseId).release_notes == ""
    return service, initial, recipients


def _replace_access(
    service: PluginMarketplaceService,
    db: Session,
    owner_id: int,
    plugin_id: int,
    recipient_id: int | None,
) -> None:
    targets = (
        [PluginAccessTarget(entityType="user", entityId=str(recipient_id))]
        if recipient_id is not None
        else []
    )
    service.update_plugin_access(
        db,
        plugin_id=plugin_id,
        user_id=owner_id,
        request=PluginAccessUpdateRequest(
            scope="restricted" if targets else "private",
            targets=targets,
            allowCopy=False,
        ),
    )


@pytest.mark.parametrize("access_change", ["unchanged", "replaced", "private"])
def test_personal_release_update_preserves_current_access_and_stores_notes(
    test_db: Session,
    test_user: User,
    shared_personal_release: tuple[
        PluginMarketplaceService, PluginSubmissionInitResponse, list[User]
    ],
    access_change: str,
) -> None:
    service, initial, recipients = shared_personal_release
    package = _plugin_zip(version="1.1.0")
    updated = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest.model_validate(
            _submission_payload(
                "1.1.0", package=package, releaseNotes="  Improve authentication.\n"
            )
        ),
    )
    assert updated.pluginId == initial.pluginId
    assert (
        "pendingAccess"
        not in test_db.get(PluginRelease, updated.releaseId).scan_report_json
    )
    if access_change != "unchanged":
        _replace_access(
            service,
            test_db,
            test_user.id,
            initial.pluginId,
            recipients[1].id if access_change == "replaced" else None,
        )
    expected_access = service.get_plugin_access(
        test_db, plugin_id=initial.pluginId, user_id=test_user.id
    )

    _complete_submission(service, test_db, test_user.id, updated, package)

    test_db.expire_all()
    access = service.get_plugin_access(
        test_db, plugin_id=initial.pluginId, user_id=test_user.id
    )
    assert access == expected_access
    assert access.allowCopy is (access_change == "unchanged")
    if access_change != "unchanged":
        assert service.list_plugins(test_db, user_id=recipients[0].id).items == []
    release = test_db.get(PluginRelease, updated.releaseId)
    assert release.release_notes == "Improve authentication."
    assert test_db.get(Plugin, initial.pluginId).latest_release_id == release.id
    releases = service.list_releases(
        test_db, plugin_id=initial.pluginId, user_id=test_user.id
    )
    published = next(item for item in releases.items if item.id == release.id)
    assert published.releaseNotes == "Improve authentication."


def _renamed_plugin_package(name: str, version: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(_plugin_zip(version=version))) as original:
        with zipfile.ZipFile(output, "w") as archive:
            for entry in original.infolist():
                body = original.read(entry.filename)
                if entry.filename == ".codex-plugin/plugin.json":
                    manifest = json.loads(body)
                    manifest["name"] = name
                    body = json.dumps(manifest).encode()
                archive.writestr(entry.filename, body)
    return output.getvalue()


@pytest.mark.parametrize(
    "manifest_name",
    [
        "another-plugin",
        "GitLab/Engineering",
        "GitLab\\Engineering",
        "GitLab:Engineering",
        "GitLab\0Engineering",
    ],
)
def test_personal_release_rejects_another_plugins_package_without_changing_source(
    test_db: Session,
    test_user: User,
    shared_personal_release: tuple[
        PluginMarketplaceService, PluginSubmissionInitResponse, list[User]
    ],
    manifest_name: str,
) -> None:
    service, initial, _ = shared_personal_release
    plugin = test_db.get(Plugin, initial.pluginId)
    original_name = plugin.name
    original_access = service.get_plugin_access(
        test_db, plugin_id=plugin.id, user_id=test_user.id
    )
    package = _renamed_plugin_package(manifest_name, "1.1.0")
    updated = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest.model_validate(
            _submission_payload("1.1.0", package=package, releaseNotes="Wrong source")
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=updated.submissionId,
        package=package,
    )

    with pytest.raises(HTTPException) as rejected:
        service.complete_submission(
            test_db, user_id=test_user.id, submission_id=updated.submissionId
        )

    assert rejected.value.status_code == 422
    assert rejected.value.detail == (
        "Personal plugin slug must match the manifest name"
        if manifest_name == "another-plugin"
        else "Personal plugin manifest name must be a safe path component"
    )
    test_db.expire_all()
    plugin = test_db.get(Plugin, initial.pluginId)
    assert plugin.name == original_name
    assert plugin.latest_release_id == initial.releaseId
    assert (
        service.get_plugin_access(test_db, plugin_id=plugin.id, user_id=test_user.id)
        == original_access
    )
    release = test_db.get(PluginRelease, updated.releaseId)
    assert release.status == "rejected"
    assert release.scan_status == "failed"


def test_first_personal_submission_accepts_the_manifest_normalized_upload_slug(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = PluginMarketplaceService()
    _mock_package_storage(monkeypatch, {})
    package = _renamed_plugin_package("GitLab Engineering", "1.0.0")
    submission = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest.model_validate(
            _submission_payload(package=package)
        ),
    )

    _complete_submission(service, test_db, test_user.id, submission, package)

    plugin = test_db.get(Plugin, submission.pluginId)
    assert plugin.slug == "gitlab-engineering"
    assert plugin.name == "GitLab Engineering"
    assert plugin.latest_release_id == submission.releaseId


@pytest.mark.parametrize(
    "manifest_name", ["GitLab/Engineering", "GitLab\\Engineering", "GitLab:Engineering"]
)
def test_first_personal_submission_rejects_unsafe_normalized_manifest_names(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    manifest_name: str,
) -> None:
    service = PluginMarketplaceService()
    _mock_package_storage(monkeypatch, {})
    package = _renamed_plugin_package(manifest_name, "1.0.0")
    submission = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest.model_validate(
            _submission_payload(package=package)
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=submission.submissionId,
        package=package,
    )

    with pytest.raises(HTTPException, match="safe path component") as rejected:
        service.complete_submission(
            test_db, user_id=test_user.id, submission_id=submission.submissionId
        )

    assert rejected.value.status_code == 422
    test_db.expire_all()
    assert not test_db.get(Plugin, submission.pluginId).latest_release_id
    release = test_db.get(PluginRelease, submission.releaseId)
    assert release.status == "rejected"
    assert release.scan_status == "failed"


@pytest.mark.parametrize("mode", ["submission", "direct"])
def test_personal_release_accepts_normalized_manifest_identity_and_preserves_access(
    test_db: Session,
    test_user: User,
    shared_personal_release: tuple[
        PluginMarketplaceService, PluginSubmissionInitResponse, list[User]
    ],
    mode: str,
) -> None:
    service, initial, _ = shared_personal_release
    package = _renamed_plugin_package("GitLab Engineering", "1.1.0")
    original_access = service.get_plugin_access(
        test_db, plugin_id=initial.pluginId, user_id=test_user.id
    )

    if mode == "submission":
        submission = service.init_submission(
            test_db,
            user_id=test_user.id,
            request=PluginSubmissionInitRequest.model_validate(
                _submission_payload("1.1.0", package=package)
            ),
        )
        _complete_submission(service, test_db, test_user.id, submission, package)
        release_id = submission.releaseId
    else:
        published = service.publish_personal_release(
            test_db,
            plugin_id=initial.pluginId,
            owner_user_id=test_user.id,
            package=package,
        )
        release_id = published.release.id

    test_db.expire_all()
    plugin = test_db.get(Plugin, initial.pluginId)
    assert plugin.slug == "gitlab-engineering"
    assert plugin.name == "GitLab Engineering"
    assert plugin.latest_release_id == release_id
    assert (
        service.get_plugin_access(test_db, plugin_id=plugin.id, user_id=test_user.id)
        == original_access
    )
