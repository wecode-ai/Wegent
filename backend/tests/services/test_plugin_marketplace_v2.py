# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import stat
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.endpoints.installed_plugins import (
    _sync_global_capabilities,
    install_marketplace_plugin,
    report_installed_plugins_on_device,
    sync_installed_plugins_to_device,
    uninstall_installed_plugin,
)
from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
    PluginSubmission,
    PluginUpstream,
)
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.schemas.device import (
    DeviceCapabilityItemResult,
    DeviceCapabilitySyncResponse,
    DeviceCapabilitySyncResult,
)
from app.schemas.installed_plugin import (
    InstalledPluginUpdateRequest,
    PluginAccessTarget,
    PluginAccessUpdateRequest,
    PluginDeviceReportItem,
    PluginDeviceReportRequest,
    PluginSubmissionInitRequest,
    PluginUpstreamCreateRequest,
)
from app.services.device.capability_sync_service import (
    DeviceCapabilitySyncError,
    DeviceCapabilitySyncService,
    device_capability_sync_service,
)
from app.services.installed_plugin_service import installed_plugin_service
from app.services.official_plugin_publisher import OfficialPluginPublisher
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_migration_service import (
    PluginMarketplaceMigrationService,
)
from app.services.plugin_marketplace_service import (
    PluginMarketplaceService,
    plugin_marketplace_service,
)
from app.services.plugin_package_storage import (
    PluginPackageStorageError,
    plugin_package_storage,
)

GITHUB_UPSTREAM_SKILL_PATHS = (
    "skills/gh-address-comments/SKILL.md",
    "skills/gh-fix-ci/SKILL.md",
    "skills/github/SKILL.md",
    "skills/yeet/SKILL.md",
)


def _plugin_zip(
    version: str = "1.0.0", display_name: str = "GitLab Engineering"
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "gitlab-engineering",
                    "version": version,
                    "description": "Review merge requests and diagnose pipelines",
                    "interface": {
                        "displayName": display_name,
                        "shortDescription": "GitLab review and CI workflows",
                    },
                }
            ),
        )
        archive.writestr(
            "skills/review/SKILL.md",
            "---\nname: review\ndescription: Review a merge request\n---\n",
        )
    return output.getvalue()


def _github_upstream_zip(
    version: str = "0.1.6", *, skill_body: str = "# GitHub"
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            ".codex-plugin/plugin.json",
            json.dumps(
                {
                    "name": "github",
                    "version": version,
                    "description": "GitHub workflows",
                    "apps": ["app_123"],
                    "mcpServers": {"github": {"command": "legacy"}},
                    "interface": {"displayName": "GitHub"},
                }
            ),
        )
        archive.writestr(".app.json", "{}")
        archive.writestr(".mcp.json", "{}")
        archive.writestr("assets/logo.png", b"png")
        for path in GITHUB_UPSTREAM_SKILL_PATHS:
            name = path.split("/")[-2]
            body = skill_body if name == "github" else f"# {name}"
            archive.writestr(
                path,
                f"---\nname: {name}\ndescription: English description\n---\n\n{body}\n",
            )
        archive.writestr("skills/gh-address-comments/LICENSE.txt", "MIT")
        archive.writestr("skills/gh-fix-ci/LICENSE.txt", "MIT")
        archive.writestr("skills/yeet/LICENSE.txt", "MIT")
    return output.getvalue()


def _plugin_zip_with_sensitive_file() -> bytes:
    output = io.BytesIO(_plugin_zip())
    with zipfile.ZipFile(output, "a") as archive:
        archive.writestr(".env", "API_TOKEN=must-not-ship")
    return output.getvalue()


def _plugin_zip_with_symlink() -> bytes:
    output = io.BytesIO(_plugin_zip())
    with zipfile.ZipFile(output, "a") as archive:
        link = zipfile.ZipInfo("skills/escape")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "../../outside")
    return output.getvalue()


def _plugin_zip_with_duplicate_path() -> bytes:
    output = io.BytesIO(_plugin_zip())
    with zipfile.ZipFile(output, "a") as archive:
        archive.writestr("skills/review/SKILL.md", "duplicate")
    return output.getvalue()


def _plugin_zip_with_encrypted_member() -> bytes:
    package = bytearray(_plugin_zip())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        cursor = 0
        while (cursor := package.find(signature, cursor)) >= 0:
            flags = int.from_bytes(
                package[cursor + flag_offset : cursor + flag_offset + 2]
            )
            package[cursor + flag_offset : cursor + flag_offset + 2] = (
                flags | 1
            ).to_bytes(2, "little")
            cursor += len(signature)
    return bytes(package)


def _write_official_source(
    root, *, version: str = "1.0.0", skill_body: str = "Review a merge request"
):
    manifest_directory = root / ".codex-plugin"
    skill_directory = root / "skills" / "review"
    manifest_directory.mkdir(parents=True, exist_ok=True)
    skill_directory.mkdir(parents=True, exist_ok=True)
    (manifest_directory / "plugin.json").write_text(
        json.dumps(
            {
                "name": "official-review",
                "version": version,
                "description": "Official review workflows",
                "interface": {"displayName": "Official Review"},
            }
        ),
        encoding="utf-8",
    )
    (skill_directory / "SKILL.md").write_text(
        f"---\nname: review\ndescription: {skill_body}\n---\n",
        encoding="utf-8",
    )
    return root


def _mock_package_storage(monkeypatch, stored_packages: dict[str, bytes]) -> None:
    def put_immutable(key: str, data: bytes) -> bool:
        if key in stored_packages:
            if stored_packages[key] != data:
                raise PluginPackageStorageError("immutable object differs")
            return False
        stored_packages[key] = data
        return True

    def get(key: str) -> bytes:
        return stored_packages[key]

    monkeypatch.setattr(plugin_package_storage, "get", get)
    monkeypatch.setattr(
        plugin_package_storage,
        "put",
        lambda key, data: stored_packages.__setitem__(key, data),
    )
    monkeypatch.setattr(
        plugin_package_storage,
        "put_immutable",
        put_immutable,
    )
    monkeypatch.setattr(
        plugin_package_storage,
        "delete",
        lambda key: stored_packages.pop(key, None),
    )


def _upload_submission(
    service: PluginMarketplaceService,
    db: Session,
    *,
    user_id: int,
    submission_id: int,
    package: bytes,
) -> None:
    service.upload_submission_package(
        db,
        user_id=user_id,
        submission_id=submission_id,
        package=package,
    )


def _device_install(test_db, user_id: int) -> tuple[Kind, PluginRelease]:
    plugin = Plugin(
        slug="device-state",
        name="device-state",
        display_name="Device State",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/device-state.zip",
        sha256="e" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    installed = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        namespace="default",
        name="device-state",
        json={
            "spec": {
                "pluginId": plugin.id,
                "releaseId": release.id,
                "version": release.version,
                "enabled": True,
                "installState": "installed",
            }
        },
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()
    return installed, release


def test_submission_upload_uses_backend_ticket_and_stores_validated_package(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="backend-upload",
            displayName="Backend Upload",
            version="1.0.0",
            filename="backend-upload.zip",
            sha256=hashlib.sha256(package).hexdigest(),
            sizeBytes=len(package),
        ),
    )

    service.upload_submission_package(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )

    upload_url = urlsplit(initialized.uploadUrl)
    assert upload_url.path == (
        f"/api/plugins/submissions/{initialized.submissionId}/artifact"
    )
    assert parse_qs(upload_url.query)["token"]
    assert list(stored_packages.values()) == [package]


def test_restricted_submission_publishes_without_review_or_install_copy(
    test_db, test_user, monkeypatch
):
    release_notifier = Mock(return_value=1)
    service = PluginMarketplaceService(release_notifier=release_notifier)
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)

    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=digest,
            sizeBytes=len(package),
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    completed = service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )

    assert completed.status == "approved"
    assert completed.purpose == "restricted_share"
    release_notifier.assert_called_once_with(test_db, initialized.releaseId)
    catalog = service.list_plugins(test_db, user_id=test_user.id)
    assert [item.displayName for item in catalog.items] == ["GitLab Engineering"]
    assert catalog.items[0].sourceProvider == "user"
    assert catalog.items[0].latestReleaseId == initialized.releaseId

    installed = service.install(
        test_db,
        user_id=test_user.id,
        plugin_id=initialized.pluginId,
    )
    installed_id = int(installed.metadata["labels"]["id"])
    assert installed.spec.origin == "market"
    assert installed.spec.pluginId == initialized.pluginId
    assert installed.spec.releaseId == initialized.releaseId
    assert installed.spec.updatePolicy == "auto"
    assert installed.spec.visibility == "personal"
    assert installed.spec.packageRef is not None
    assert (
        test_db.query(SkillBinary).filter(SkillBinary.kind_id == installed_id).first()
        is None
    )


def test_task_bound_submission_rejects_another_task_token(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="task-bound",
            displayName="Task Bound",
            version="1.0.0",
            filename="task-bound.zip",
            sha256=hashlib.sha256(package).hexdigest(),
            sizeBytes=len(package),
        ),
        task_binding=(101, 202),
    )

    service.ensure_submission_task_binding(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        task_id=101,
        subtask_id=202,
    )
    with pytest.raises(HTTPException) as exc_info:
        service.ensure_submission_task_binding(
            test_db,
            user_id=test_user.id,
            submission_id=initialized.submissionId,
            task_id=101,
            subtask_id=203,
        )

    assert exc_info.value.status_code == 404


def test_restricted_submission_cannot_enter_legacy_review(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="review-once",
            displayName="Review Once",
            version="1.0.0",
            filename="review-once.zip",
            sha256=hashlib.sha256(package).hexdigest(),
            sizeBytes=len(package),
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    with pytest.raises(HTTPException, match="Pending submission not found"):
        service.review_submission(
            test_db,
            reviewer_user_id=test_user.id,
            submission_id=initialized.submissionId,
            approved=False,
            note="Rejected after approval",
        )


def test_cancelled_submission_can_retry_the_same_version(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    request = PluginSubmissionInitRequest(
        slug="retry-cancelled",
        displayName="Retry Cancelled",
        version="1.0.0",
        filename="plugin.zip",
        sha256=hashlib.sha256(package).hexdigest(),
        sizeBytes=len(package),
    )
    first = service.init_submission(test_db, user_id=test_user.id, request=request)

    cancelled = service.cancel_submission(
        test_db, user_id=test_user.id, submission_id=first.submissionId
    )
    second = service.init_submission(test_db, user_id=test_user.id, request=request)

    assert cancelled.status == "cancelled"
    assert second.releaseId > 0
    assert test_db.query(PluginRelease).count() == 1
    assert test_db.query(PluginSubmission).count() == 1
    assert test_db.get(PluginSubmission, second.submissionId).status == "uploading"


def test_rejected_submission_can_retry_the_same_version(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    request = PluginSubmissionInitRequest(
        slug="retry-rejected",
        displayName="Retry Rejected",
        version="1.0.0",
        filename="plugin.zip",
        sha256=hashlib.sha256(package).hexdigest(),
        sizeBytes=len(package),
    )
    first = service.init_submission(test_db, user_id=test_user.id, request=request)
    submission = test_db.get(PluginSubmission, first.submissionId)
    release = test_db.get(PluginRelease, first.releaseId)
    submission.status = "rejected"
    release.status = "rejected"
    test_db.commit()

    second = service.init_submission(test_db, user_id=test_user.id, request=request)

    assert second.releaseId > 0
    assert test_db.query(PluginRelease).count() == 1
    assert test_db.query(PluginSubmission).count() == 1
    assert test_db.get(PluginSubmission, second.submissionId).status == "uploading"


def test_expired_upload_can_retry_the_same_version(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    request = PluginSubmissionInitRequest(
        slug="retry-expired",
        displayName="Retry Expired",
        version="1.0.0",
        filename="plugin.zip",
        sha256=hashlib.sha256(package).hexdigest(),
        sizeBytes=len(package),
    )
    first = service.init_submission(test_db, user_id=test_user.id, request=request)
    submission = test_db.get(PluginSubmission, first.submissionId)
    submission.submitted_at = datetime.now() - timedelta(
        seconds=settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS + 1
    )
    test_db.commit()

    second = service.init_submission(test_db, user_id=test_user.id, request=request)

    assert second.releaseId > 0
    assert test_db.query(PluginRelease).count() == 1
    assert test_db.query(PluginSubmission).count() == 1
    assert test_db.get(PluginSubmission, second.submissionId).status == "uploading"


def test_active_upload_cannot_reuse_the_same_version(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    request = PluginSubmissionInitRequest(
        slug="active-upload",
        displayName="Active Upload",
        version="1.0.0",
        filename="plugin.zip",
        sha256=hashlib.sha256(package).hexdigest(),
        sizeBytes=len(package),
    )
    service.init_submission(test_db, user_id=test_user.id, request=request)

    with pytest.raises(HTTPException) as exc_info:
        service.init_submission(test_db, user_id=test_user.id, request=request)

    assert exc_info.value.status_code == 409


def test_uploading_restricted_update_keeps_the_published_release_visible(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    stored_packages: dict[str, bytes] = {}
    package_v1 = _plugin_zip("1.0.0", "GitLab Stable")
    _mock_package_storage(monkeypatch, stored_packages)
    first = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-stable",
            displayName="GitLab Stable",
            version="1.0.0",
            filename="gitlab-v1.zip",
            sha256=hashlib.sha256(package_v1).hexdigest(),
            sizeBytes=len(package_v1),
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=first.submissionId,
        package=package_v1,
    )
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=first.submissionId
    )

    package_v2 = _plugin_zip("2.0.0", "GitLab Next")
    _mock_package_storage(monkeypatch, stored_packages)
    second = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-stable",
            displayName="GitLab Next",
            version="2.0.0",
            filename="gitlab-v2.zip",
            sha256=hashlib.sha256(package_v2).hexdigest(),
            sizeBytes=len(package_v2),
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=second.submissionId,
        package=package_v2,
    )
    pending_catalog = service.list_plugins(test_db, user_id=test_user.id)
    assert [(item.displayName, item.version) for item in pending_catalog.items] == [
        ("GitLab Stable", "1.0.0")
    ]
    plugin = test_db.get(Plugin, first.pluginId)
    assert plugin.status == "published"
    assert plugin.latest_release_id == first.releaseId

    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=second.submissionId
    )
    published_catalog = service.list_plugins(test_db, user_id=test_user.id)
    assert [(item.displayName, item.version) for item in published_catalog.items] == [
        ("GitLab Next", "2.0.0")
    ]


def test_personal_submission_identity_is_independent_from_official_slug(
    test_db, test_user, monkeypatch
):
    official = Plugin(
        catalog_namespace="wework-official",
        slug="official-plugin",
        name="official-plugin",
        display_name="Official Plugin",
        source_type="native",
        source_provider="wework",
        owner_user_id=0,
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(official)
    test_db.flush()
    official_id = official.id
    test_db.commit()

    package = _plugin_zip()
    _mock_package_storage(monkeypatch, {})
    initialized = PluginMarketplaceService().init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="official-plugin",
            displayName="Personal Copy",
            version="9.0.0",
            filename="personal.zip",
            sha256=hashlib.sha256(package).hexdigest(),
            sizeBytes=len(package),
        ),
    )

    personal = test_db.get(Plugin, initialized.pluginId)
    assert personal.id != official_id
    assert personal.catalog_namespace == f"personal/{test_user.id}"
    assert personal.slug == official.slug


def test_official_package_build_is_deterministic_and_publish_is_idempotent(
    test_db, test_user, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review")
    release_notifier = Mock(return_value=1)
    marketplace_service = PluginMarketplaceService(release_notifier=release_notifier)
    publisher = OfficialPluginPublisher(marketplace_service=marketplace_service)
    first_build = publisher.build_package(source)
    second_build = publisher.build_package(source)
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)

    _, first = publisher.publish_directory(
        test_db,
        source_directory=source,
        visibility="public",
        created_by_user_id=test_user.id,
        provenance={
            "commitSha": "abc123",
            "buildUrl": "https://ci.example/build/1",
            "publisher": "release-bot",
        },
    )
    _, second = publisher.publish_directory(
        test_db,
        source_directory=source,
        visibility="public",
        created_by_user_id=test_user.id,
    )

    assert first_build.package == second_build.package
    assert first_build.sha256 == second_build.sha256
    assert first.created is True
    assert second.created is False
    release_notifier.assert_called_once_with(test_db, first.release.id)
    assert second.release.id == first.release.id
    assert test_db.query(PluginRelease).count() == 1
    plugin = test_db.get(Plugin, first.release.plugin_id)
    assert plugin.source_type == "native"
    assert plugin.source_provider == "wework"
    assert plugin.owner_user_id == 0
    assert plugin.latest_release_id == first.release.id
    assert first.release.scan_report_json["provenance"] == {
        "kind": "official",
        "commitSha": "abc123",
        "buildUrl": "https://ci.example/build/1",
        "publisher": "release-bot",
    }


def test_official_publish_rejects_same_version_with_different_package(
    test_db, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review")
    publisher = OfficialPluginPublisher()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    publisher.publish_directory(test_db, source_directory=source)
    _write_official_source(source, skill_body="Different package content")

    with pytest.raises(HTTPException, match="different content"):
        publisher.publish_directory(test_db, source_directory=source)

    assert test_db.query(PluginRelease).count() == 1


def test_official_publish_rolls_back_database_when_storage_fails(
    test_db, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review")
    monkeypatch.setattr(
        plugin_package_storage,
        "put_immutable",
        lambda *_args: (_ for _ in ()).throw(
            PluginPackageStorageError("storage unavailable")
        ),
    )

    with pytest.raises(PluginPackageStorageError, match="storage unavailable"):
        OfficialPluginPublisher().publish_directory(test_db, source_directory=source)

    assert test_db.query(Plugin).count() == 0
    assert test_db.query(PluginRelease).count() == 0


def test_official_publish_deletes_object_when_database_commit_fails(
    test_db, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review")
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    original_commit = test_db.commit
    monkeypatch.setattr(
        test_db,
        "commit",
        lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        OfficialPluginPublisher().publish_directory(test_db, source_directory=source)

    monkeypatch.setattr(test_db, "commit", original_commit)
    assert stored_packages == {}
    assert test_db.query(Plugin).count() == 0
    assert test_db.query(PluginRelease).count() == 0


def test_official_publish_never_moves_latest_to_an_older_version(
    test_db, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review", version="2.0.0")
    publisher = OfficialPluginPublisher()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    _, current = publisher.publish_directory(test_db, source_directory=source)
    _write_official_source(source, version="1.5.0")
    with pytest.raises(HTTPException, match="must not be older"):
        publisher.publish_directory(test_db, source_directory=source)

    plugin = test_db.get(Plugin, current.release.plugin_id)
    assert plugin.latest_release_id == current.release.id
    assert test_db.query(PluginRelease).count() == 1


def test_catalog_marks_manual_update_available(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=digest,
            sizeBytes=len(package),
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=initialized.submissionId
    )
    service.install(test_db, user_id=test_user.id, plugin_id=initialized.pluginId)

    release = PluginRelease(
        plugin_id=initialized.pluginId,
        version="1.1.0",
        manifest_json={"name": "gitlab-engineering", "version": "1.1.0"},
        interface_json={},
        storage_key="plugins/new.zip",
        sha256="1" * 64,
        size_bytes=100,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {}},
        published_at=datetime.now(),
    )
    test_db.add(release)
    test_db.flush()
    plugin = test_db.get(Plugin, initialized.pluginId)
    plugin.latest_release_id = release.id
    test_db.commit()

    item = service.list_plugins(test_db, user_id=test_user.id).items[0]
    assert item.version == "1.1.0"
    assert item.updateAvailable is True


def _create_auto_update_install(
    db: Session,
    *,
    user_id: int,
    index: int,
    current_version: str = "1.0.0",
    latest_version: str = "2.0.0",
) -> tuple[Kind, Plugin, PluginRelease, PluginRelease]:
    service = PluginMarketplaceService()
    slug = f"auto-update-{index}"
    plugin = Plugin(
        slug=slug,
        name=slug,
        display_name=f"Auto Update {index}",
        summary="Automatic update fixture",
        listing_type="plugin",
        source_type="native",
        source_provider="wework",
        owner_user_id=0,
        keywords_json=[],
        interface_json={},
        visibility="workspace",
        status="published",
    )
    db.add(plugin)
    db.flush()
    current = PluginRelease(
        plugin_id=plugin.id,
        version=current_version,
        manifest_json={"name": slug, "version": current_version},
        interface_json={},
        storage_key=f"plugins/{slug}-{current_version}.zip",
        sha256=f"{index % 16:x}" * 64,
        size_bytes=100,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {"skills": []}},
        published_at=datetime.now(),
    )
    latest = PluginRelease(
        plugin_id=plugin.id,
        version=latest_version,
        manifest_json={"name": slug, "version": latest_version},
        interface_json={},
        storage_key=f"plugins/{slug}-{latest_version}.zip",
        sha256=f"{(index + 1) % 16:x}" * 64,
        size_bytes=200,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {"skills": []}},
        published_at=datetime.now(),
    )
    db.add_all([current, latest])
    db.flush()
    plugin.latest_release_id = latest.id
    payload = service._installed_payload(plugin, current)
    payload["spec"]["updatePolicy"] = "auto"
    payload["spec"]["enabled"] = False
    payload["spec"]["componentStates"] = {"skills:review": False}
    installed = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        name=slug,
        namespace="default",
        json=payload,
        is_active=True,
    )
    db.add(installed)
    db.flush()
    return installed, plugin, current, latest


@pytest.mark.parametrize(
    ("install_count", "expected_batches"),
    [(0, 0), (1, 1), (5, 1), (6, 2), (12, 3)],
)
def test_auto_update_batches_are_bounded_and_drain_all_candidates(
    test_db, test_user, install_count, expected_batches
):
    service = PluginMarketplaceService()
    installs = [
        _create_auto_update_install(
            test_db,
            user_id=test_user.id,
            index=index + 1,
        )
        for index in range(install_count)
    ]
    test_db.commit()

    batch_sizes: list[int] = []
    while True:
        result = service.auto_update_batch(test_db, user_id=test_user.id)
        if result.updatedCount == 0:
            break
        batch_sizes.append(result.updatedCount)
        if result.remainingCount == 0:
            break

    assert len(batch_sizes) == expected_batches
    assert all(size <= 5 for size in batch_sizes)
    assert sum(batch_sizes) == install_count
    for installed, _, _, latest in installs:
        test_db.refresh(installed)
        assert installed.json["spec"]["releaseId"] == latest.id
        assert installed.json["spec"]["version"] == "2.0.0"
        assert installed.json["spec"]["updatePolicy"] == "auto"
        assert installed.json["spec"]["enabled"] is False
        assert installed.json["spec"]["componentStates"] == {"skills:review": False}


def test_auto_update_is_idempotent_and_excludes_invalid_installations(
    test_db, test_user
):
    service = PluginMarketplaceService()
    valid, _, _, latest = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=1,
    )
    invalid_scan, _, _, invalid_latest = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=2,
    )
    invalid_latest.scan_status = "pending"
    invalid_source, _, _, _ = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=3,
    )
    invalid_source.json["spec"]["source"]["type"] = "upload"
    flag_modified(invalid_source, "json")
    invalid_catalog, _, _, _ = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=4,
    )
    invalid_catalog.json["spec"]["releaseId"] = 999999
    flag_modified(invalid_catalog, "json")
    inaccessible, inaccessible_plugin, _, _ = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=5,
    )
    inaccessible_plugin.visibility = "personal"
    inaccessible_plugin.owner_user_id = test_user.id + 1000
    test_db.commit()

    first = service.auto_update_batch(test_db, user_id=test_user.id)
    second = service.auto_update_batch(test_db, user_id=test_user.id)

    assert first.updatedCount == 1
    assert first.updated[0].installedPluginId == valid.id
    assert first.updated[0].toReleaseId == latest.id
    assert first.remainingCount == 0
    assert second.updatedCount == 0
    assert second.remainingCount == 0
    for excluded in (
        invalid_scan,
        invalid_source,
        invalid_catalog,
        inaccessible,
    ):
        test_db.refresh(excluded)
        assert excluded.json["spec"]["version"] == "1.0.0"


def test_auto_update_excludes_manual_policy_and_manual_update_preserves_it(
    test_db, test_user
):
    service = PluginMarketplaceService()
    installed, _, _, latest = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=1,
    )
    installed.json["spec"]["updatePolicy"] = "manual"
    flag_modified(installed, "json")
    test_db.commit()

    result = service.auto_update_batch(test_db, user_id=test_user.id)

    assert result.updatedCount == 0
    assert result.remainingCount == 0
    updated = service.update_release(
        test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        release_id=latest.id,
    )
    assert updated.spec.releaseId == latest.id
    assert updated.spec.updatePolicy == "manual"


def test_installed_plugin_update_policy_requires_explicit_opt_in(test_db, test_user):
    marketplace_service = PluginMarketplaceService()
    installed, _, _, latest = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=1,
    )
    installed.json["spec"]["updatePolicy"] = "manual"
    flag_modified(installed, "json")
    test_db.commit()

    opted_in = installed_plugin_service.update_installed_plugin(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        request=InstalledPluginUpdateRequest(updatePolicy="auto"),
    )
    result = marketplace_service.auto_update_batch(test_db, user_id=test_user.id)

    assert opted_in.spec.updatePolicy == "auto"
    assert result.updatedCount == 1
    test_db.refresh(installed)
    assert installed.json["spec"]["releaseId"] == latest.id

    opted_out = installed_plugin_service.update_installed_plugin(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        request=InstalledPluginUpdateRequest(updatePolicy="manual"),
    )
    assert opted_out.spec.updatePolicy == "manual"


def test_non_marketplace_plugin_can_disable_but_not_enable_auto_updates(
    test_db, test_user
):
    installed, _ = _device_install(test_db, test_user.id)
    installed.json = {
        **installed.json,
        "spec": {
            **installed.json["spec"],
            "source": {
                "type": "local",
                "providerKey": "personal",
                "pluginKey": "device-state",
            },
            "displayName": "Device State",
        },
    }
    flag_modified(installed, "json")
    test_db.commit()

    opted_out = installed_plugin_service.update_installed_plugin(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        request=InstalledPluginUpdateRequest(updatePolicy="manual"),
    )

    assert opted_out.spec.updatePolicy == "manual"
    with pytest.raises(HTTPException, match="Automatic updates require"):
        installed_plugin_service.update_installed_plugin(
            db=test_db,
            user_id=test_user.id,
            installed_id=installed.id,
            request=InstalledPluginUpdateRequest(updatePolicy="auto"),
        )


@pytest.mark.parametrize(
    ("package_factory", "error"),
    [
        (_plugin_zip_with_sensitive_file, "Sensitive file"),
        (_plugin_zip_with_symlink, "Symbolic links"),
        (_plugin_zip_with_duplicate_path, "Duplicate path"),
        (_plugin_zip_with_encrypted_member, "Encrypted files"),
    ],
)
def test_submission_rejects_unsafe_files(
    test_db, test_user, monkeypatch, package_factory, error
):
    service = PluginMarketplaceService()
    package = package_factory()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="unsafe-plugin",
            displayName="Unsafe Plugin",
            version="1.0.0",
            filename="unsafe.zip",
            sha256=digest,
            sizeBytes=len(package),
        ),
    )

    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    with pytest.raises(HTTPException, match=error):
        service.complete_submission(
            test_db,
            user_id=test_user.id,
            submission_id=initialized.submissionId,
        )

    submission = service.get_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    release = test_db.get(PluginRelease, initialized.releaseId)
    assert submission.status == "rejected"
    assert release.scan_status == "failed"


def test_ready_release_package_metadata_is_immutable(test_db):
    plugin = Plugin(
        slug="immutable",
        name="immutable",
        display_name="Immutable",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={"name": "immutable", "version": "1.0.0"},
        interface_json={},
        storage_key="plugins/immutable.zip",
        sha256="a" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.commit()

    release.version = "2.0.0"
    with pytest.raises(ValueError, match="immutable"):
        test_db.commit()
    test_db.rollback()


def test_legacy_marketplace_submission_never_enters_catalog(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    with pytest.raises(HTTPException) as exc_info:
        service.init_submission(
            test_db,
            user_id=test_user.id,
            request=PluginSubmissionInitRequest(
                slug="rejected-plugin",
                displayName="Rejected Plugin",
                version="1.0.0",
                filename="rejected.zip",
                sha256=digest,
                sizeBytes=len(package),
                purpose="marketplace_publish",
            ),
        )

    assert exc_info.value.status_code == 422
    assert service.list_plugins(test_db, user_id=test_user.id).items == []
    assert test_db.query(PluginRelease).count() == 0


def test_plugin_visibility_requires_an_approved_grant(test_db, test_user):
    plugin = Plugin(
        slug="restricted",
        name="restricted",
        display_name="Restricted",
        keywords_json=[],
        interface_json={},
        visibility="workspace",
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={"name": "restricted", "version": "1.0.0"},
        interface_json={},
        storage_key="plugins/restricted.zip",
        sha256="b" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.add(
        ResourceMember.create(
            resource_type="Plugin",
            resource_id=plugin.id,
            entity_type="user",
            entity_id="999999",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    service = PluginMarketplaceService()

    assert service.list_plugins(test_db, user_id=test_user.id).items == []

    test_db.add(
        ResourceMember.create(
            resource_type="Plugin",
            resource_id=plugin.id,
            entity_type="user",
            entity_id=str(test_user.id),
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    assert [
        item.id for item in service.list_plugins(test_db, user_id=test_user.id).items
    ] == [plugin.id]


def test_list_plugins_batches_grant_lookups_instead_of_per_plugin_queries(
    test_db: Session, test_user: User
) -> None:
    owner = User(
        user_name="other-plugin-owner",
        password_hash=test_user.password_hash,
        email="other-plugin-owner@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(owner)
    test_db.flush()
    for index in range(12):
        plugin = Plugin(
            slug=f"personal-{index}",
            name=f"personal-{index}",
            display_name=f"Personal {index}",
            keywords_json=[],
            interface_json={},
            visibility="personal",
            status="published",
            owner_user_id=owner.id,
        )
        test_db.add(plugin)
        test_db.flush()
        release = PluginRelease(
            plugin_id=plugin.id,
            version="1.0.0",
            manifest_json={"name": plugin.name, "version": "1.0.0"},
            interface_json={},
            storage_key=f"plugins/{plugin.slug}.zip",
            sha256=f"{index:064d}",
            size_bytes=10,
            status="ready",
            scan_status="passed",
            scan_report_json={},
        )
        test_db.add(release)
        test_db.flush()
        plugin.latest_release_id = release.id
        test_db.add(
            ResourceMember.create(
                resource_type="Plugin",
                resource_id=plugin.id,
                entity_type="user",
                entity_id=str(owner.id),
                status=MemberStatus.APPROVED.value,
            )
        )
    test_db.commit()

    statements: list[str] = []

    def before_cursor_execute(
        _conn: object,
        _cursor: object,
        statement: str | bytes,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(str(statement))

    bind = test_db.get_bind()
    from sqlalchemy import event

    event.listen(bind, "before_cursor_execute", before_cursor_execute)
    try:
        service = PluginMarketplaceService()
        items = service.list_plugins(test_db, user_id=test_user.id).items
    finally:
        event.remove(bind, "before_cursor_execute", before_cursor_execute)

    assert items == []
    plugin_grant_lookups = [
        statement
        for statement in statements
        if "resource_members" in statement.lower()
        and "resource_id" in statement.lower()
    ]
    # One batched grants query, plus at most one user-namespace membership query.
    assert len(plugin_grant_lookups) <= 2


def test_restricted_submission_is_owner_only_until_access_is_granted(
    test_db, test_user, monkeypatch
):
    release_notifier = Mock(return_value=1)
    service = PluginMarketplaceService(release_notifier=release_notifier)
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    recipient = User(
        user_name="plugin-recipient",
        password_hash=test_user.password_hash,
        email="plugin-recipient@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(recipient)
    test_db.commit()

    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=digest,
            sizeBytes=len(package),
            purpose="restricted_share",
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    completed = service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )

    plugin = test_db.get(Plugin, initialized.pluginId)
    release = test_db.get(PluginRelease, initialized.releaseId)
    assert completed.status == "approved"
    assert completed.purpose == "restricted_share"
    assert plugin.visibility == "personal"
    assert plugin.status == "published"
    assert release.status == "ready"
    release_notifier.assert_called_once_with(test_db, initialized.releaseId)
    assert [
        item.id for item in service.list_plugins(test_db, user_id=test_user.id).items
    ] == [plugin.id]
    assert service.list_plugins(test_db, user_id=recipient.id).items == []

    access, revoked = service.update_plugin_access(
        test_db,
        plugin_id=plugin.id,
        user_id=test_user.id,
        request=PluginAccessUpdateRequest(
            scope="restricted",
            targets=[
                PluginAccessTarget(
                    entityType="user",
                    entityId=str(recipient.id),
                    displayName="forged display name",
                )
            ],
            allowCopy=True,
        ),
    )

    assert revoked == []
    assert access.scope == "restricted"
    assert access.allowCopy is True
    assert access.targets[0].displayName == recipient.user_name
    shared = service.list_plugins(test_db, user_id=recipient.id).items
    assert [item.id for item in shared] == [plugin.id]
    assert shared[0].accessRole == "recipient"
    assert shared[0].allowCopy is True


def test_restricted_access_replacement_revokes_original_install_and_copy(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    recipient = User(
        user_name="copy-recipient",
        password_hash=test_user.password_hash,
        email="copy-recipient@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(recipient)
    test_db.commit()
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=digest,
            sizeBytes=len(package),
            purpose="restricted_share",
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=initialized.submissionId
    )
    service.update_plugin_access(
        test_db,
        plugin_id=initialized.pluginId,
        user_id=test_user.id,
        request=PluginAccessUpdateRequest(
            scope="restricted",
            targets=[
                PluginAccessTarget(
                    entityType="user",
                    entityId=str(recipient.id),
                )
            ],
            allowCopy=True,
        ),
    )
    installed = service.install(
        test_db, user_id=recipient.id, plugin_id=initialized.pluginId
    )
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (f"https://objects.example/{key}", datetime.now(timezone.utc)),
    )

    copy = service.plugin_copy_descriptor(
        test_db, plugin_id=initialized.pluginId, user_id=recipient.id
    )
    assert copy.sourcePluginId == initialized.pluginId
    assert copy.sha256 == digest

    access, revoked = service.update_plugin_access(
        test_db,
        plugin_id=initialized.pluginId,
        user_id=test_user.id,
        request=PluginAccessUpdateRequest(
            scope="private",
            targets=[],
            allowCopy=True,
        ),
    )
    installed_id = int(installed.metadata["labels"]["id"])
    assert access.scope == "private"
    assert access.allowCopy is False
    assert revoked == [(recipient.id, installed_id)]
    assert service.list_plugins(test_db, user_id=recipient.id).items == []
    test_db.expire_all()
    revoked_install = test_db.get(Kind, installed_id)
    assert revoked_install.is_active is False
    assert revoked_install.json["spec"]["enabled"] is False
    assert revoked_install.json["spec"]["installState"] == "uninstalled"
    with pytest.raises(HTTPException) as exc_info:
        service.plugin_copy_descriptor(
            test_db, plugin_id=initialized.pluginId, user_id=recipient.id
        )
    assert exc_info.value.status_code == 404


def test_personal_plugin_delete_requires_impact_confirmation_and_revokes_usage(
    test_db, test_user
):
    recipient = User(
        user_name="delete-recipient",
        password_hash=test_user.password_hash,
        email="delete-recipient@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(recipient)
    test_db.flush()
    plugin = Plugin(
        slug="delete-me",
        name="delete-me",
        display_name="Delete Me",
        owner_user_id=test_user.id,
        keywords_json=[],
        interface_json={},
        visibility="personal",
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    installed = Kind(
        user_id=recipient.id,
        kind="InstalledPlugin",
        namespace="default",
        name="delete-me",
        json={
            "spec": {
                "pluginId": plugin.id,
                "enabled": True,
                "installState": "installed",
            }
        },
        is_active=True,
    )
    test_db.add(installed)
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember.create(
                resource_type="Plugin",
                resource_id=plugin.id,
                entity_type="user",
                entity_id=str(recipient.id),
                status=MemberStatus.APPROVED.value,
            ),
            PluginDeviceInstallation(
                installed_kind_id=installed.id,
                user_id=recipient.id,
                device_id="offline-device",
                state="installed",
            ),
        ]
    )
    test_db.commit()
    service = PluginMarketplaceService()

    impact = service.get_personal_plugin_delete_impact(
        test_db,
        plugin_id=plugin.id,
        user_id=test_user.id,
    )

    assert impact.affectedUserCount == 1
    assert impact.installedDeviceCount == 1
    assert impact.sharedTargetCount == 1
    with pytest.raises(HTTPException) as exc_info:
        service.delete_owned_personal_plugin(
            test_db,
            plugin_id=plugin.id,
            user_id=test_user.id,
            impact_revision=impact.impactRevision,
            revoke_and_delete=False,
        )
    assert exc_info.value.status_code == 409

    installations = service.delete_owned_personal_plugin(
        test_db,
        plugin_id=plugin.id,
        user_id=test_user.id,
        impact_revision=impact.impactRevision,
        revoke_and_delete=True,
    )

    assert installations == [(recipient.id, installed.id)]
    test_db.refresh(plugin)
    test_db.refresh(installed)
    assert plugin.status == "deleted"
    assert installed.is_active is False
    assert installed.json["spec"]["installState"] == "uninstalled"
    assert (
        test_db.query(ResourceMember)
        .filter(ResourceMember.resource_id == plugin.id)
        .count()
        == 0
    )


def test_personal_plugin_delete_rejects_stale_impact_revision(test_db, test_user):
    plugin = Plugin(
        slug="delete-revision",
        name="delete-revision",
        display_name="Delete Revision",
        owner_user_id=test_user.id,
        keywords_json=[],
        interface_json={},
        visibility="personal",
        status="published",
    )
    test_db.add(plugin)
    test_db.commit()
    service = PluginMarketplaceService()
    impact = service.get_personal_plugin_delete_impact(
        test_db,
        plugin_id=plugin.id,
        user_id=test_user.id,
    )
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="InstalledPlugin",
            namespace="default",
            name="delete-revision",
            json={"spec": {"pluginId": plugin.id}},
            is_active=True,
        )
    )
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        service.delete_owned_personal_plugin(
            test_db,
            plugin_id=plugin.id,
            user_id=test_user.id,
            impact_revision=impact.impactRevision,
            revoke_and_delete=True,
        )

    assert exc_info.value.status_code == 409
    test_db.refresh(plugin)
    assert plugin.status == "published"


def test_namespace_grant_includes_members_of_child_departments(test_db, test_user):
    service = PluginMarketplaceService()
    recipient = User(
        user_name="department-recipient",
        password_hash=test_user.password_hash,
        email="department-recipient@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(recipient)
    test_db.flush()
    parent = Namespace(
        name="product",
        display_name="Product",
        owner_user_id=test_user.id,
        is_active=True,
    )
    child = Namespace(
        name="product/design",
        display_name="Design",
        owner_user_id=test_user.id,
        is_active=True,
    )
    test_db.add_all([parent, child])
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="Namespace",
            resource_id=child.id,
            entity_type="user",
            entity_id=str(recipient.id),
            status=MemberStatus.APPROVED.value,
        )
    )
    plugin = Plugin(
        slug="department-plugin",
        name="department-plugin",
        display_name="Department Plugin",
        owner_user_id=test_user.id,
        keywords_json=[],
        interface_json={},
        visibility="personal",
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={"name": plugin.name, "version": "1.0.0"},
        interface_json={},
        storage_key="plugins/department.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.add(
        ResourceMember.create(
            resource_type="Plugin",
            resource_id=plugin.id,
            entity_type="namespace",
            entity_id=str(parent.id),
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()

    assert [
        item.id for item in service.list_plugins(test_db, user_id=recipient.id).items
    ] == [plugin.id]


def test_capability_payload_uses_signed_release_url(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    plugin = Plugin(
        slug="signed",
        name="signed",
        display_name="Signed",
        keywords_json=[],
        interface_json={},
        visibility="workspace",
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={"name": "signed", "version": "1.0.0"},
        interface_json={},
        storage_key="plugins/signed.zip",
        sha256="c" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.commit()
    service.install(test_db, user_id=test_user.id, plugin_id=plugin.id)
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (
            f"https://objects.example/{key}?signature=short-lived",
            datetime.now(),
        ),
    )

    payload = DeviceCapabilitySyncService().build_desired_capabilities(
        test_db, user_id=test_user.id
    )

    assert payload["plugins"][0]["download_path"].startswith(
        "https://objects.example/plugins/signed.zip"
    )
    assert payload["plugins"][0]["release_id"] == release.id


@pytest.mark.asyncio
async def test_all_devices_receive_pending_rows(test_db, test_user, monkeypatch):
    plugin = Plugin(
        slug="devices",
        name="devices",
        display_name="Devices",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/devices.zip",
        sha256="d" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    installed = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="devices",
        json={"spec": {"releaseId": release.id}},
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()

    async def devices(_db, _user_id):
        return [
            {"device_id": "online-device", "status": "online"},
            {"device_id": "offline-device", "status": "offline"},
        ]

    monkeypatch.setattr(
        "app.services.plugin_device_installation_service.device_service.get_all_devices",
        devices,
    )
    await PluginDeviceInstallationService().ensure_pending_for_all_devices(
        test_db,
        user_id=test_user.id,
        installed_kind_id=installed.id,
        desired_release_id=release.id,
    )

    rows = test_db.query(PluginDeviceInstallation).order_by(
        PluginDeviceInstallation.device_id
    )
    assert [(row.device_id, row.state) for row in rows] == [
        ("offline-device", "pending"),
        ("online-device", "pending"),
    ]


def test_device_sync_omitted_plugin_result_stays_pending(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    service = PluginDeviceInstallationService()

    service.record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="current-device",
            success=True,
            plugins=[],
        ),
    )

    row = test_db.query(PluginDeviceInstallation).one()
    assert row.installed_kind_id == installed.id
    assert row.desired_release_id == release.id
    assert row.actual_release_id == 0
    assert row.state == "pending"
    assert row.error_message == ""


def test_device_sync_omitted_result_keeps_confirmed_install(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    service = PluginDeviceInstallationService()
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="installed",
        )
    )
    test_db.commit()

    service.record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="current-device",
            success=True,
            plugins=[],
        ),
    )

    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "installed"
    assert row.actual_release_id == release.id
    assert row.desired_release_id == release.id


def test_ensure_pending_for_device_creates_and_resets_failed(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    service = PluginDeviceInstallationService()
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="new-device",
            desired_release_id=release.id,
            actual_release_id=0,
            state="failed",
            error_code="PLUGIN_SYNC_FAILED",
            error_message="Device response omitted plugin result",
        )
    )
    test_db.commit()

    changed = service.ensure_pending_for_device(
        test_db,
        user_id=test_user.id,
        device_id="new-device",
    )

    assert changed == 1
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.device_id == "new-device"
    assert row.state == "pending"
    assert row.error_message == ""
    assert row.desired_release_id == release.id


def test_auto_update_stops_after_three_failures_until_manual_retry(test_db, test_user):
    installed, old_release = _device_install(test_db, test_user.id)
    new_release = PluginRelease(
        plugin_id=old_release.plugin_id,
        version="2.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/device-state-2.0.0.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(new_release)
    test_db.flush()
    installed.json = {
        **installed.json,
        "spec": {**installed.json["spec"], "releaseId": new_release.id},
    }
    flag_modified(installed, "json")
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=new_release.id,
            actual_release_id=old_release.id,
            state="pending",
        )
    )
    test_db.commit()
    service = PluginDeviceInstallationService()
    failed_result = DeviceCapabilitySyncResult(
        device_id="current-device",
        success=False,
        error="download failed",
    )

    for expected_attempts in (1, 2, 3):
        service.record_device_sync_result(
            test_db,
            user_id=test_user.id,
            result=failed_result,
        )
        row = test_db.query(PluginDeviceInstallation).one()
        assert row.attempt_count == expected_attempts
        assert row.actual_release_id == old_release.id

    assert (
        service.ensure_pending_for_device(
            test_db,
            user_id=test_user.id,
            device_id="current-device",
        )
        == 0
    )
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "failed"

    assert (
        service.ensure_pending_for_device(
            test_db,
            user_id=test_user.id,
            device_id="current-device",
            manual_retry=True,
        )
        == 1
    )
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "pending"
    assert row.attempt_count == 0


def test_new_desired_release_resets_auto_update_failure_limit(test_db, test_user):
    installed, old_release = _device_install(test_db, test_user.id)
    new_release = PluginRelease(
        plugin_id=old_release.plugin_id,
        version="2.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/device-state-2.0.0.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(new_release)
    test_db.flush()
    installed.json = {
        **installed.json,
        "spec": {**installed.json["spec"], "releaseId": new_release.id},
    }
    flag_modified(installed, "json")
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=old_release.id,
            actual_release_id=old_release.id,
            state="failed",
            attempt_count=3,
        )
    )
    test_db.commit()

    changed = PluginDeviceInstallationService().ensure_pending_for_device(
        test_db,
        user_id=test_user.id,
        device_id="current-device",
    )

    row = test_db.query(PluginDeviceInstallation).one()
    assert changed == 1
    assert row.desired_release_id == new_release.id
    assert row.state == "pending"
    assert row.attempt_count == 0


def test_device_payload_preserves_old_release_after_auto_update_circuit_opens(
    test_db, test_user, monkeypatch
):
    installed, _, old_release, new_release = _create_auto_update_install(
        test_db,
        user_id=test_user.id,
        index=15,
    )
    test_db.commit()
    PluginMarketplaceService().auto_update_batch(test_db, user_id=test_user.id)
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=new_release.id,
            actual_release_id=old_release.id,
            state="failed",
            attempt_count=3,
        )
    )
    test_db.commit()
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (f"https://objects.example/{key}", datetime.now()),
    )

    payload = DeviceCapabilitySyncService().build_desired_capabilities(
        test_db,
        user_id=test_user.id,
        device_id="current-device",
    )

    plugin_payload = payload["plugins"][0]
    assert plugin_payload["release_id"] == old_release.id
    assert plugin_payload["version"] == old_release.version
    assert plugin_payload["checksum"] == f"sha256:{old_release.sha256}"
    assert plugin_payload["download_path"].endswith(old_release.storage_key)


def test_ensure_pending_for_device_skips_uninstalling_rows(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    service = PluginDeviceInstallationService()
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="new-device",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="uninstalling",
        )
    )
    test_db.commit()

    changed = service.ensure_pending_for_device(
        test_db,
        user_id=test_user.id,
        device_id="new-device",
    )

    assert changed == 0
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "uninstalling"
    assert row.actual_release_id == release.id


@pytest.mark.asyncio
async def test_sync_installed_plugins_to_device_materializes_account_install(
    test_db, test_user, monkeypatch
):
    from contextlib import contextmanager

    installed, release = _device_install(test_db, test_user.id)
    reconcile_calls: list[int] = []

    def reconcile(_db, *, user_id):
        reconcile_calls.append(user_id)

    async def sync_device_payload(*, user_id, device_id, payload, timeout_seconds=180):
        assert user_id == test_user.id
        assert device_id == "new-device"
        assert payload.get("plugins")
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            plugins=[DeviceCapabilityItemResult(id=str(installed.id), status="synced")],
        )

    @contextmanager
    def reuse_test_db():
        yield test_db

    monkeypatch.setattr(
        plugin_marketplace_service,
        "reconcile_stale_installed_catalog_refs",
        reconcile,
    )
    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_device_payload",
        sync_device_payload,
    )
    # Nested test transactions are connection-bound; reuse the fixture session.
    monkeypatch.setattr(test_db, "close", lambda: None)
    monkeypatch.setattr(
        "app.api.endpoints.installed_plugins.get_db_session",
        reuse_test_db,
    )

    response = await sync_installed_plugins_to_device(
        device_id="new-device",
        db=test_db,
        current_user=test_user,
    )

    assert reconcile_calls == [test_user.id]
    assert response.deviceId == "new-device"
    assert response.pendingCount >= 1
    assert response.sync.synced == 1
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.device_id == "new-device"
    assert row.state == "installed"
    assert row.actual_release_id == release.id


def test_report_installed_plugins_on_device_acks_without_pushing_packages(
    test_db, test_user, monkeypatch
):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=release.id,
            state="pending",
        )
    )
    test_db.commit()

    async def boom(**_kwargs):
        raise AssertionError("report-device must not dispatch capability sync")

    monkeypatch.setattr(device_capability_sync_service, "sync_device_payload", boom)

    response = report_installed_plugins_on_device(
        payload=PluginDeviceReportRequest(
            plugins=[
                PluginDeviceReportItem(
                    installedPluginId=installed.id,
                    releaseId=release.id,
                    version=release.version,
                )
            ]
        ),
        device_id="current-device",
        db=test_db,
        current_user=test_user,
    )

    assert response.deviceId == "current-device"
    assert response.acknowledgedCount == 1
    assert response.acknowledgedInstalledPluginIds == [installed.id]
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.device_id == "current-device"
    assert row.state == "installed"
    assert row.actual_release_id == release.id
    assert row.error_code == ""
    assert row.attempt_count == 0


def test_report_installed_plugins_on_device_rejects_stale_release_evidence(
    test_db, test_user
):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=release.id,
            state="pending",
        )
    )
    test_db.commit()

    response = report_installed_plugins_on_device(
        payload=PluginDeviceReportRequest(
            plugins=[
                PluginDeviceReportItem(
                    installedPluginId=installed.id,
                    releaseId=release.id + 100,
                    version=release.version,
                )
            ]
        ),
        device_id="current-device",
        db=test_db,
        current_user=test_user,
    )

    assert response.acknowledgedCount == 0
    assert response.acknowledgedInstalledPluginIds == []
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "pending"
    assert row.actual_release_id == 0


def test_device_sync_keeps_disabled_plugin_materialized(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    installed.json["spec"]["enabled"] = False
    test_db.commit()

    PluginDeviceInstallationService().record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="current-device",
            success=True,
            plugins=[DeviceCapabilityItemResult(id=str(installed.id), status="synced")],
        ),
    )

    row = test_db.query(PluginDeviceInstallation).one()
    assert row.installed_kind_id == installed.id
    assert row.desired_release_id == release.id
    assert row.actual_release_id == release.id
    assert row.state == "installed"


def test_catalog_uses_current_device_materialization_state(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    PluginDeviceInstallationService().record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="current-device",
            success=True,
            plugins=[],
        ),
    )

    item = (
        PluginMarketplaceService()
        .list_plugins(
            test_db,
            user_id=test_user.id,
            device_id="current-device",
        )
        .items[0]
    )

    assert item.installed is False
    assert item.installedPluginId == installed.id
    assert item.latestReleaseId == release.id
    assert item.currentDeviceInstallation is not None
    assert item.currentDeviceInstallation.state == "pending"
    assert not item.currentDeviceInstallation.errorMessage


def test_catalog_keeps_older_materialized_release_installed(test_db, test_user):
    installed, old_release = _device_install(test_db, test_user.id)
    new_release = PluginRelease(
        plugin_id=old_release.plugin_id,
        version="1.1.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/device-state-1.1.0.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(new_release)
    test_db.flush()
    plugin = test_db.get(Plugin, old_release.plugin_id)
    plugin.latest_release_id = new_release.id
    service = PluginMarketplaceService()
    installed.json = service._installed_payload(plugin, new_release)
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=new_release.id,
            actual_release_id=old_release.id,
            state="failed",
            error_code="PLUGIN_SYNC_FAILED",
            error_message="Update failed",
        )
    )
    test_db.commit()

    item = service.list_plugins(
        test_db,
        user_id=test_user.id,
        device_id="current-device",
    ).items[0]

    assert item.installed is True
    assert item.updateAvailable is True
    assert item.currentDeviceInstallation is not None
    assert item.currentDeviceInstallation.actualReleaseId == old_release.id
    installed_item = service.enrich_installed_list(
        test_db,
        installed_plugin_service.list_installed_plugins(
            db=test_db,
            user_id=test_user.id,
        ),
        device_id="current-device",
    ).items[0]
    assert installed_item.spec.installState == "update_available"


def test_reset_failed_update_preserves_materialized_release(test_db, test_user):
    installed, old_release = _device_install(test_db, test_user.id)
    new_release = PluginRelease(
        plugin_id=old_release.plugin_id,
        version="1.1.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/device-state-1.1.0.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(new_release)
    test_db.flush()
    installed.json = {
        **installed.json,
        "spec": {**installed.json["spec"], "releaseId": new_release.id},
    }
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=new_release.id,
            actual_release_id=old_release.id,
            state="failed",
        )
    )
    test_db.commit()

    changed = PluginDeviceInstallationService().ensure_pending_for_device(
        test_db,
        user_id=test_user.id,
        device_id="current-device",
        manual_retry=True,
    )

    row = test_db.query(PluginDeviceInstallation).one()
    assert changed == 1
    assert row.state == "pending"
    assert row.actual_release_id == old_release.id


@pytest.mark.asyncio
async def test_plugin_mutation_only_fails_for_the_required_device(
    test_db, test_user, monkeypatch
):
    response = DeviceCapabilitySyncResponse(
        failed=1,
        synced=1,
        results=[
            DeviceCapabilitySyncResult(
                device_id="current-device",
                success=True,
            ),
            DeviceCapabilitySyncResult(
                device_id="other-device",
                success=False,
                error="offline",
            ),
        ],
    )

    async def sync(*_args, **_kwargs):
        return response

    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_user_global_capabilities",
        sync,
    )

    result = await _sync_global_capabilities(
        test_db,
        test_user.id,
        required_device_id="current-device",
    )
    assert result is response

    with pytest.raises(HTTPException) as exc_info:
        await _sync_global_capabilities(
            test_db,
            test_user.id,
            required_device_id="other-device",
        )
    assert exc_info.value.status_code == 502


@pytest.mark.asyncio
async def test_plugin_mutation_requires_the_current_plugin_result(
    test_db, test_user, monkeypatch
):
    installed, _release = _device_install(test_db, test_user.id)
    response = DeviceCapabilitySyncResponse(
        synced=1,
        results=[
            DeviceCapabilitySyncResult(
                device_id="current-device",
                success=True,
                plugins=[],
            )
        ],
    )

    async def sync(*_args, **_kwargs):
        return response

    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_user_global_capabilities",
        sync,
    )

    with pytest.raises(HTTPException) as exc_info:
        await _sync_global_capabilities(
            test_db,
            test_user.id,
            required_device_id="current-device",
            required_installed_kind_id=installed.id,
            expect_installed=True,
        )
    assert exc_info.value.status_code == 502

    row = test_db.query(PluginDeviceInstallation).one()
    assert row.state == "pending"
    assert row.error_message == ""


@pytest.mark.asyncio
async def test_install_returns_plugin_when_device_sync_fails(
    test_db, test_user, monkeypatch
):
    plugin = Plugin(
        slug="soft-install",
        name="soft-install",
        display_name="Soft Install",
        keywords_json=[],
        interface_json={},
        status="published",
        visibility="workspace",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/soft-install.zip",
        sha256="f" * 64,
        size_bytes=10,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {"skills": [], "commands": []}},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.commit()

    async def sync(*_args, **_kwargs):
        return DeviceCapabilitySyncResponse(
            failed=1,
            synced=0,
            results=[
                DeviceCapabilitySyncResult(
                    device_id="current-device",
                    success=False,
                    error="device rejected sync",
                )
            ],
        )

    async def merge_sync(*_args, **_kwargs):
        raise DeviceCapabilitySyncError("merge also failed")

    async def ensure_pending(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_user_global_capabilities",
        sync,
    )
    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_installed_plugin_to_device",
        merge_sync,
    )
    monkeypatch.setattr(
        plugin_device_installation_service,
        "ensure_pending_for_all_devices",
        ensure_pending,
    )

    response = await install_marketplace_plugin(
        marketplace_id=plugin.id,
        release_id=None,
        device_id="current-device",
        db=test_db,
        current_user=test_user,
    )
    assert response.plugin is not None
    assert response.plugin.spec.pluginId == plugin.id
    assert response.sync is not None
    assert response.sync.failed == 1
    assert (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "InstalledPlugin",
            Kind.is_active.is_(True),
        )
        .count()
        == 1
    )


@pytest.mark.asyncio
async def test_uninstall_succeeds_when_device_sync_fails(
    test_db, test_user, monkeypatch
):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="current-device",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="installed",
        )
    )
    test_db.commit()

    async def sync(*_args, **_kwargs):
        return DeviceCapabilitySyncResponse(
            failed=1,
            synced=0,
            results=[
                DeviceCapabilitySyncResult(
                    device_id="current-device",
                    success=False,
                    error="device rejected sync",
                )
            ],
        )

    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_user_global_capabilities",
        sync,
    )

    await uninstall_installed_plugin(
        installed_id=installed.id,
        device_id="current-device",
        db=test_db,
        current_user=test_user,
    )

    test_db.refresh(installed)
    assert installed.is_active is False
    assert installed.json["spec"]["installState"] == "uninstalled"
    assert test_db.query(PluginDeviceInstallation).count() == 0

    item = (
        PluginMarketplaceService()
        .list_plugins(
            test_db,
            user_id=test_user.id,
            device_id="current-device",
        )
        .items[0]
    )
    assert item.installed is False
    assert item.installedPluginId is None


@pytest.mark.asyncio
async def test_uninstall_is_idempotent_for_inactive_kind(
    test_db, test_user, monkeypatch
):
    installed, _release = _device_install(test_db, test_user.id)
    installed.is_active = False
    installed.json["spec"]["installState"] = "uninstalled"
    installed.json["spec"]["enabled"] = False
    test_db.commit()

    async def sync(*_args, **_kwargs):
        return DeviceCapabilitySyncResponse(synced=0, results=[])

    monkeypatch.setattr(
        device_capability_sync_service,
        "sync_user_global_capabilities",
        sync,
    )

    await uninstall_installed_plugin(
        installed_id=installed.id,
        device_id="current-device",
        db=test_db,
        current_user=test_user,
    )
    assert installed.is_active is False


def test_reconnect_sync_clears_materialized_uninstall_state(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    installed.is_active = False
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=installed.id,
            user_id=test_user.id,
            device_id="offline-device",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="uninstalling",
        )
    )
    test_db.commit()

    PluginDeviceInstallationService().record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="offline-device",
            success=True,
            plugins=[],
        ),
    )

    assert test_db.query(PluginDeviceInstallation).count() == 0


def test_upstream_sync_is_incremental_and_records_failure(test_db, monkeypatch):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda _url: None,
    )
    release_notifier = Mock(return_value=1)
    service = PluginMarketplaceService(release_notifier=release_notifier)
    package = _plugin_zip("2.0.0")
    stored_packages: dict[str, bytes] = {}
    upstream = service.create_upstream(
        test_db,
        request=PluginUpstreamCreateRequest(
            slug="gitlab-upstream",
            displayName="GitLab Upstream",
            marketplaceName="openai-bundled",
            remotePluginId="gitlab-engineering",
            upstreamUrl="https://example.com/gitlab.zip",
        ),
    )

    class Response:
        content = package

        def raise_for_status(self):
            return None

    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: package,
    )
    _mock_package_storage(monkeypatch, stored_packages)

    first = service.sync_upstream(test_db, upstream_id=upstream.id)
    second = service.sync_upstream(test_db, upstream_id=upstream.id)

    assert first.lastSeenVersion == "2.0.0"
    assert second.lastError is None
    release_notifier.assert_called_once()
    assert (
        test_db.query(PluginRelease)
        .filter(PluginRelease.plugin_id == upstream.pluginId)
        .count()
        == 1
    )

    latest_release_id = test_db.get(Plugin, upstream.pluginId).latest_release_id
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _plugin_zip("1.5.0"),
    )
    downgraded = service.sync_upstream(test_db, upstream_id=upstream.id)
    assert downgraded.lastSeenVersion == "1.5.0"
    release_notifier.assert_called_once()
    assert test_db.get(Plugin, upstream.pluginId).latest_release_id == latest_release_id
    assert (
        test_db.query(PluginRelease)
        .filter(PluginRelease.plugin_id == upstream.pluginId)
        .count()
        == 1
    )

    def fail(url: str):
        raise RuntimeError("upstream unavailable")

    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package", fail
    )
    with pytest.raises(RuntimeError, match="upstream unavailable"):
        service.sync_upstream(test_db, upstream_id=upstream.id)
    assert test_db.get(PluginUpstream, upstream.id).last_error == "upstream unavailable"


def test_upstream_archive_is_scanned_before_plugin_package_selection(
    test_db, monkeypatch
):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda _url: None,
    )
    service = PluginMarketplaceService()
    package = _plugin_zip("2.0.0")
    stored_packages: dict[str, bytes] = {}
    upstream = service.create_upstream(
        test_db,
        request=PluginUpstreamCreateRequest(
            slug="scan-before-select",
            displayName="Scan Before Select",
            marketplaceName="openai-bundled",
            remotePluginId="gitlab-engineering",
            upstreamUrl="https://example.com/plugins.zip",
        ),
    )
    calls: list[str] = []

    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda _url: package,
    )
    monkeypatch.setattr(
        service,
        "_scan_package",
        lambda _package: calls.append("scan") or {},
    )
    monkeypatch.setattr(
        service,
        "_select_upstream_plugin_package",
        lambda selected, _remote_id: calls.append("select") or selected,
    )
    _mock_package_storage(monkeypatch, stored_packages)

    service.sync_upstream(test_db, upstream_id=upstream.id)

    assert calls[:2] == ["scan", "select"]


def test_marketplace_interface_cache_evicts_least_recently_used_entry(
    monkeypatch,
):
    service = PluginMarketplaceService()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.MAX_RESOLVED_INTERFACE_CACHE_ENTRIES",
        2,
    )
    monkeypatch.setattr(plugin_package_storage, "get", lambda key: key.encode())
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.plugin_package_parser.resolve_interface_assets",
        lambda package, _interface: {"resolved": package.decode()},
    )

    def release(key: str) -> PluginRelease:
        return PluginRelease(
            plugin_id=1,
            version="1.0.0",
            manifest_json={},
            interface_json={"logo": "./assets/logo.png"},
            storage_key=key,
            sha256=key,
            size_bytes=1,
            status="ready",
            scan_status="passed",
            scan_report_json={},
        )

    plugin = Plugin(
        slug="cache-test",
        name="cache-test",
        display_name="Cache Test",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    first = release("first")
    second = release("second")
    third = release("third")

    service._marketplace_interface(first, plugin)
    service._marketplace_interface(second, plugin)
    service._marketplace_interface(first, plugin)
    service._marketplace_interface(third, plugin)

    assert list(service._resolved_interface_cache) == ["first", "third"]


def test_upstream_content_digest_ignores_python_formatting_only_changes():
    service = PluginMarketplaceService()

    def package(source: str) -> bytes:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("scripts/check.py", source)
        return output.getvalue()

    compact = package("result = call(1, 2, 3)\n")
    wrapped = package("result = call(\n    1,\n    2,\n    3,\n)\n")

    assert service._package_tree_digest(
        compact, ignored_paths=set()
    ) == service._package_tree_digest(wrapped, ignored_paths=set())


def test_admin_upstream_policy_defaults_to_auto_and_can_require_review(
    test_db, monkeypatch
):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    service = PluginMarketplaceService()
    upstream = service.create_upstream(
        test_db,
        request=PluginUpstreamCreateRequest(
            slug="gitlab",
            displayName="GitLab",
            marketplaceName="example/plugins",
            remotePluginId="gitlab",
            upstreamUrl="https://example.com/plugins.zip",
        ),
    )

    assert upstream.syncPolicy == "auto_after_scan"

    updated = service.update_upstream_policy(
        test_db,
        upstream_id=upstream.id,
        sync_policy="review_required",
    )

    assert updated.syncPolicy == "review_required"
    assert test_db.get(PluginUpstream, upstream.id).sync_policy == "review_required"


def test_configure_controlled_upstream_creates_missing_plugin(test_db, monkeypatch):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    service = PluginMarketplaceService()

    first = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )
    second = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )

    plugin = test_db.get(Plugin, first.pluginId)
    assert plugin is not None
    assert plugin.status == "draft"
    assert plugin.visibility == "public"
    assert plugin.source_type == "mirror"
    assert plugin.source_provider == "wework"
    assert first.id == second.id
    assert first.syncEnabled is True
    assert first.syncPolicy == "review_required"
    assert test_db.query(Plugin).count() == 1
    assert test_db.query(PluginUpstream).count() == 1


def test_configure_controlled_upstream_converts_existing_official_plugin(
    test_db, monkeypatch
):
    plugin = Plugin(
        slug="github",
        name="github",
        display_name="Legacy GitHub",
        source_type="native",
        source_provider="wework",
        keywords_json=[],
        interface_json={},
        visibility="workspace",
        status="published",
    )
    test_db.add(plugin)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    service = PluginMarketplaceService()

    first = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )
    second = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )

    test_db.refresh(plugin)
    assert plugin.source_type == "native"
    assert plugin.visibility == "workspace"
    official = test_db.get(Plugin, first.pluginId)
    assert official.id != plugin.id
    assert official.catalog_namespace == "wework-official"
    assert official.source_type == "mirror"
    assert official.source_provider == "wework"
    assert official.display_name == "GitHub"
    assert official.visibility == "public"
    assert first.id == second.id
    assert first.syncEnabled is True
    assert first.syncPolicy == "review_required"
    assert test_db.query(PluginUpstream).count() == 1
    assert test_db.get(PluginUpstream, first.id).sync_policy == "review_required"


def test_configure_controlled_upstream_reclassifies_legacy_codex_mirror(
    test_db, monkeypatch
):
    plugin = Plugin(
        catalog_namespace="wework-official",
        slug="github",
        name="github",
        display_name="GitHub",
        source_type="mirror",
        source_provider="codex",
        keywords_json=[],
        interface_json={},
        visibility="public",
        status="published",
    )
    test_db.add(plugin)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )

    PluginMarketplaceService().configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="auto_after_scan",
    )

    test_db.refresh(plugin)
    assert plugin.source_type == "mirror"
    assert plugin.source_provider == "wework"
    assert plugin.visibility == "public"


@pytest.mark.parametrize(
    ("owner_user_id", "source_type", "source_provider"),
    [
        (7, "submission", "user"),
        (None, "native", "other"),
    ],
)
def test_configure_controlled_upstream_rejects_uncontrolled_slug(
    test_db, monkeypatch, owner_user_id, source_type, source_provider
):
    plugin = Plugin(
        slug="github",
        name="github",
        display_name="GitHub",
        source_type=source_type,
        source_provider=source_provider,
        owner_user_id=owner_user_id,
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )

    with pytest.raises(HTTPException, match="different publisher") as exc_info:
        PluginMarketplaceService().configure_controlled_upstream(
            test_db,
            slug="github",
            display_name="GitHub",
            marketplace_name="openai/plugins",
            remote_plugin_id="github",
            upstream_url="https://github.com/openai/plugins/archive/main.zip",
            license_info="Bundled licenses",
            sync_policy="review_required",
        )

    assert exc_info.value.status_code == 409
    assert test_db.query(PluginUpstream).count() == 0


def test_configure_controlled_upstream_rejects_listing_type_change(
    test_db, monkeypatch
):
    plugin = Plugin(
        slug="github",
        name="github",
        display_name="GitHub",
        listing_type="skill",
        source_type="mirror",
        source_provider="codex",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )

    with pytest.raises(
        HTTPException, match="listing type cannot be changed"
    ) as exc_info:
        PluginMarketplaceService().configure_controlled_upstream(
            test_db,
            slug="github",
            display_name="GitHub",
            marketplace_name="openai/plugins",
            remote_plugin_id="github",
            upstream_url="https://github.com/openai/plugins/archive/main.zip",
            license_info="Bundled licenses",
            sync_policy="review_required",
        )

    assert exc_info.value.status_code == 409
    assert test_db.query(PluginUpstream).count() == 0


def test_openai_github_upstream_sync_passes_through_official_package(
    test_db, monkeypatch
):
    service = PluginMarketplaceService()
    stored_packages: dict[str, bytes] = {}
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    upstream = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _github_upstream_zip(),
    )
    _mock_package_storage(monkeypatch, stored_packages)

    result = service.sync_upstream(test_db, upstream_id=upstream.id)

    assert result.lastSeenVersion == "0.1.6"
    plugin = test_db.get(Plugin, upstream.pluginId)
    assert plugin.latest_release_id == 0
    release = (
        test_db.query(PluginRelease).filter(PluginRelease.plugin_id == plugin.id).one()
    )
    submission = (
        test_db.query(PluginSubmission)
        .filter(PluginSubmission.release_id == release.id)
        .one()
    )
    assert release.status == "processing"
    assert submission.status == "pending"
    assert release.version == "0.1.6"
    provenance = release.scan_report_json["provenance"]
    assert provenance["kind"] == "upstream"
    assert "adapter" not in provenance
    with zipfile.ZipFile(io.BytesIO(stored_packages[release.storage_key])) as archive:
        manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        assert manifest["apps"] == ["app_123"]
        assert manifest["mcpServers"] == {"github": {"command": "legacy"}}
        assert "connectors" not in manifest
        assert ".mcp.json" in archive.namelist()
        assert ".app.json" in archive.namelist()

    service.sync_upstream(test_db, upstream_id=upstream.id)
    assert test_db.query(PluginRelease).count() == 1

    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _github_upstream_zip(skill_body="# Changed without a bump"),
    )
    with pytest.raises(ValueError, match="changed content without a version bump"):
        service.sync_upstream(test_db, upstream_id=upstream.id)

    reviewed = service.review_submission(
        test_db,
        reviewer_user_id=1,
        submission_id=submission.id,
        approved=True,
        note="Reviewed official upstream package and scan report",
    )
    assert reviewed.status == "approved"
    assert test_db.get(Plugin, plugin.id).latest_release_id == release.id


def test_openai_github_auto_sync_publishes_without_submission(test_db, monkeypatch):
    service = PluginMarketplaceService()
    stored_packages: dict[str, bytes] = {}
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    upstream = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
    )
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _github_upstream_zip(),
    )
    _mock_package_storage(monkeypatch, stored_packages)

    result = service.sync_upstream(test_db, upstream_id=upstream.id)

    plugin = test_db.get(Plugin, upstream.pluginId)
    release = test_db.get(PluginRelease, plugin.latest_release_id)
    assert result.syncPolicy == "auto_after_scan"
    assert plugin.status == "published"
    assert release.version == "0.1.6"
    assert release.status == "ready"
    assert release.scan_status == "passed"
    assert test_db.query(PluginSubmission).count() == 0


def test_openai_github_pending_release_publishes_after_switching_to_auto(
    test_db, monkeypatch
):
    service = PluginMarketplaceService()
    stored_packages: dict[str, bytes] = {}
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    upstream = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="review_required",
    )
    plugin = test_db.get(Plugin, upstream.pluginId)
    previous = PluginRelease(
        plugin_id=plugin.id,
        version="0.1.5",
        manifest_json={},
        interface_json={},
        storage_key="plugins/github-v2.zip",
        sha256="0" * 64,
        size_bytes=1,
        status="ready",
        scan_status="passed",
    )
    test_db.add(previous)
    test_db.flush()
    plugin.latest_release_id = previous.id
    plugin.status = "published"
    test_db.commit()
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _github_upstream_zip(),
    )
    _mock_package_storage(monkeypatch, stored_packages)

    result = service.sync_upstream(test_db, upstream_id=upstream.id)

    assert result.lastSeenVersion == "0.1.6"
    test_db.refresh(plugin)
    assert plugin.latest_release_id == previous.id
    candidate = (
        test_db.query(PluginRelease)
        .filter(
            PluginRelease.plugin_id == plugin.id,
            PluginRelease.version == "0.1.6",
        )
        .one()
    )
    submission = (
        test_db.query(PluginSubmission)
        .filter(PluginSubmission.release_id == candidate.id)
        .one()
    )
    assert submission.status == "pending"

    configured = service.configure_controlled_upstream(
        test_db,
        slug="github",
        display_name="GitHub",
        marketplace_name="openai/plugins",
        remote_plugin_id="github",
        upstream_url="https://github.com/openai/plugins/archive/main.zip",
        license_info="Bundled licenses",
        visibility="public",
        sync_policy="auto_after_scan",
    )
    service.sync_upstream(test_db, upstream_id=configured.id)

    test_db.refresh(submission)
    assert submission.status == "approved"
    assert submission.reviewer_user_id == 0
    assert submission.review_note == "Automatically published after scan policy change"
    assert candidate.status == "ready"
    assert test_db.get(Plugin, plugin.id).latest_release_id == candidate.id


def test_legacy_marketplace_migration_is_idempotent(test_db, test_user, monkeypatch):
    package = _plugin_zip()
    legacy = Kind(
        user_id=test_user.id,
        kind="PluginMarketplaceItem",
        namespace="default",
        name="gitlab-legacy",
        json={
            "spec": {
                "name": "gitlab-engineering",
                "displayName": "GitLab Engineering",
                "visibility": "workspace",
            }
        },
        is_active=True,
    )
    test_db.add(legacy)
    test_db.flush()
    test_db.add(
        SkillBinary(
            kind_id=legacy.id,
            binary_data=package,
            file_name="gitlab.zip",
            file_size=len(package),
            file_hash=hashlib.sha256(package).hexdigest(),
        )
    )
    test_db.commit()
    stored_packages: dict[str, bytes] = {}
    monkeypatch.setattr(plugin_package_storage, "put", stored_packages.__setitem__)
    service = PluginMarketplaceMigrationService()

    first = service.migrate(test_db)
    second = service.migrate(test_db)

    assert first.migrated_plugins == 1
    assert second.migrated_plugins == 0
    assert (
        test_db.query(Plugin)
        .filter(Plugin.slug.like("gitlab-engineering-legacy-%"))
        .count()
        == 1
    )
    assert test_db.query(PluginRelease).count() == 1


def test_visibility_personal_auto_approves_with_targets(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)
    recipient = User(
        user_name="visibility-recipient",
        password_hash=test_user.password_hash,
        email="visibility-recipient@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(recipient)
    test_db.commit()

    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=digest,
            sizeBytes=len(package),
            visibility="personal",
            targets=[
                PluginAccessTarget(
                    entityType="user",
                    entityId=str(recipient.id),
                    displayName=recipient.user_name,
                )
            ],
            allowCopy=True,
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
        package=package,
    )
    completed = service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    plugin = test_db.get(Plugin, initialized.pluginId)
    assert completed.status == "approved"
    assert completed.purpose == "restricted_share"
    assert plugin.visibility == "personal"
    assert plugin.allow_copy is True
    shared = service.list_plugins(test_db, user_id=recipient.id).items
    assert [item.id for item in shared] == [plugin.id]


def test_legacy_submission_cannot_publish_publicly(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)

    with pytest.raises(HTTPException) as exc:
        service.init_submission(
            test_db,
            user_id=test_user.id,
            request=PluginSubmissionInitRequest(
                slug="gitlab-engineering",
                displayName="GitLab Engineering",
                version="1.0.0",
                filename="gitlab.zip",
                sha256=digest,
                sizeBytes=len(package),
                visibility="public",
            ),
        )

    assert exc.value.status_code == 422
    assert test_db.query(Plugin).count() == 0


def test_legacy_submission_cannot_upgrade_personal_plugin_to_workspace(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package_v1 = _plugin_zip("1.0.0")
    package_v2 = _plugin_zip("1.1.0")
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages)

    first = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="gitlab-engineering",
            displayName="GitLab Engineering",
            version="1.0.0",
            filename="gitlab.zip",
            sha256=hashlib.sha256(package_v1).hexdigest(),
            sizeBytes=len(package_v1),
            visibility="personal",
        ),
    )
    _upload_submission(
        service,
        test_db,
        user_id=test_user.id,
        submission_id=first.submissionId,
        package=package_v1,
    )
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=first.submissionId
    )
    plugin = test_db.get(Plugin, first.pluginId)
    assert plugin.visibility == "personal"
    assert plugin.status == "published"

    _mock_package_storage(monkeypatch, stored_packages)
    with pytest.raises(HTTPException) as exc:
        service.init_submission(
            test_db,
            user_id=test_user.id,
            request=PluginSubmissionInitRequest(
                slug="gitlab-engineering",
                displayName="GitLab Engineering",
                version="1.1.0",
                filename="gitlab-v2.zip",
                sha256=hashlib.sha256(package_v2).hexdigest(),
                sizeBytes=len(package_v2),
                visibility="workspace",
            ),
        )

    assert exc.value.status_code == 422
    assert plugin.visibility == "personal"
    assert plugin.status == "published"


def test_reconcile_stale_installed_catalog_refs_after_reimport(test_db, test_user):
    service = PluginMarketplaceService()
    plugin = Plugin(
        slug="weibo-api-wiki",
        name="weibo-api-wiki",
        display_name="Weibo API Wiki",
        keywords_json=[],
        interface_json={},
        status="published",
        visibility="workspace",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="0.3.2",
        manifest_json={"name": "weibo-api-wiki"},
        interface_json={"displayName": "Weibo API Wiki"},
        storage_key=f"plugins/{plugin.id}/1/deadbeef.zip",
        sha256="a" * 64,
        size_bytes=12,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {"skills": [{"name": "wiki"}]}},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id

    stale = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="weibo-api-wiki-old",
        json={
            "kind": "InstalledPlugin",
            "metadata": {"name": "weibo-api-wiki-old", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "providerKey": "wegent-market",
                    "pluginKey": "weibo-api-wiki",
                    "catalogItemId": "24",
                    "marketplace": "wegent",
                },
                "origin": "market",
                "pluginId": 24,
                "releaseId": 31,
                "enabled": True,
                "installState": "installed",
            },
        },
        is_active=True,
    )
    duplicate = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="weibo-api-wiki-dup",
        json={
            "kind": "InstalledPlugin",
            "metadata": {"name": "weibo-api-wiki-dup", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "pluginKey": "weibo-api-wiki",
                    "catalogItemId": "6",
                    "marketplace": "wegent",
                },
                "pluginId": 6,
                "releaseId": 19,
                "enabled": False,
                "installState": "installed",
            },
        },
        is_active=True,
    )
    orphan = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="dev-tools-full-old",
        json={
            "kind": "InstalledPlugin",
            "metadata": {"name": "dev-tools-full-old", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "pluginKey": "dev-tools-full",
                    "catalogItemId": "26",
                    "marketplace": "wegent",
                },
                "pluginId": 26,
                "releaseId": 33,
                "enabled": True,
                "installState": "installed",
            },
        },
        is_active=True,
    )
    test_db.add_all([stale, duplicate, orphan])
    test_db.flush()
    test_db.add(
        PluginDeviceInstallation(
            installed_kind_id=duplicate.id,
            user_id=test_user.id,
            device_id="local-device",
            desired_release_id=19,
            state="failed",
            error_code="PLUGIN_SYNC_FAILED",
            error_message="Capability package download failed with HTTP 404 Not Found",
            attempt_count=9,
        )
    )
    test_db.commit()

    changed = service.reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )
    assert changed >= 2

    test_db.refresh(stale)
    test_db.refresh(duplicate)
    test_db.refresh(orphan)
    active = [row for row in (stale, duplicate) if row.is_active]
    assert len(active) == 1
    keeper = active[0]
    assert keeper.json["spec"]["pluginId"] == plugin.id
    assert keeper.json["spec"]["releaseId"] == release.id
    assert keeper.json["spec"]["source"]["catalogItemId"] == str(plugin.id)
    assert keeper.json["spec"]["source"]["marketplace"] == "wegent"
    assert sum(1 for row in (stale, duplicate) if row.is_active) == 1
    assert orphan.json["spec"].get("pluginId") in (None, 0)
    assert orphan.json["spec"].get("releaseId") in (None, 0)

    device_row = (
        test_db.query(PluginDeviceInstallation)
        .filter(PluginDeviceInstallation.installed_kind_id == keeper.id)
        .one_or_none()
    )
    if device_row is not None:
        assert device_row.state == "pending"
        assert device_row.desired_release_id == release.id
        assert device_row.error_code == ""


def test_reconcile_updates_visibility_only_marketplace_change(test_db, test_user):
    service = PluginMarketplaceService()
    plugin = Plugin(
        slug="weibo-api-wiki",
        name="weibo-api-wiki",
        display_name="Weibo API Wiki",
        keywords_json=[],
        interface_json={},
        status="published",
        visibility="workspace",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="0.3.2",
        manifest_json={"name": "weibo-api-wiki"},
        interface_json={"displayName": "Weibo API Wiki"},
        storage_key=f"plugins/{plugin.id}/1/deadbeef.zip",
        sha256="a" * 64,
        size_bytes=12,
        status="ready",
        scan_status="passed",
        scan_report_json={"components": {"skills": [{"name": "wiki"}]}},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id

    installed = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="weibo-api-wiki",
        json={
            "kind": "InstalledPlugin",
            "metadata": {"name": "weibo-api-wiki", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "providerKey": "wegent-market",
                    "pluginKey": "weibo-api-wiki",
                    "catalogItemId": str(plugin.id),
                    "marketplace": "wework",
                },
                "origin": "market",
                "pluginId": plugin.id,
                "releaseId": release.id,
                "enabled": True,
                "installState": "installed",
            },
        },
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()

    changed = service.reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )

    assert changed == 1
    test_db.refresh(installed)
    assert installed.json["spec"]["source"]["marketplace"] == "wegent"
