# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import stat
import zipfile
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.endpoints.installed_plugins import _can_publish, _sync_global_capabilities
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
    PluginAccessTarget,
    PluginAccessUpdateRequest,
    PluginSubmissionInitRequest,
    PluginUpstreamCreateRequest,
)
from app.services.device.capability_sync_service import (
    DeviceCapabilitySyncService,
    device_capability_sync_service,
)
from app.services.official_plugin_publisher import OfficialPluginPublisher
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)
from app.services.plugin_marketplace_migration_service import (
    PluginMarketplaceMigrationService,
)
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_storage import (
    PluginPackageStorageError,
    plugin_package_storage,
)
from app.services.plugin_upstream_adapter import OPENAI_GITHUB_SKILL_DESCRIPTIONS


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
        for path in OPENAI_GITHUB_SKILL_DESCRIPTIONS:
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


def _presigned_upload(
    stored_packages: dict[str, bytes], package: bytes, key: str
) -> tuple[str, datetime]:
    stored_packages[key] = package
    return f"https://store/{key}", datetime.now(timezone.utc)


def _mock_package_storage(
    monkeypatch, stored_packages: dict[str, bytes], package: bytes | None = None
) -> None:
    def put_immutable(key: str, data: bytes) -> bool:
        if key in stored_packages:
            if stored_packages[key] != data:
                raise PluginPackageStorageError("immutable object differs")
            return False
        stored_packages[key] = data
        return True

    if package is not None:
        monkeypatch.setattr(
            plugin_package_storage,
            "presign_upload",
            lambda key: _presigned_upload(stored_packages, package, key),
        )
    monkeypatch.setattr(plugin_package_storage, "get", lambda key: stored_packages[key])
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
                "enabled": True,
                "installState": "installed",
            }
        },
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()
    return installed, release


def test_submission_review_publishes_immutable_release_without_install_copy(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package)

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
    completed = service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    reviewed = service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=initialized.submissionId,
        approved=True,
        note="Verified",
    )

    assert completed.status == "pending"
    assert reviewed.status == "approved"
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
    assert installed.spec.visibility == "workspace"
    assert installed.spec.packageRef is not None
    assert (
        test_db.query(SkillBinary).filter(SkillBinary.kind_id == installed_id).first()
        is None
    )


def test_submission_cannot_be_reviewed_twice(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=initialized.submissionId,
        approved=True,
        note="Approved",
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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


def test_pending_update_keeps_the_published_release_visible(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    stored_packages: dict[str, bytes] = {}
    package_v1 = _plugin_zip("1.0.0", "GitLab Stable")
    _mock_package_storage(monkeypatch, stored_packages, package_v1)
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
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=first.submissionId
    )
    service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=first.submissionId,
        approved=True,
        note="Initial release",
    )

    package_v2 = _plugin_zip("2.0.0", "GitLab Next")
    _mock_package_storage(monkeypatch, stored_packages, package_v2)
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
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=second.submissionId
    )

    pending_catalog = service.list_plugins(test_db, user_id=test_user.id)
    assert [(item.displayName, item.version) for item in pending_catalog.items] == [
        ("GitLab Stable", "1.0.0")
    ]
    plugin = test_db.get(Plugin, first.pluginId)
    assert plugin.status == "published"
    assert plugin.latest_release_id == first.releaseId

    service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=second.submissionId,
        approved=True,
        note="Promote update",
    )
    published_catalog = service.list_plugins(test_db, user_id=test_user.id)
    assert [(item.displayName, item.version) for item in published_catalog.items] == [
        ("GitLab Next", "2.0.0")
    ]


def test_user_submission_cannot_claim_an_official_plugin_slug(test_db, test_user):
    test_db.add(
        Plugin(
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
    )
    test_db.commit()

    package = _plugin_zip()
    with pytest.raises(HTTPException, match="Plugin slug is already owned"):
        PluginMarketplaceService().init_submission(
            test_db,
            user_id=test_user.id,
            request=PluginSubmissionInitRequest(
                slug="official-plugin",
                displayName="Claimed",
                version="9.0.0",
                filename="claimed.zip",
                sha256=hashlib.sha256(package).hexdigest(),
                sizeBytes=len(package),
            ),
        )


def test_official_package_build_is_deterministic_and_publish_is_idempotent(
    test_db, test_user, monkeypatch, tmp_path
):
    source = _write_official_source(tmp_path / "official-review")
    publisher = OfficialPluginPublisher()
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=initialized.submissionId
    )
    service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=initialized.submissionId,
        approved=True,
        note="",
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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


def test_rejected_submission_never_enters_catalog(test_db, test_user, monkeypatch):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package)
    initialized = service.init_submission(
        test_db,
        user_id=test_user.id,
        request=PluginSubmissionInitRequest(
            slug="rejected-plugin",
            displayName="Rejected Plugin",
            version="1.0.0",
            filename="rejected.zip",
            sha256=digest,
            sizeBytes=len(package),
        ),
    )
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=initialized.submissionId
    )

    reviewed = service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=initialized.submissionId,
        approved=False,
        note="Needs changes",
    )

    assert reviewed.status == "rejected"
    assert service.list_plugins(test_db, user_id=test_user.id).items == []
    assert test_db.get(PluginRelease, initialized.releaseId).status == "rejected"


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


def test_restricted_submission_is_owner_only_until_access_is_granted(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package)
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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


def test_device_sync_requires_a_result_for_each_desired_plugin(test_db, test_user):
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
    assert row.state == "failed"
    assert row.error_message == "Device response omitted plugin result"


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
    assert item.currentDeviceInstallation.state == "failed"
    assert (
        item.currentDeviceInstallation.errorMessage
        == "Device response omitted plugin result"
    )


def test_publish_capability_supports_admin_flag_and_user_allowlist(
    test_user, monkeypatch
):
    monkeypatch.setattr(settings, "PLUGIN_PUBLISH_ENABLED", False)
    monkeypatch.setattr(settings, "PLUGIN_PUBLISH_USER_IDS", [])
    test_user.role = "user"
    assert _can_publish(test_user) is False

    monkeypatch.setattr(settings, "PLUGIN_PUBLISH_USER_IDS", [test_user.id])
    assert _can_publish(test_user) is True

    monkeypatch.setattr(settings, "PLUGIN_PUBLISH_USER_IDS", [])
    test_user.role = "admin"
    assert _can_publish(test_user) is True


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
    assert row.state == "failed"
    assert row.error_message == "Device response omitted plugin result"


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
    service = PluginMarketplaceService()
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
    assert plugin.source_type == "mirror"
    assert plugin.source_provider == "wework"
    assert plugin.display_name == "GitHub"
    assert plugin.visibility == "public"
    assert first.id == second.id
    assert first.syncEnabled is True
    assert first.syncPolicy == "review_required"
    assert test_db.query(PluginUpstream).count() == 1
    assert test_db.get(PluginUpstream, first.id).sync_policy == "review_required"


def test_configure_controlled_upstream_reclassifies_legacy_codex_mirror(
    test_db, monkeypatch
):
    plugin = Plugin(
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


def test_openai_github_upstream_sync_applies_the_reviewed_adapter(test_db, monkeypatch):
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

    assert result.lastSeenVersion == "0.1.6+wegent.3"
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
    assert release.version == "0.1.6+wegent.3"
    provenance = release.scan_report_json["provenance"]
    assert provenance["kind"] == "upstream"
    assert provenance["adapter"] == "openai-github"
    assert provenance["adapterVersion"] == "3"
    assert provenance["upstreamVersion"] == "0.1.6"
    with zipfile.ZipFile(io.BytesIO(stored_packages[release.storage_key])) as archive:
        manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
        assert manifest["connectors"] == [
            {"slug": "github", "authPolicy": "on_install"}
        ]
        for path, description in OPENAI_GITHUB_SKILL_DESCRIPTIONS.items():
            skill = archive.read(path).decode("utf-8")
            assert f"description: {description}\n" in skill
        assert "apps" not in manifest
        assert ".mcp.json" not in archive.namelist()

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
        note="Reviewed adapter and scan report",
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
    assert release.version == "0.1.6+wegent.3"
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
        version="0.1.6+wegent.2",
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

    assert result.lastSeenVersion == "0.1.6+wegent.3"
    test_db.refresh(plugin)
    assert plugin.latest_release_id == previous.id
    candidate = (
        test_db.query(PluginRelease)
        .filter(
            PluginRelease.plugin_id == plugin.id,
            PluginRelease.version == "0.1.6+wegent.3",
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
    _mock_package_storage(monkeypatch, stored_packages, package)
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


def test_visibility_public_waits_for_review_and_publishes(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package = _plugin_zip()
    digest = hashlib.sha256(package).hexdigest()
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package)

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
            visibility="public",
        ),
    )
    completed = service.complete_submission(
        test_db,
        user_id=test_user.id,
        submission_id=initialized.submissionId,
    )
    plugin = test_db.get(Plugin, initialized.pluginId)
    assert completed.status == "pending"
    assert completed.purpose == "marketplace_publish"
    assert plugin.status == "pending_review"
    assert plugin.visibility == "public"

    reviewed = service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=initialized.submissionId,
        approved=True,
        note="ok",
    )
    test_db.refresh(plugin)
    assert reviewed.status == "approved"
    assert plugin.status == "published"
    assert plugin.visibility == "public"


def test_personal_to_workspace_upgrade_applies_on_review(
    test_db, test_user, monkeypatch
):
    service = PluginMarketplaceService()
    package_v1 = _plugin_zip("1.0.0")
    package_v2 = _plugin_zip("1.1.0")
    stored_packages: dict[str, bytes] = {}
    _mock_package_storage(monkeypatch, stored_packages, package_v1)

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
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=first.submissionId
    )
    plugin = test_db.get(Plugin, first.pluginId)
    assert plugin.visibility == "personal"
    assert plugin.status == "published"

    _mock_package_storage(monkeypatch, stored_packages, package_v2)
    second = service.init_submission(
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
    service.complete_submission(
        test_db, user_id=test_user.id, submission_id=second.submissionId
    )
    test_db.refresh(plugin)
    assert plugin.visibility == "personal"
    assert plugin.status == "published"

    service.review_submission(
        test_db,
        reviewer_user_id=test_user.id,
        submission_id=second.submissionId,
        approved=True,
        note="promote",
    )
    test_db.refresh(plugin)
    assert plugin.visibility == "workspace"
    assert plugin.status == "published"
    assert plugin.latest_release_id == second.releaseId
