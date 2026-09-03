# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from sqlalchemy import inspect

from app.core.security import get_password_hash
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.smart_app_marketplace import SmartApp, SmartAppRelease
from app.models.user import User
from app.schemas.smart_app import (
    SmartAppAccessTarget,
    SmartAppAccessUpdateRequest,
    SmartAppSubmissionInitRequest,
)
from app.services.marketplace_artifact_storage import marketplace_artifact_storage
from app.services.smart_app_download_link import verify_smart_app_download_token
from app.services.smart_app_marketplace_service import smart_app_marketplace_service


def _package(name: str = "research-desk", version: str = "1.0.0") -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "plugin-manifest.json",
            json.dumps(
                {
                    "name": name,
                    "displayName": "Research Desk",
                    "version": version,
                    "type": "deepseek-harness-plugin-bundle",
                    "description": "Research local documents",
                    "entry": {
                        "installPackage": "bundle",
                        "profile": "research",
                    },
                    "requirements": {"dsh": "0.1.0", "node": ">=22"},
                }
            ),
        )
        archive.writestr("bundle/package.json", "{}")
        archive.writestr("bundle/cordis.patch.yml", "plugins: []")
    return output.getvalue()


def _image_data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(b"png-image").decode()


def _user(db, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash("test-password"),
        email=f"{name}@example.com",
        is_active=True,
        git_info=None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _mock_storage(monkeypatch) -> dict[str, bytes]:
    values: dict[str, bytes] = {}

    def put(key, value, *, content_type):
        values[key] = value

    def put_immutable(key, value, *, content_type):
        if key in values and values[key] != value:
            raise AssertionError("immutable artifact changed")
        created = key not in values
        values[key] = value
        return created

    monkeypatch.setattr(marketplace_artifact_storage, "put", put)
    monkeypatch.setattr(marketplace_artifact_storage, "put_immutable", put_immutable)
    monkeypatch.setattr(marketplace_artifact_storage, "get", lambda key: values[key])
    monkeypatch.setattr(
        marketplace_artifact_storage, "delete", lambda key: values.pop(key, None)
    )
    monkeypatch.setattr(
        marketplace_artifact_storage,
        "presign_download",
        lambda key: (f"https://download/{key}", datetime.now(timezone.utc)),
    )
    return values


def _upload_submission(
    db,
    *,
    submission_id: int,
    user_id: int,
    package: bytes,
) -> None:
    smart_app_marketplace_service.upload_submission_package(
        db,
        submission_id=submission_id,
        user_id=user_id,
        package=package,
    )


def _submission(
    package: bytes,
    target: User,
    *,
    version: str = "1.0.0",
    extensions: dict | None = None,
    release_extensions: dict | None = None,
):
    return SmartAppSubmissionInitRequest(
        name="research-desk",
        displayName="Research Desk",
        version=version,
        filename="research-desk.zip",
        sha256=hashlib.sha256(package).hexdigest(),
        sizeBytes=len(package),
        summary="Research local documents",
        descriptionMd="# Research Desk",
        tags=["data_analysis"],
        iconDataUrl=_image_data_url(),
        extensions=extensions or {},
        releaseExtensions=release_extensions or {},
        targets=[
            SmartAppAccessTarget(
                entityType="user", entityId=str(target.id), displayName=target.user_name
            )
        ],
    )


def test_submission_upload_uses_backend_ticket_and_stores_validated_package(
    test_db, test_user, monkeypatch
):
    recipient = _user(test_db, "upload-recipient")
    package = _package()
    values = _mock_storage(monkeypatch)

    initialized = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=_submission(package, recipient)
    )
    smart_app_marketplace_service.upload_submission_package(
        test_db,
        submission_id=initialized.submissionId,
        user_id=test_user.id,
        package=package,
    )

    upload_url = urlsplit(initialized.uploadUrl)
    assert upload_url.path == (
        f"/api/smart-apps/submissions/{initialized.submissionId}/artifact"
    )
    assert parse_qs(upload_url.query)["token"]
    assert package in values.values()


def test_user_publication_is_visible_only_to_owner_and_recipient(
    test_db, test_user, monkeypatch
):
    recipient = _user(test_db, "smart-recipient")
    stranger = _user(test_db, "smart-stranger")
    package = _package()
    _mock_storage(monkeypatch)

    initialized = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=_submission(package, recipient)
    )
    _upload_submission(
        test_db,
        submission_id=initialized.submissionId,
        user_id=test_user.id,
        package=package,
    )
    completed = smart_app_marketplace_service.complete_submission(
        test_db, submission_id=initialized.submissionId, user_id=test_user.id
    )

    assert completed.item is not None
    assert completed.item.accessRole == "owner"
    recipient_items = smart_app_marketplace_service.list_marketplace(
        test_db, user_id=recipient.id
    ).items
    assert [(item.name, item.accessRole) for item in recipient_items] == [
        ("research-desk", "recipient")
    ]
    assert (
        smart_app_marketplace_service.list_marketplace(
            test_db, user_id=stranger.id
        ).items
        == []
    )


def test_publication_persists_versioned_extensions_and_preserves_unknown_app_fields(
    test_db, test_user, monkeypatch
):
    recipient = _user(test_db, "extension-recipient")
    first_package = _package(version="1.0.0")
    _mock_storage(monkeypatch)
    first_request = _submission(
        first_package,
        recipient,
        extensions={
            "com.weibo.internal": {
                "businessOwner": "platform",
                "securityLevel": "internal",
            }
        },
        release_extensions={"com.weibo.build": {"pipeline": "release-v1"}},
    )
    first = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=first_request
    )
    _upload_submission(
        test_db,
        submission_id=first.submissionId,
        user_id=test_user.id,
        package=first_package,
    )
    published = smart_app_marketplace_service.complete_submission(
        test_db, submission_id=first.submissionId, user_id=test_user.id
    )

    assert published.item is not None
    assert published.item.extensions == {
        "schemaVersion": 1,
        "com.weibo.internal": {
            "businessOwner": "platform",
            "securityLevel": "internal",
        },
    }
    assert published.item.releaseExtensions == {
        "schemaVersion": 1,
        "com.weibo.build": {"pipeline": "release-v1"},
    }

    second_package = _package(version="1.1.0")
    _mock_storage(monkeypatch)
    second_request = _submission(
        second_package,
        recipient,
        version="1.1.0",
        extensions={"com.weibo.internal": {"businessOwner": "ai-platform"}},
    )
    second_request.smartAppId = published.item.id
    second_request.targets = []
    second = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=second_request
    )
    _upload_submission(
        test_db,
        submission_id=second.submissionId,
        user_id=test_user.id,
        package=second_package,
    )
    updated = smart_app_marketplace_service.complete_submission(
        test_db, submission_id=second.submissionId, user_id=test_user.id
    )

    assert updated.item is not None
    assert updated.item.extensions["com.weibo.internal"] == {
        "businessOwner": "ai-platform",
        "securityLevel": "internal",
    }
    app = test_db.get(SmartApp, updated.item.id)
    release = test_db.get(SmartAppRelease, updated.item.latestReleaseId)
    assert app is not None
    assert app.extensions_json == updated.item.extensions
    assert release is not None
    assert release.extensions_json == {}


def test_extensions_have_a_bounded_serialized_size(test_db, test_user, monkeypatch):
    recipient = _user(test_db, "large-extension-recipient")
    package = _package()
    _mock_storage(monkeypatch)
    request = _submission(
        package,
        recipient,
        extensions={"com.weibo.internal": {"value": "x" * (64 * 1024)}},
    )

    with pytest.raises(HTTPException) as error:
        smart_app_marketplace_service.init_submission(
            test_db, user_id=test_user.id, request=request
        )

    assert error.value.status_code == 422


def test_release_and_submission_tables_have_no_foreign_keys(test_db):
    inspector = inspect(test_db.get_bind())

    for table in ("smart_app_releases", "smart_app_submissions"):
        assert inspector.get_foreign_keys(table) == []


def test_department_grant_allows_member_download(test_db, test_user, monkeypatch):
    member = _user(test_db, "department-member")
    department = Namespace(
        name="research",
        display_name="Research",
        owner_user_id=test_user.id,
        visibility="private",
        is_active=True,
    )
    test_db.add(department)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="Namespace",
            resource_id=department.id,
            entity_type="user",
            entity_id=str(member.id),
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    package = _package()
    _mock_storage(monkeypatch)
    request = _submission(package, member)
    request.targets = [
        SmartAppAccessTarget(
            entityType="namespace",
            entityId=str(department.id),
            displayName="Research",
        )
    ]
    initialized = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=request
    )
    _upload_submission(
        test_db,
        submission_id=initialized.submissionId,
        user_id=test_user.id,
        package=package,
    )
    smart_app_marketplace_service.complete_submission(
        test_db, submission_id=initialized.submissionId, user_id=test_user.id
    )

    item = smart_app_marketplace_service.list_marketplace(
        test_db, user_id=member.id
    ).items[0]
    descriptor = smart_app_marketplace_service.download_descriptor(
        test_db, smart_app_id=item.id, user_id=member.id
    )
    assert descriptor.sha256 == hashlib.sha256(package).hexdigest()
    parsed_url = urlsplit(descriptor.downloadUrl)
    assert parsed_url.path == f"/api/smart-apps/marketplace/{item.id}/artifact"
    claims = verify_smart_app_download_token(parse_qs(parsed_url.query)["token"][0])
    assert claims.smart_app_id == item.id
    assert claims.release_id == item.latestReleaseId
    assert claims.user_id == member.id


def test_revocation_blocks_future_download_but_does_not_track_local_copy(
    test_db, test_user, monkeypatch
):
    recipient = _user(test_db, "revoked-recipient")
    package = _package()
    _mock_storage(monkeypatch)
    initialized = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=_submission(package, recipient)
    )
    _upload_submission(
        test_db,
        submission_id=initialized.submissionId,
        user_id=test_user.id,
        package=package,
    )
    completed = smart_app_marketplace_service.complete_submission(
        test_db, submission_id=initialized.submissionId, user_id=test_user.id
    )
    assert completed.item is not None
    descriptor = smart_app_marketplace_service.download_descriptor(
        test_db,
        smart_app_id=completed.item.id,
        user_id=recipient.id,
    )
    descriptor_url = urlsplit(descriptor.downloadUrl)
    claims = verify_smart_app_download_token(parse_qs(descriptor_url.query)["token"][0])

    smart_app_marketplace_service.update_access(
        test_db,
        smart_app_id=completed.item.id,
        user_id=test_user.id,
        request=SmartAppAccessUpdateRequest(scope="private", targets=[]),
    )

    assert (
        smart_app_marketplace_service.list_marketplace(
            test_db, user_id=recipient.id
        ).items
        == []
    )
    with pytest.raises(HTTPException) as error:
        smart_app_marketplace_service.download_descriptor(
            test_db, smart_app_id=completed.item.id, user_id=recipient.id
        )
    assert error.value.status_code == 404
    with pytest.raises(HTTPException) as artifact_error:
        smart_app_marketplace_service.download_artifact(
            test_db,
            smart_app_id=claims.smart_app_id,
            release_id=claims.release_id,
            user_id=claims.user_id,
        )
    assert artifact_error.value.status_code == 404


def test_same_or_older_version_cannot_replace_release(test_db, test_user, monkeypatch):
    recipient = _user(test_db, "version-recipient")
    package = _package(version="2.0.0")
    _mock_storage(monkeypatch)
    initialized = smart_app_marketplace_service.init_submission(
        test_db,
        user_id=test_user.id,
        request=_submission(package, recipient, version="2.0.0"),
    )
    _upload_submission(
        test_db,
        submission_id=initialized.submissionId,
        user_id=test_user.id,
        package=package,
    )
    smart_app_marketplace_service.complete_submission(
        test_db, submission_id=initialized.submissionId, user_id=test_user.id
    )

    older = _package(version="1.0.0")
    _mock_storage(monkeypatch)
    with pytest.raises(HTTPException) as error:
        smart_app_marketplace_service.init_submission(
            test_db,
            user_id=test_user.id,
            request=_submission(older, recipient, version="1.0.0"),
        )
    assert error.value.status_code == 409


def test_first_user_release_requires_a_recipient(test_db, test_user, monkeypatch):
    package = _package()
    _mock_storage(monkeypatch)
    request = _submission(package, test_user)
    request.targets = []

    with pytest.raises(HTTPException) as error:
        smart_app_marketplace_service.init_submission(
            test_db, user_id=test_user.id, request=request
        )

    assert error.value.status_code == 422


def test_new_version_preserves_existing_recipients(test_db, test_user, monkeypatch):
    recipient = _user(test_db, "preserved-recipient")
    first_package = _package(version="1.0.0")
    _mock_storage(monkeypatch)
    first = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=_submission(first_package, recipient)
    )
    _upload_submission(
        test_db,
        submission_id=first.submissionId,
        user_id=test_user.id,
        package=first_package,
    )
    published = smart_app_marketplace_service.complete_submission(
        test_db, submission_id=first.submissionId, user_id=test_user.id
    )
    assert published.item is not None

    second_package = _package(version="1.1.0")
    _mock_storage(monkeypatch)
    request = _submission(second_package, recipient, version="1.1.0")
    request.smartAppId = published.item.id
    request.targets = []
    second = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=request
    )
    _upload_submission(
        test_db,
        submission_id=second.submissionId,
        user_id=test_user.id,
        package=second_package,
    )
    smart_app_marketplace_service.complete_submission(
        test_db, submission_id=second.submissionId, user_id=test_user.id
    )

    assert (
        smart_app_marketplace_service.list_marketplace(test_db, user_id=recipient.id)
        .items[0]
        .version
        == "1.1.0"
    )


def test_uploaded_package_hash_must_match_submission(test_db, test_user, monkeypatch):
    recipient = _user(test_db, "hash-recipient")
    package = _package()
    values = _mock_storage(monkeypatch)
    initialized = smart_app_marketplace_service.init_submission(
        test_db, user_id=test_user.id, request=_submission(package, recipient)
    )
    submission = smart_app_marketplace_service._owned_submission(
        test_db, initialized.submissionId, test_user.id
    )
    values[submission.staging_storage_key] = b"truncated"

    with pytest.raises(HTTPException) as error:
        smart_app_marketplace_service.complete_submission(
            test_db, submission_id=initialized.submissionId, user_id=test_user.id
        )

    assert error.value.status_code == 400


def test_official_release_is_visible_to_every_authenticated_user(
    test_db, test_user, monkeypatch
):
    stranger = _user(test_db, "official-reader")
    package = _package(name="official-research")
    _mock_storage(monkeypatch)

    app, release, created = smart_app_marketplace_service.publish_official_package(
        test_db,
        package=package,
        summary="Official research",
        description_md="# Official research",
        tags=["data_analysis"],
        icon=b"png-image",
        icon_content_type="image/png",
        screenshots=[],
        release_notes="Initial release",
    )

    assert created is True
    assert release.smart_app_id == app.id
    item = smart_app_marketplace_service.list_marketplace(
        test_db, user_id=stranger.id
    ).items[0]
    assert item.name == "official-research"
    assert item.accessRole == "official"
