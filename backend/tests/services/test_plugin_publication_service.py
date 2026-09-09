# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models.plugin_marketplace import Plugin, PluginRelease
from app.models.plugin_publication import (
    PluginPublicationCheck,
    PluginPublicationEvent,
    PluginPublicationRequest,
    PluginPublicationRevision,
    PluginReleaseIdempotency,
)
from app.models.user import User
from app.schemas.plugin_publication import (
    AcceptPluginPublicationRequest,
    PluginPublicationCreateRequest,
    PluginPublicationRevisionCreateRequest,
    PluginReleaseMetadata,
    ReturnPluginPublicationRequest,
)
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_publication_artifact import (
    canonical_complete_tree_sha256,
    expected_release_idempotency_key,
)
from app.services.plugin_publication_gitlab_service import GitLabMaterialization
from app.services.plugin_publication_service import PluginPublicationService


def _plugin_zip(
    version: str = "1.0.0",
    *,
    slug: str = "publication-test",
    skill_body: str = "---\nname: example\ndescription: Test publication\n---\n",
    manifest_extra: dict | None = None,
    extra_files: dict[str, str] | None = None,
) -> bytes:
    output = io.BytesIO()
    manifest = {
        "name": slug,
        "version": version,
        "description": "Publication workflow test plugin",
        **(manifest_extra or {}),
    }
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(manifest),
        )
        archive.writestr(
            "skills/example/SKILL.md",
            skill_body,
        )
        for path, body in (extra_files or {}).items():
            archive.writestr(path, body)
    return output.getvalue()


def _materialized_zip(
    package: bytes,
    *,
    request_id: int,
    revision: int,
    snapshot_sha256: str,
    source_tree_sha256: str,
    risk_declaration: dict,
    test_notes: str,
) -> bytes:
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(package)) as source,
        zipfile.ZipFile(output, "w") as target,
    ):
        for member in source.infolist():
            target.writestr(member, source.read(member))
        target.writestr(
            "plugin-risk.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "riskDeclaration": risk_declaration,
                    "testNotes": test_notes,
                },
                sort_keys=True,
            ),
        )
        target.writestr(
            ".wework-publication.json",
            json.dumps(
                {
                    "requestId": request_id,
                    "revision": revision,
                    "snapshotSha256": snapshot_sha256,
                    "sourceTreeSha256": source_tree_sha256,
                },
                sort_keys=True,
            ),
        )
    return output.getvalue()


def _wrapped_plugin_zip_with_outside_file() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "wrapper/.codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "publication-test",
                    "version": "1.0.0",
                    "description": "Publication workflow test plugin",
                }
            ),
        )
        archive.writestr(
            "wrapper/skills/example/SKILL.md",
            "---\nname: example\ndescription: Test publication\n---\n",
        )
        archive.writestr("README.md", "outside plugin root")
    return output.getvalue()


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def get(self, object_key: str) -> bytes:
        return self.objects[object_key]

    def put(self, object_key: str, package: bytes) -> None:
        self.objects[object_key] = package

    def put_immutable(self, object_key: str, package: bytes) -> bool:
        existing = self.objects.get(object_key)
        if existing is not None and existing != package:
            raise AssertionError("immutable object changed")
        self.objects[object_key] = package
        return existing is None

    def delete(self, object_key: str) -> None:
        self.objects.pop(object_key, None)


class FakeGitLab:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.verification_calls: list[dict] = []
        self.closed_merge_request_iids: list[int] = []

    def materialize(self, **kwargs) -> GitLabMaterialization:
        self.calls.append(kwargs)
        return GitLabMaterialization(
            project_id="42",
            project_url="https://git.invalid/wework-plugins",
            source_branch=(
                f"wework/publication-{kwargs['request_id']}-r{kwargs['revision']}"
            ),
            merge_request_iid=7,
            merge_request_url="https://git.invalid/wework-plugins/-/merge_requests/7",
            merge_request_status="opened",
            commit_sha="a" * 40,
        )

    def reconcile(self, **kwargs) -> GitLabMaterialization:
        return self.materialize(**kwargs)

    def close_merge_request(self, *, merge_request_iid: int) -> None:
        self.closed_merge_request_iids.append(merge_request_iid)

    def verify_release_provenance(self, **kwargs) -> None:
        self.verification_calls.append(kwargs)


def test_materialization_records_an_immediately_merged_request() -> None:
    service = PluginPublicationService(storage=FakeStorage(), gitlab=FakeGitLab())
    request = SimpleNamespace()
    revision = SimpleNamespace()
    materialization = GitLabMaterialization(
        project_id="42",
        project_url="https://git.invalid/wework-plugins",
        source_branch="wework/publication-12-r3",
        merge_request_iid=7,
        merge_request_url="https://git.invalid/wework-plugins/-/merge_requests/7",
        merge_request_status="merged",
        commit_sha="b" * 40,
    )

    service._apply_materialization(request, revision, materialization)

    assert request.aggregate_status == "merged"
    assert revision.status == "merged"
    assert revision.merge_request_status == "merged"
    assert revision.commit_sha == "b" * 40


class BlockingMarketplace:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.allow_finish = threading.Event()
        self.calls = 0

    def publish_catalog_release(self, db, **kwargs):
        del db, kwargs
        self.calls += 1
        self.entered.set()
        assert self.allow_finish.wait(timeout=5)
        return SimpleNamespace(
            release=SimpleNamespace(plugin_id=21, id=34),
            created=True,
        )

    def notify_catalog_release(self, db, release_id: int) -> None:
        del db, release_id


def _release_metadata(
    artifact: bytes,
    *,
    commit_sha: str,
    request_id: int | None = None,
    revision: int | None = None,
    slug: str = "publication-test",
    version: str = "1.0.0",
) -> PluginReleaseMetadata:
    return PluginReleaseMetadata.model_validate(
        {
            "schemaVersion": 1,
            "changed": True,
            "plugin": {
                "slug": slug,
                "version": version,
                "listingType": "plugin",
            },
            "artifact": {
                "file": "plugin.zip",
                "sha256": hashlib.sha256(artifact).hexdigest(),
                "sizeBytes": len(artifact),
            },
            "source": {
                "projectId": "42",
                "ref": "master",
                "sourceCommitSha": commit_sha,
                "pipelineId": 99,
                "pipelineUrl": "https://git.invalid/pipelines/99",
                "metadata": {"projectPath": "wework-plugins"},
            },
            "requestId": request_id,
            "revision": revision,
        }
    )


def _create_and_complete(
    service: PluginPublicationService,
    db,
    user_id: int,
    storage: FakeStorage,
    *,
    package: bytes,
    risk_declaration: dict | None = None,
    test_notes: str = "Validated locally",
):
    digest = hashlib.sha256(package).hexdigest()
    upload = service.create_request(
        db,
        user_id=user_id,
        payload=PluginPublicationCreateRequest(
            slug="publication-test",
            displayName="Publication Test",
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256=digest,
            sizeBytes=len(package),
            releaseNotes="Initial enterprise publication",
            testNotes=test_notes,
            riskDeclaration=risk_declaration or {},
        ),
    )
    service.upload_revision_package(
        db,
        user_id=user_id,
        request_id=upload.requestId,
        revision_number=1,
        package=package,
    )
    detail = service.complete_revision(
        db,
        user_id=user_id,
        request_id=upload.requestId,
        revision_number=1,
    )
    return upload, detail


def _accept_and_fail_pipeline(
    service: PluginPublicationService,
    db,
    *,
    user_id: int,
    admin_user: User,
    storage: FakeStorage,
):
    package = _plugin_zip()
    upload, _ = _create_and_complete(service, db, user_id, storage, package=package)
    accepted = service.accept_request(
        db,
        admin_user=admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=[],
        ),
    )
    service.record_gitlab_event(
        db,
        event_id=f"pipeline-failed-{upload.requestId}",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 301,
                "ref": accepted.gitlab.sourceBranch,
                "sha": accepted.gitlab.commitSha,
                "status": "failed",
            },
            "builds": [
                {
                    "name": "wework-linux",
                    "stage": "verify",
                    "status": "failed",
                    "failure_reason": "script_failure",
                }
            ],
        },
    )
    return upload, package


def test_request_activation_locks_submitter_row_for_capacity_serialization() -> None:
    db = MagicMock()
    filtered_query = db.query.return_value.filter.return_value
    locked_query = filtered_query.with_for_update.return_value
    locked_query.first.return_value = (7,)
    service = PluginPublicationService(storage=FakeStorage(), gitlab=FakeGitLab())

    service._lock_submitter_for_activation(db, user_id=7)

    db.query.assert_called_once_with(User.id)
    filtered_query.with_for_update.assert_called_once_with()


def test_active_request_capacity_is_enforced_for_ordinary_owner(
    test_db, test_user, monkeypatch
) -> None:
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS", 1)

    service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            slug="capacity-one",
            displayName="Capacity one",
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256="1" * 64,
            sizeBytes=128,
            releaseNotes="First request",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )

    with pytest.raises(HTTPException) as at_capacity:
        service.create_request(
            test_db,
            user_id=test_user.id,
            payload=PluginPublicationCreateRequest(
                slug="capacity-two",
                displayName="Capacity two",
                requestedVersion="1.0.0",
                filename="plugin.zip",
                snapshotSha256="2" * 64,
                sizeBytes=128,
                releaseNotes="Second request",
                testNotes="Validated locally",
                riskDeclaration={},
            ),
        )

    assert at_capacity.value.status_code == 429
    assert at_capacity.value.detail == "Too many active plugin publication requests"


def test_terminal_request_reactivation_rechecks_owner_capacity(
    test_db, test_user, monkeypatch
) -> None:
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS", 1)
    first = service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            slug="reactivation-one",
            displayName="Reactivation one",
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256="3" * 64,
            sizeBytes=128,
            releaseNotes="First request",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )
    service.withdraw_request(test_db, user_id=test_user.id, request_id=first.requestId)
    service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            slug="reactivation-two",
            displayName="Reactivation two",
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256="4" * 64,
            sizeBytes=128,
            releaseNotes="Second request",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )

    with pytest.raises(HTTPException) as at_capacity:
        service.create_revision(
            test_db,
            user_id=test_user.id,
            request_id=first.requestId,
            payload=PluginPublicationRevisionCreateRequest(
                requestedVersion="1.1.0",
                filename="plugin.zip",
                snapshotSha256="5" * 64,
                sizeBytes=128,
                releaseNotes="Reactivate first request",
                testNotes="Validated locally",
            ),
        )

    assert at_capacity.value.status_code == 429


def test_terminal_request_cannot_reactivate_beside_same_source_request(
    test_db, test_user
) -> None:
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    first = service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            slug="same-source-reactivation",
            displayName="Same source",
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256="6" * 64,
            sizeBytes=128,
            releaseNotes="First request",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )
    service.withdraw_request(test_db, user_id=test_user.id, request_id=first.requestId)
    service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            sourcePluginId=first.sourcePluginId,
            displayName="Same source",
            requestedVersion="1.1.0",
            filename="plugin.zip",
            snapshotSha256="7" * 64,
            sizeBytes=128,
            releaseNotes="Replacement request",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )

    with pytest.raises(HTTPException) as duplicate:
        service.create_revision(
            test_db,
            user_id=test_user.id,
            request_id=first.requestId,
            payload=PluginPublicationRevisionCreateRequest(
                requestedVersion="1.2.0",
                filename="plugin.zip",
                snapshotSha256="8" * 64,
                sizeBytes=128,
                releaseNotes="Reactivate old request",
                testNotes="Validated locally",
            ),
        )

    assert duplicate.value.status_code == 409
    assert "another active publication request" in duplicate.value.detail


def test_snapshot_completion_and_return_revision_are_immutable(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    package = _plugin_zip(
        manifest_extra={
            "credentials": {"token": "must-not-leak"},
            "metadata": {"owner": "plugin-team"},
        }
    )

    upload, detail = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )

    assert upload.sourcePluginId == detail.pluginId
    assert upload.revision.number == 1
    assert upload.revision.requestedVersion == "1.0.0"
    assert detail.status == "awaiting_admin"
    assert detail.currentRevision == 1
    assert detail.actionEligibility.canWithdraw is True
    assert detail.actionEligibility.canReturn is False
    assert detail.revision.snapshotSha256 == hashlib.sha256(package).hexdigest()
    assert detail.revision.manifest["credentials"] == "[redacted]"
    assert detail.revision.manifest["metadata"] == {"owner": "plugin-team"}
    assert detail.revision.packageEntries == [
        ".codex-plugin/plugin.json",
        "skills/example/SKILL.md",
    ]
    assert detail.revision.packageEntryCount == 2
    assert detail.revision.packageEntriesTruncated is False
    assert detail.revision.capabilities == ["skill:example"]
    assert detail.checks
    listed = service.list_requests(
        test_db,
        user_id=test_user.id,
        is_admin=False,
        page=1,
        limit=20,
        source_plugin_id=detail.pluginId,
        active_only=True,
    )
    assert listed.total == 1
    assert listed.page == 1
    assert listed.limit == 20
    assert listed.items[0].requestedVersion == "1.0.0"
    assert listed.items[0].waitingDurationSeconds >= 0

    returned = service.return_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=ReturnPluginPublicationRequest(
            currentRevision=1,
            reason="Please update the tests",
            requiredChanges=["Add a regression case"],
        ),
    )
    assert returned.status == "changes_requested"
    admin_changes_event = next(
        event
        for event in returned.events
        if event.eventType == "admin.changes_requested"
    )
    assert admin_changes_event.requiredChanges == ["Add a regression case"]
    assert "payload" not in admin_changes_event.model_dump()
    owner_returned = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert owner_returned.actionEligibility.canCreateRevision is True
    assert owner_returned.actionEligibility.canReturn is False
    changes_requested_event = next(
        event
        for event in owner_returned.events
        if event.eventType == "admin.changes_requested"
    )
    assert changes_requested_event.message == "Please update the tests"
    assert changes_requested_event.requiredChanges == ["Add a regression case"]
    repeated = service.return_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=ReturnPluginPublicationRequest(
            currentRevision=1,
            reason="Ignored on idempotent retry",
            requiredChanges=["Ignored"],
        ),
    )
    assert repeated.status == "changes_requested"

    package_v2 = _plugin_zip("1.1.0")
    upload_v2 = service.create_revision(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
        payload=PluginPublicationRevisionCreateRequest(
            requestedVersion="1.1.0",
            filename="plugin.zip",
            snapshotSha256=hashlib.sha256(package_v2).hexdigest(),
            sizeBytes=len(package_v2),
            releaseNotes="Update regression coverage",
            testNotes="Updated regression case",
        ),
    )
    assert upload_v2.revision.number == 2
    old_revision = (
        test_db.query(PluginPublicationRevision)
        .filter(
            PluginPublicationRevision.request_id == upload.requestId,
            PluginPublicationRevision.revision == 1,
        )
        .one()
    )
    assert old_revision.snapshot_sha256 == hashlib.sha256(package).hexdigest()
    uploading_detail = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert [item.number for item in uploading_detail.revisions] == [1, 2]
    assert uploading_detail.revision.number == 2
    assert uploading_detail.actionEligibility.canWithdraw is True
    assert uploading_detail.actionEligibility.canCreateRevision is False
    withdrawn_upload = service.withdraw_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert withdrawn_upload.status == "withdrawn"
    assert withdrawn_upload.actionEligibility.canCreateRevision is True


def test_slug_request_completion_publishes_personal_marketplace_release(
    test_db, test_user
):
    storage = FakeStorage()
    marketplace = PluginMarketplaceService()
    service = PluginPublicationService(
        storage=storage,
        gitlab=FakeGitLab(),
        marketplace=marketplace,
    )
    package = _plugin_zip()

    upload, detail = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )

    personal = test_db.get(Plugin, upload.sourcePluginId)
    revision = test_db.get(PluginPublicationRevision, upload.revision.id)
    release = test_db.get(PluginRelease, revision.source_release_id)
    assert detail.status == "awaiting_admin"
    assert personal.status == "published"
    assert personal.visibility == "personal"
    assert personal.latest_release_id == release.id
    assert release.status == "ready"
    assert release.scan_status == "passed"
    assert release.version == "1.0.0"
    assert release.sha256 == hashlib.sha256(package).hexdigest()
    assert release.scan_report_json["provenance"] == {
        "kind": "publication_source",
        "requestId": upload.requestId,
        "revision": 1,
        "snapshotSha256": hashlib.sha256(package).hexdigest(),
    }
    listed = marketplace.list_plugins(test_db, user_id=test_user.id)
    listed_personal = next(item for item in listed.items if item.id == personal.id)
    assert listed_personal.catalogNamespace == f"personal/{test_user.id}"
    assert listed_personal.visibility == "personal"
    assert listed_personal.latestReleaseId == release.id


@pytest.mark.parametrize("include_source_release", [False, True])
def test_source_plugin_flow_does_not_duplicate_personal_release(
    test_db, test_user, include_source_release
):
    storage = FakeStorage()
    marketplace = PluginMarketplaceService()
    source = Plugin(
        catalog_namespace=f"personal/{test_user.id}",
        slug="publication-test",
        name="publication-test",
        display_name="Publication Test",
        listing_type="plugin",
        source_type="submission",
        source_provider="user",
        owner_user_id=test_user.id,
        visibility="personal",
        status="draft",
    )
    test_db.add(source)
    test_db.commit()
    package = _plugin_zip()
    existing = marketplace.publish_personal_release(
        test_db,
        plugin_id=source.id,
        owner_user_id=test_user.id,
        package=package,
        storage=storage,
    )
    service = PluginPublicationService(
        storage=storage,
        gitlab=FakeGitLab(),
        marketplace=marketplace,
    )
    digest = hashlib.sha256(package).hexdigest()
    upload = service.create_request(
        test_db,
        user_id=test_user.id,
        payload=PluginPublicationCreateRequest(
            sourcePluginId=source.id,
            sourceReleaseId=(existing.release.id if include_source_release else None),
            requestedVersion="1.0.0",
            filename="plugin.zip",
            snapshotSha256=digest,
            sizeBytes=len(package),
            releaseNotes="Publish existing personal version",
            testNotes="Validated locally",
            riskDeclaration={},
        ),
    )
    revision = test_db.get(PluginPublicationRevision, upload.revision.id)
    storage.objects[revision.staging_storage_key] = package

    detail = service.complete_revision(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
        revision_number=1,
    )

    releases = (
        test_db.query(PluginRelease).filter(PluginRelease.plugin_id == source.id).all()
    )
    assert detail.status == "awaiting_admin"
    assert len(releases) == 1
    assert revision.source_release_id == (
        existing.release.id if include_source_release else 0
    )
    assert test_db.get(Plugin, source.id).latest_release_id == existing.release.id


def test_invalid_snapshot_root_fails_checks_and_allows_client_compensation(
    test_db, test_user
):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    package = _wrapped_plugin_zip_with_outside_file()

    _, detail = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )

    assert detail.status == "automatic_check_failed"
    assert detail.actionEligibility.canCreateRevision is True
    assert detail.actionEligibility.canWithdraw is True
    assert detail.checks[0].checkCode == "package.inspection_failed"
    assert "outside the plugin root" in detail.checks[0].summary


def test_request_detail_fails_closed_for_cross_request_revision_pointer(
    test_db, test_user
):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    upload, _ = _create_and_complete(
        service,
        test_db,
        test_user.id,
        storage,
        package=_plugin_zip(),
    )
    other_request = PluginPublicationRequest(
        source_plugin_id=upload.sourcePluginId,
        submitter_user_id=test_user.id,
        current_revision=1,
        aggregate_status="uploading",
    )
    test_db.add(other_request)
    test_db.flush()
    other_revision = PluginPublicationRevision(
        request_id=other_request.id,
        revision=1,
        requested_version="2.0.0",
        snapshot_sha256="b" * 64,
        staging_storage_key="pending",
        filename="plugin.zip",
        size_bytes=1,
        created_by_user_id=test_user.id,
    )
    test_db.add(other_revision)
    test_db.flush()
    other_request.current_revision_id = other_revision.id
    original_request = test_db.get(PluginPublicationRequest, upload.requestId)
    original_request.current_revision_id = other_revision.id
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        service.get_request(
            test_db,
            user_id=test_user.id,
            request_id=upload.requestId,
        )

    assert exc_info.value.status_code == 404


def test_request_list_filters_submission_time_and_orders_pending_before_terminal(
    test_db, test_user
):
    service = PluginPublicationService(storage=FakeStorage(), gitlab=FakeGitLab())
    base = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=10)

    def add_request(slug: str, status: str, submitted_at: datetime, sha: str) -> None:
        plugin = Plugin(
            catalog_namespace=f"personal/{test_user.id}",
            slug=slug,
            name=slug,
            display_name=slug,
            listing_type="plugin",
            source_type="submission",
            source_provider="user",
            owner_user_id=test_user.id,
            keywords_json=[],
            interface_json={},
            visibility="personal",
            status="draft",
        )
        test_db.add(plugin)
        test_db.flush()
        request = PluginPublicationRequest(
            source_plugin_id=plugin.id,
            submitter_user_id=test_user.id,
            current_revision=1,
            aggregate_status=status,
            submitted_at=submitted_at,
            created_at=submitted_at,
            updated_at=submitted_at + timedelta(seconds=30),
        )
        test_db.add(request)
        test_db.flush()
        revision = PluginPublicationRevision(
            request_id=request.id,
            revision=1,
            requested_version="1.0.0",
            snapshot_sha256=sha * 64,
            source_tree_sha256=sha * 64,
            staging_storage_key="",
            storage_key=f"snapshots/{slug}.zip",
            filename="plugin.zip",
            size_bytes=1,
            manifest_snapshot={"name": slug, "version": "1.0.0"},
            package_entries_json=[".codex-plugin/plugin.json"],
            package_entry_count=1,
            capabilities_json=[],
            status=status,
            pipeline_status="success" if status == "published" else "",
            created_by_user_id=test_user.id,
            completed_at=submitted_at,
            created_at=submitted_at,
            updated_at=submitted_at + timedelta(seconds=30),
        )
        test_db.add(revision)
        test_db.flush()
        request.current_revision_id = revision.id

    add_request("pending-old", "awaiting_admin", base, "a")
    add_request(
        "pending-new",
        "draft_mr_open",
        base + timedelta(minutes=1),
        "b",
    )
    add_request("terminal-old", "published", base + timedelta(minutes=2), "c")
    add_request("terminal-new", "withdrawn", base + timedelta(minutes=3), "d")
    test_db.commit()

    listed = service.list_requests(
        test_db,
        user_id=None,
        is_admin=True,
        page=1,
        limit=20,
    )
    assert [item.pluginSlug for item in listed.items] == [
        "pending-old",
        "pending-new",
        "terminal-new",
        "terminal-old",
    ]
    assert listed.items[-1].gitlabStatus == "success"
    assert all(item.requestedVersion == "1.0.0" for item in listed.items)
    assert all(item.waitingDurationSeconds >= 0 for item in listed.items)

    filtered = service.list_requests(
        test_db,
        user_id=None,
        is_admin=True,
        page=1,
        limit=20,
        submitted_after=(base + timedelta(seconds=30)).replace(tzinfo=timezone.utc),
        submitted_before=(base + timedelta(minutes=2, seconds=30)).replace(
            tzinfo=timezone.utc
        ),
    )
    assert [item.pluginSlug for item in filtered.items] == [
        "pending-new",
        "terminal-old",
    ]

    with pytest.raises(HTTPException) as invalid_window:
        service.list_requests(
            test_db,
            user_id=None,
            is_admin=True,
            page=1,
            limit=20,
            submitted_after=base + timedelta(days=1),
            submitted_before=base,
        )
    assert invalid_window.value.status_code == 422


def test_admin_accept_creates_one_mr_and_requires_warning_acknowledgement(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    gitlab = FakeGitLab()
    service = PluginPublicationService(storage=storage, gitlab=gitlab)
    package = _plugin_zip()
    upload, detail = _create_and_complete(
        service,
        test_db,
        test_user.id,
        storage,
        package=package,
        risk_declaration={
            "externalNetworkAccess": True,
            "externalDomains": ["api.example.com"],
        },
    )
    assert detail.status == "awaiting_admin"
    source_plugin = test_db.get(Plugin, upload.sourcePluginId)
    source_plugin.display_name = "Test Plugin"
    test_db.commit()
    admin_detail = service.get_request(
        test_db,
        user_id=None,
        request_id=upload.requestId,
        is_admin=True,
    )
    assert admin_detail.actionEligibility.canAccept is True
    assert admin_detail.actionEligibility.canWithdraw is False

    with pytest.raises(HTTPException) as exc:
        service.accept_request(
            test_db,
            admin_user=test_admin_user,
            request_id=upload.requestId,
            payload=AcceptPluginPublicationRequest(
                currentRevision=1,
                acknowledgedWarningCodes=[],
            ),
        )
    assert exc.value.status_code == 409

    accepted = service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=["risk.external_network"],
        ),
    )
    assert accepted.status == "draft_mr_open"
    assert accepted.gitlab.mergeRequestIid == 7
    assert len(gitlab.calls) == 1
    assert gitlab.calls[0]["plugin_name"] == "Test Plugin"
    assert gitlab.calls[0]["version"] == "1.0.0"
    assert gitlab.calls[0]["risk_declaration"]["externalNetworkAccess"] is True
    personal_releases = (
        test_db.query(PluginRelease)
        .filter(PluginRelease.plugin_id == upload.sourcePluginId)
        .all()
    )
    assert len(personal_releases) == 1
    assert personal_releases[0].status == "ready"
    assert accepted.enterprisePluginId is None

    repeated = service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=["risk.external_network"],
        ),
    )
    assert repeated.status == "draft_mr_open"
    assert len(gitlab.calls) == 1

    direct_metadata = _release_metadata(package, commit_sha="b" * 40)
    with pytest.raises(HTTPException) as direct_release:
        service.publish_enterprise_release(
            test_db,
            package=package,
            metadata=direct_metadata,
            idempotency_key=expected_release_idempotency_key(
                direct_metadata.model_dump(mode="json")
            ),
            release_key_id=9,
        )
    assert direct_release.value.status_code == 409
    assert "active controlled publication request" in str(direct_release.value.detail)


def test_materializing_request_cannot_be_withdrawn(test_db, test_user):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    package = _plugin_zip()
    upload, _ = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )
    request = test_db.get(PluginPublicationRequest, upload.requestId)
    revision = test_db.get(PluginPublicationRevision, request.current_revision_id)
    request.aggregate_status = "materializing"
    revision.status = "materializing"
    test_db.commit()

    detail = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert detail.actionEligibility.canWithdraw is False
    with pytest.raises(HTTPException) as exc_info:
        service.withdraw_request(
            test_db, user_id=test_user.id, request_id=upload.requestId
        )
    assert exc_info.value.status_code == 409


def test_gitlab_events_do_not_regress_withdrawn_or_stale_revisions(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    gitlab = FakeGitLab()
    service = PluginPublicationService(storage=storage, gitlab=gitlab)
    package = _plugin_zip()
    upload, _ = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )
    service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=[],
        ),
    )
    withdrawn = service.withdraw_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert withdrawn.status == "withdrawn"

    ignored_terminal = service.record_gitlab_event(
        test_db,
        event_id="terminal-event",
        event_name="Merge Request Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {"iid": 7, "state": "opened"},
        },
    )
    assert ignored_terminal.status == "withdrawn"

    revision = test_db.get(PluginPublicationRevision, upload.revision.id)
    artifact = _materialized_zip(
        package,
        request_id=upload.requestId,
        revision=1,
        snapshot_sha256=revision.snapshot_sha256,
        source_tree_sha256=revision.source_tree_sha256,
        risk_declaration=dict(revision.risk_declaration),
        test_notes=revision.test_notes,
    )
    metadata = _release_metadata(
        artifact,
        commit_sha="b" * 40,
        request_id=upload.requestId,
        revision=1,
    )
    with pytest.raises(HTTPException) as withdrawn_release:
        service.publish_enterprise_release(
            test_db,
            package=artifact,
            metadata=metadata,
            idempotency_key=expected_release_idempotency_key(
                metadata.model_dump(mode="json")
            ),
            release_key_id=9,
        )
    assert withdrawn_release.value.status_code == 409
    assert not gitlab.verification_calls
    assert (
        test_db.get(PluginPublicationRequest, upload.requestId).aggregate_status
        == "withdrawn"
    )

    package_v2 = _plugin_zip("1.1.0")
    upload_v2 = service.create_revision(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
        payload=PluginPublicationRevisionCreateRequest(
            requestedVersion="1.1.0",
            snapshotSha256=hashlib.sha256(package_v2).hexdigest(),
            sizeBytes=len(package_v2),
            releaseNotes="Retry after withdrawal",
            testNotes="Validated locally",
        ),
    )
    historical = service.get_request(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
        revision_number=1,
    )
    assert historical.currentRevision == 2
    assert historical.status == "uploading"
    assert historical.revision.number == 1
    assert historical.revision.status == "withdrawn"
    assert historical.gitlab.mergeRequestIid == 7
    assert historical.checks
    assert historical.events
    assert all(
        test_db.get(PluginPublicationRevision, check.revision_id).revision == 1
        for check in test_db.query(PluginPublicationCheck)
        .filter(PluginPublicationCheck.id.in_([item.id for item in historical.checks]))
        .all()
    )
    assert all(
        test_db.get(PluginPublicationEvent, item.id).revision_id == upload.revision.id
        for item in historical.events
    )
    assert historical.actionEligibility.canWithdraw is True
    admin_historical = service.get_request(
        test_db,
        user_id=None,
        request_id=upload.requestId,
        is_admin=True,
        revision_number=1,
    )
    assert admin_historical.revision.number == 1
    assert admin_historical.actionEligibility.canAccept is False
    current = service.get_request(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
    )
    assert current.revision.number == 2
    assert current.gitlab is None
    assert [item.eventType for item in current.events] == ["revision.created"]
    with pytest.raises(HTTPException) as missing_revision:
        service.get_request(
            test_db,
            user_id=test_user.id,
            request_id=upload.requestId,
            revision_number=3,
        )
    assert missing_revision.value.status_code == 404

    ignored_stale = service.record_gitlab_event(
        test_db,
        event_id="stale-event",
        event_name="Merge Request Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {"iid": 7, "state": "merged"},
        },
    )
    assert ignored_stale.currentRevision == 2
    assert ignored_stale.status == "uploading"
    assert upload_v2.revision.status == "uploading"
    assert (
        test_db.query(PluginPublicationEvent)
        .filter(PluginPublicationEvent.event_type == "gitlab.event_ignored")
        .count()
        == 2
    )


def test_gitlab_events_are_project_bound_and_monotonic(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    package = _plugin_zip()
    upload, _ = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )
    accepted = service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=[],
        ),
    )
    source_branch = accepted.gitlab.sourceBranch

    with pytest.raises(HTTPException) as project_error:
        service.record_gitlab_event(
            test_db,
            event_id="wrong-project",
            event_name="Pipeline Hook",
            expected_project_id="42",
            payload={
                "project": {"id": 41},
                "object_attributes": {"ref": source_branch, "status": "success"},
            },
        )
    assert project_error.value.status_code == 403

    revision = test_db.get(PluginPublicationRevision, upload.revision.id)
    materialized_sha = revision.commit_sha
    running = service.record_gitlab_event(
        test_db,
        event_id="pipeline-running",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 101,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "running",
            },
        },
    )
    assert running.status == "ci_running"

    old_pipeline = service.record_gitlab_event(
        test_db,
        event_id="old-pipeline-success",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 100,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "success",
            },
        },
    )
    assert old_pipeline.status == "ci_running"
    assert revision.pipeline_id == 101

    failed = service.record_gitlab_event(
        test_db,
        event_id="pipeline-failed",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 101,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "failed",
            },
            "builds": [
                {
                    "name": "wework-linux",
                    "stage": "verify",
                    "status": "failed",
                    "failure_reason": "script_failure",
                    "web_url": "https://git.invalid/jobs/301",
                    "trace": "PRIVATE-TOKEN=must-not-be-projected",
                },
                {
                    "name": "wework-release",
                    "stage": "release",
                    "status": "skipped",
                },
            ],
        },
    )
    assert failed.status == "code_changes_requested"
    assert failed.actionEligibility.canReturn is True
    failure_event = next(
        event for event in failed.events if event.eventType == "gitlab.pipeline_failed"
    )
    assert failure_event.actorType == "pipeline"
    assert [detail.model_dump() for detail in failure_event.failureDetails] == [
        {
            "jobName": "wework-linux",
            "stage": "verify",
            "status": "failed",
            "reason": "script_failure",
            "jobUrl": "https://git.invalid/jobs/301",
        }
    ]
    assert "PRIVATE-TOKEN" not in failure_event.model_dump_json()
    owner_failed = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert owner_failed.actionEligibility.canCreateRevision is True

    failed_pipeline_late_running = service.record_gitlab_event(
        test_db,
        event_id="failed-pipeline-running-late",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 101,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "running",
            },
        },
    )
    assert failed_pipeline_late_running.status == "code_changes_requested"
    assert revision.pipeline_id == 101
    assert revision.pipeline_status == "failed"

    wrong_sha = service.record_gitlab_event(
        test_db,
        event_id="wrong-sha-pipeline-success",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 102,
                "ref": source_branch,
                "sha": "c" * 40,
                "status": "success",
            },
        },
    )
    assert wrong_sha.status == "code_changes_requested"
    assert revision.pipeline_id == 101

    retried = service.record_gitlab_event(
        test_db,
        event_id="new-pipeline-running",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 103,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "running",
            },
        },
    )
    assert retried.status == "ci_running"
    assert revision.pipeline_id == 103

    ready = service.record_gitlab_event(
        test_db,
        event_id="pipeline-success",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 103,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "success",
            },
        },
    )
    assert ready.status == "merge_ready"
    late_running = service.record_gitlab_event(
        test_db,
        event_id="pipeline-running-late",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 103,
                "ref": source_branch,
                "sha": materialized_sha,
                "status": "running",
            },
        },
    )
    assert late_running.status == "merge_ready"

    merged = service.record_gitlab_event(
        test_db,
        event_id="merged",
        event_name="Merge Request Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "iid": 7,
                "state": "merged",
                "merge_commit_sha": "b" * 40,
            },
        },
    )
    assert merged.status == "merged"
    late_failed = service.record_gitlab_event(
        test_db,
        event_id="pipeline-failed-late",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 101,
                "ref": source_branch,
                "status": "failed",
            },
        },
    )
    assert late_failed.status == "merged"

    unknown_branch = service.record_gitlab_event(
        test_db,
        event_id="uncontrolled-branch",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "ref": "feature/same-looking-branch",
                "status": "success",
            },
        },
    )
    assert unknown_branch is None


def test_closed_merge_request_is_terminal_and_allows_a_new_revision(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    service = PluginPublicationService(storage=storage, gitlab=FakeGitLab())
    package = _plugin_zip()
    upload, _ = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )
    accepted = service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=[],
        ),
    )

    closed = service.record_gitlab_event(
        test_db,
        event_id="merge-request-closed",
        event_name="Merge Request Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "user": {"name": "Code Reviewer", "username": "reviewer"},
            "object_attributes": {"iid": 7, "state": "closed"},
        },
    )
    assert closed.status == "closed"
    owner_detail = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert owner_detail.actionEligibility.canCreateRevision is True
    closed_event = next(
        event
        for event in owner_detail.events
        if event.eventType == "gitlab.merge_request_closed"
    )
    assert closed_event.actorName == "Code Reviewer"
    assert "without a supplied reason" in closed_event.message

    late_success = service.record_gitlab_event(
        test_db,
        event_id="closed-pipeline-success-late",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "ref": accepted.gitlab.sourceBranch,
                "status": "success",
            },
        },
    )
    assert late_success.status == "closed"


def test_pipeline_failure_can_be_returned_with_an_admin_reason(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    gitlab = FakeGitLab()
    service = PluginPublicationService(storage=storage, gitlab=gitlab)
    upload, _ = _accept_and_fail_pipeline(
        service,
        test_db,
        user_id=test_user.id,
        admin_user=test_admin_user,
        storage=storage,
    )

    returned = service.return_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=ReturnPluginPublicationRequest(
            currentRevision=1,
            reason="Pipeline 检查未通过，请修复 Linux 打包脚本",
            requiredChanges=["修复 wework-linux 任务"],
        ),
    )

    assert returned.status == "changes_requested"
    assert gitlab.closed_merge_request_iids == [7]
    event = next(
        item for item in returned.events if item.eventType == "admin.changes_requested"
    )
    assert event.message == "Pipeline 检查未通过，请修复 Linux 打包脚本"
    assert event.requiredChanges == ["修复 wework-linux 任务"]


def test_pipeline_failure_allows_a_new_revision_and_closes_the_previous_mr(
    test_db, test_user, test_admin_user
):
    storage = FakeStorage()
    gitlab = FakeGitLab()
    service = PluginPublicationService(storage=storage, gitlab=gitlab)
    upload, _ = _accept_and_fail_pipeline(
        service,
        test_db,
        user_id=test_user.id,
        admin_user=test_admin_user,
        storage=storage,
    )
    package_v2 = _plugin_zip("1.0.1")

    created = service.create_revision(
        test_db,
        user_id=test_user.id,
        request_id=upload.requestId,
        payload=PluginPublicationRevisionCreateRequest(
            requestedVersion="1.0.1",
            filename="plugin.zip",
            snapshotSha256=hashlib.sha256(package_v2).hexdigest(),
            sizeBytes=len(package_v2),
            releaseNotes="修复 Pipeline 失败",
            testNotes="已重新验证 Linux 打包",
        ),
    )

    assert created.revision.number == 2
    assert gitlab.closed_merge_request_iids == [7]
    previous = (
        test_db.query(PluginPublicationRevision)
        .filter(
            PluginPublicationRevision.request_id == upload.requestId,
            PluginPublicationRevision.revision == 1,
        )
        .one()
    )
    assert previous.merge_request_status == "closed"


def test_release_service_requires_authenticated_principal_identity():
    package = _plugin_zip()
    metadata = _release_metadata(package, commit_sha="a" * 40)
    service = PluginPublicationService(storage=FakeStorage(), gitlab=FakeGitLab())

    with pytest.raises(HTTPException) as unauthenticated:
        service.publish_enterprise_release(
            None,
            package=package,
            metadata=metadata,
            idempotency_key=expected_release_idempotency_key(
                metadata.model_dump(mode="json")
            ),
            release_key_id=0,
        )

    assert unauthenticated.value.status_code == 401


def test_protected_release_links_changed_artifact_to_snapshot_and_namespace(
    test_db, test_user, test_admin_user, monkeypatch
):
    storage = FakeStorage()
    gitlab = FakeGitLab()
    marketplace = PluginMarketplaceService()
    service = PluginPublicationService(
        storage=storage,
        gitlab=gitlab,
        marketplace=marketplace,
    )
    package = _plugin_zip()
    upload, _ = _create_and_complete(
        service, test_db, test_user.id, storage, package=package
    )
    service.accept_request(
        test_db,
        admin_user=test_admin_user,
        request_id=upload.requestId,
        payload=AcceptPluginPublicationRequest(
            currentRevision=1,
            acknowledgedWarningCodes=[],
        ),
    )
    merged_sha = "b" * 40
    revision = test_db.get(PluginPublicationRevision, upload.revision.id)
    artifact = _materialized_zip(
        package,
        request_id=upload.requestId,
        revision=1,
        snapshot_sha256=revision.snapshot_sha256,
        source_tree_sha256=revision.source_tree_sha256,
        risk_declaration=dict(revision.risk_declaration),
        test_notes=revision.test_notes,
    )
    assert hashlib.sha256(artifact).hexdigest() != revision.snapshot_sha256
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.plugin_package_storage", storage
    )
    metadata = _release_metadata(
        artifact,
        commit_sha=merged_sha,
        request_id=upload.requestId,
        revision=1,
    )
    idempotency_key = expected_release_idempotency_key(metadata.model_dump(mode="json"))

    published = service.publish_enterprise_release(
        test_db,
        package=artifact,
        metadata=metadata,
        idempotency_key=idempotency_key,
        release_key_id=9,
    )

    assert published.created is True
    assert published.catalogNamespace == "enterprise"
    assert published.sha256 == hashlib.sha256(artifact).hexdigest()
    assert gitlab.verification_calls[0]["commit_sha"] == merged_sha
    assert gitlab.verification_calls[0]["slug"] == "publication-test"
    assert gitlab.verification_calls[0][
        "artifact_tree_sha256"
    ] == canonical_complete_tree_sha256(artifact)
    personal = test_db.get(Plugin, upload.sourcePluginId)
    enterprise = test_db.get(Plugin, published.pluginId)
    assert personal.catalog_namespace == f"personal/{test_user.id}"
    assert enterprise.catalog_namespace == "enterprise"
    assert personal.slug == enterprise.slug
    enterprise_item = next(
        item
        for item in marketplace.list_plugins(test_db, user_id=test_user.id).items
        if item.id == enterprise.id
    )
    assert enterprise_item.originPersonalPluginId == personal.id
    release = test_db.get(PluginRelease, published.releaseId)
    assert release.publication_revision_id == revision.id
    assert release.source_commit_sha == merged_sha
    owner_published = service.get_request(
        test_db, user_id=test_user.id, request_id=upload.requestId
    )
    assert owner_published.enterprisePluginId == enterprise.id
    assert owner_published.pluginId == personal.id
    assert len(owner_published.revisions) == 1
    assert owner_published.actionEligibility.canViewEnterprisePlugin is True

    late_running = service.record_gitlab_event(
        test_db,
        event_id="published-pipeline-running-late",
        event_name="Pipeline Hook",
        expected_project_id="42",
        payload={
            "project": {"id": 42},
            "object_attributes": {
                "id": 99,
                "ref": owner_published.gitlab.sourceBranch,
                "status": "running",
            },
        },
    )
    assert late_running.status == "published"

    tampered = _materialized_zip(
        _plugin_zip("1.0.0", skill_body="tampered source"),
        request_id=upload.requestId,
        revision=1,
        snapshot_sha256=revision.snapshot_sha256,
        source_tree_sha256=revision.source_tree_sha256,
        risk_declaration=dict(revision.risk_declaration),
        test_notes=revision.test_notes,
    )
    with pytest.raises(HTTPException) as tampered_error:
        tampered_metadata = _release_metadata(
            tampered,
            commit_sha=merged_sha,
            request_id=upload.requestId,
            revision=1,
        )
        service.publish_enterprise_release(
            test_db,
            package=tampered,
            metadata=tampered_metadata,
            idempotency_key=expected_release_idempotency_key(
                tampered_metadata.model_dump(mode="json")
            ),
            release_key_id=9,
        )
    assert tampered_error.value.status_code == 409

    repeated = service.publish_enterprise_release(
        test_db,
        package=artifact,
        metadata=metadata,
        idempotency_key=idempotency_key,
        release_key_id=9,
    )
    assert repeated == published
    assert repeated.releaseId == published.releaseId
    assert (
        test_db.query(PluginPublicationEvent)
        .filter(PluginPublicationEvent.event_type == "release.published")
        .count()
        == 1
    )


def test_release_idempotency_is_durable_for_concurrent_retry_and_payload_conflict(
    tmp_path,
):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'release-idempotency.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    Plugin.__table__.create(engine)
    PluginPublicationRequest.__table__.create(engine)
    PluginReleaseIdempotency.__table__.create(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    marketplace = BlockingMarketplace()
    service = PluginPublicationService(
        gitlab=FakeGitLab(),
        marketplace=marketplace,
    )
    package = _plugin_zip()
    metadata = _release_metadata(package, commit_sha="a" * 40)
    envelope = metadata.model_dump(mode="json")
    idempotency_key = expected_release_idempotency_key(envelope)

    def publish_once():
        with session_factory() as session:
            return service.publish_enterprise_release(
                session,
                package=package,
                metadata=metadata,
                idempotency_key=idempotency_key,
                release_key_id=9,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(publish_once)
        assert marketplace.entered.wait(timeout=5)
        second = executor.submit(publish_once)
        time.sleep(0.2)
        marketplace.allow_finish.set()
        first_response = first.result(timeout=5)
        second_response = second.result(timeout=5)

    assert first_response == second_response
    assert first_response.created is True
    assert marketplace.calls == 1
    with session_factory() as session:
        binding = session.query(PluginReleaseIdempotency).one()
        assert binding.status == "completed"
        assert binding.envelope_json == {
            "principal": {"type": "plugin_release_key", "id": 9},
            "release": envelope,
        }
        assert binding.artifact_sha256 == hashlib.sha256(package).hexdigest()

        with pytest.raises(HTTPException) as principal_conflict:
            service.publish_enterprise_release(
                session,
                package=package,
                metadata=metadata,
                idempotency_key=idempotency_key,
                release_key_id=10,
            )
        assert principal_conflict.value.status_code == 409

        conflicting_envelope = json.loads(json.dumps(envelope))
        conflicting_envelope["source"][
            "pipelineUrl"
        ] = "https://git.invalid/pipelines/other"
        conflicting_metadata = PluginReleaseMetadata.model_validate(
            conflicting_envelope
        )
        with pytest.raises(HTTPException) as conflict:
            service.publish_enterprise_release(
                session,
                package=package,
                metadata=conflicting_metadata,
                idempotency_key=idempotency_key,
                release_key_id=9,
            )
        assert conflict.value.status_code == 409


def test_enterprise_slug_cannot_cross_personal_origins(test_db, test_user, monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.plugin_package_storage", storage
    )
    marketplace = PluginMarketplaceService()
    first_source = Plugin(
        catalog_namespace=f"personal/{test_user.id}",
        slug="origin-source-one",
        name="origin-source-one",
        display_name="Origin one",
        listing_type="plugin",
        source_type="submission",
        source_provider="user",
        owner_user_id=test_user.id,
        visibility="personal",
        status="draft",
    )
    second_source = Plugin(
        catalog_namespace=f"personal/{test_user.id}",
        slug="origin-source-two",
        name="origin-source-two",
        display_name="Origin two",
        listing_type="plugin",
        source_type="submission",
        source_provider="user",
        owner_user_id=test_user.id,
        visibility="personal",
        status="draft",
    )
    test_db.add_all([first_source, second_source])
    test_db.flush()
    enterprise = Plugin(
        catalog_namespace="enterprise",
        slug="bound-enterprise",
        name="bound-enterprise",
        display_name="Bound enterprise",
        listing_type="plugin",
        source_type="native",
        source_provider="wework",
        owner_user_id=0,
        origin_plugin_id=first_source.id,
        visibility="workspace",
        status="draft",
    )
    legacy = Plugin(
        catalog_namespace="enterprise",
        slug="legacy-enterprise",
        name="legacy-enterprise",
        display_name="Legacy enterprise",
        listing_type="plugin",
        source_type="native",
        source_provider="wework",
        owner_user_id=0,
        origin_plugin_id=0,
        visibility="workspace",
        status="draft",
    )
    test_db.add_all([enterprise, legacy])
    test_db.commit()

    with pytest.raises(HTTPException) as mismatch:
        marketplace.publish_catalog_release(
            test_db,
            catalog_namespace="enterprise",
            slug="bound-enterprise",
            package=_plugin_zip(slug="bound-enterprise"),
            origin_plugin_id=second_source.id,
        )
    assert mismatch.value.detail["code"] == "ENTERPRISE_PLUGIN_ORIGIN_MISMATCH"

    with pytest.raises(HTTPException) as unbound:
        marketplace.publish_catalog_release(
            test_db,
            catalog_namespace="enterprise",
            slug="legacy-enterprise",
            package=_plugin_zip(slug="legacy-enterprise"),
            origin_plugin_id=first_source.id,
        )
    assert unbound.value.detail["code"] == "ENTERPRISE_PLUGIN_ORIGIN_UNBOUND"

    legacy.origin_plugin_id = first_source.id
    test_db.commit()
    migrated = marketplace.publish_catalog_release(
        test_db,
        catalog_namespace="enterprise",
        slug="legacy-enterprise",
        package=_plugin_zip(slug="legacy-enterprise"),
        origin_plugin_id=first_source.id,
    )
    assert migrated.created is True
    assert test_db.get(Plugin, legacy.id).origin_plugin_id == first_source.id
