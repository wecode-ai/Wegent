# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Marketplace catalog, immutable releases, submissions, and selective mirrors."""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta
from io import BytesIO
from typing import Any, Iterable

from fastapi import HTTPException
from packaging.version import Version
from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
    PluginSubmission,
    PluginUpstream,
    is_featured_rank,
    unset_datetime,
    unset_id,
    unset_str,
)
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.installed_plugin import (
    InstalledPlugin,
    InstalledPluginListResponse,
    PluginAccessResponse,
    PluginAccessTarget,
    PluginAccessUpdateRequest,
    PluginCopyResponse,
    PluginDeviceInstallationItem,
    PluginMarketplaceItem,
    PluginMarketplaceListResponse,
    PluginReleaseItem,
    PluginReleaseListResponse,
    PluginSubmissionInitRequest,
    PluginSubmissionInitResponse,
    PluginSubmissionItem,
    PluginSubmissionListResponse,
    PluginUploadInfo,
    PluginUpstreamCreateRequest,
    PluginUpstreamItem,
    PluginUpstreamListResponse,
)
from app.services.plugin_marketplace_identity import marketplace_name_for_visibility
from app.services.plugin_package_parser import plugin_package_parser
from app.services.plugin_package_scanner import (
    PluginPackageScanError,
    scan_plugin_package,
)
from app.services.plugin_package_storage import (
    PluginPackageStorageError,
    plugin_package_storage,
)
from app.services.plugin_upstream_adapter import (
    AdaptedUpstreamPackage,
    adapt_upstream_package,
)
from app.services.plugin_upstream_fetch import (
    UpstreamFetchError,
    fetch_upstream_package,
    validate_upstream_url,
)

SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)
SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$")
MAX_RESOLVED_INTERFACE_CACHE_ENTRIES = 128
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PublishedRelease:
    """Result of publishing one immutable package."""

    release: PluginRelease
    created: bool


class PluginMarketplaceService:
    """Own the cloud marketplace while leaving runtime installation to Codex."""

    def __init__(self) -> None:
        self._resolved_interface_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def reconcile_stale_installed_catalog_refs(
        self, db: Session, *, user_id: int
    ) -> int:
        """Repair InstalledPlugin kinds whose catalog IDs drifted after a DB reimport.

        Matches by marketplace pluginKey/name, remaps pluginId/releaseId to the
        current published catalog, detaches orphaned cloud refs that no longer
        exist, and deactivates duplicate installs for the same pluginKey.
        """
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .order_by(Kind.id.asc())
            .all()
        )
        if not rows:
            return 0

        changed = 0
        by_key: dict[str, list[Kind]] = {}
        for row in rows:
            payload = row.json if isinstance(row.json, dict) else {}
            spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
            source = spec.get("source") if isinstance(spec.get("source"), dict) else {}
            plugin_key = str(source.get("pluginKey") or "").strip()
            if not plugin_key:
                continue
            by_key.setdefault(plugin_key.lower(), []).append(row)

        # Drop duplicates before remapping so device-install resets are not deleted
        # out from under the SQLAlchemy session.
        keepers: list[Kind] = []
        for group in by_key.values():
            keeper = max(
                group, key=lambda item: self._installed_kind_catalog_score(db, item)
            )
            keepers.append(keeper)
            for row in group:
                if row.id == keeper.id:
                    continue
                if self._deactivate_duplicate_installed_kind(db, row):
                    changed += 1

        for row in keepers:
            payload = row.json if isinstance(row.json, dict) else {}
            spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
            source = spec.get("source") if isinstance(spec.get("source"), dict) else {}
            plugin_key = str(source.get("pluginKey") or "").strip()
            if not plugin_key:
                continue
            if self._reconcile_installed_kind_catalog_ref(
                db, row=row, plugin_key=plugin_key
            ):
                changed += 1

        # Drop device-install rows that still point at inactive/uninstalled kinds.
        # These leftovers surface as “devices failed to synchronize” after catalog
        # reimports even when the visible plugin (e.g. EchoID) is already healthy.
        stale_device_rows = (
            db.query(PluginDeviceInstallation)
            .filter(PluginDeviceInstallation.user_id == user_id)
            .all()
        )
        active_ids = {row.id for row in rows}
        for device_row in stale_device_rows:
            kind = db.get(Kind, device_row.installed_kind_id)
            if (
                device_row.installed_kind_id in active_ids
                and kind
                and kind.is_active
                and ((kind.json or {}).get("spec") or {}).get("installState")
                != "uninstalled"
            ):
                continue
            db.delete(device_row)
            changed += 1

        if changed:
            db.commit()
        return changed

    def enrich_installed_list(
        self,
        db: Session,
        response: InstalledPluginListResponse,
        *,
        device_id: str | None = None,
    ) -> InstalledPluginListResponse:
        installed_by_id = {
            int(item.metadata["labels"]["id"]): item
            for item in response.items
            if str((item.metadata.get("labels") or {}).get("id", "")).isdigit()
        }
        device_rows = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id.in_(installed_by_id.keys())
            )
            .order_by(PluginDeviceInstallation.device_id)
            .all()
            if installed_by_id
            else []
        )
        for row in device_rows:
            item = installed_by_id.get(row.installed_kind_id)
            if not item:
                continue
            item.status.devices.append(
                PluginDeviceInstallationItem(
                    deviceId=row.device_id,
                    desiredReleaseId=row.desired_release_id,
                    actualReleaseId=unset_id(row.actual_release_id),
                    state=row.state,
                    errorCode=unset_str(row.error_code),
                    errorMessage=unset_str(row.error_message),
                    attemptCount=row.attempt_count,
                    lastSyncAt=unset_datetime(row.last_sync_at),
                    updatedAt=row.updated_at,
                )
            )
        rows_by_install = {
            (row.installed_kind_id, row.device_id): row for row in device_rows
        }
        for item in response.items:
            plugin_id = item.spec.pluginId
            if not plugin_id:
                continue
            installed_id = self._installed_item_id(item)
            if device_id and installed_id:
                device_row = rows_by_install.get((installed_id, device_id))
                if not self._device_has_release(device_row, item.spec.releaseId):
                    item.spec.installState = (
                        "failed"
                        if device_row and device_row.state == "failed"
                        else "not_installed"
                    )
                    continue
            plugin = db.get(Plugin, plugin_id)
            if plugin and plugin.latest_release_id != item.spec.releaseId:
                item.spec.installState = "update_available"
        return response

    def list_plugins(
        self,
        db: Session,
        *,
        user_id: int | None,
        query: str | None = None,
        source: str | None = None,
        listing_type: str | None = None,
        device_id: str | None = None,
    ) -> PluginMarketplaceListResponse:
        rows = (
            db.query(Plugin)
            .filter(
                Plugin.status == "published",
                Plugin.latest_release_id != 0,
                Plugin.visibility.in_(["personal", "workspace", "public"]),
            )
            .order_by(Plugin.featured_rank == 0, Plugin.featured_rank, Plugin.id.desc())
            .all()
        )
        normalized_query = (query or "").strip().lower()
        installed_by_plugin_id = (
            self._load_installed_kinds_by_plugin_id(db, user_id=user_id)
            if user_id is not None
            else {}
        )
        release_ids = [
            plugin.latest_release_id for plugin in rows if plugin.latest_release_id
        ]
        releases_by_id = (
            {
                release.id: release
                for release in db.query(PluginRelease)
                .filter(
                    PluginRelease.id.in_(release_ids),
                    PluginRelease.status == "ready",
                    PluginRelease.scan_status == "passed",
                )
                .all()
            }
            if release_ids
            else {}
        )
        owner_ids = {plugin.owner_user_id for plugin in rows if plugin.owner_user_id}
        owners_by_id = (
            {
                owner.id: owner
                for owner in db.query(User).filter(User.id.in_(owner_ids)).all()
            }
            if owner_ids
            else {}
        )
        grants_by_plugin_id = self._load_grants_by_plugin_ids(
            db, [plugin.id for plugin in rows]
        )
        installed_kind_ids = [row.id for row in installed_by_plugin_id.values()]
        device_rows_by_kind_id: dict[int, PluginDeviceInstallation] = {}
        if device_id and installed_kind_ids:
            device_rows_by_kind_id = {
                row.installed_kind_id: row
                for row in db.query(PluginDeviceInstallation)
                .filter(
                    PluginDeviceInstallation.installed_kind_id.in_(installed_kind_ids),
                    PluginDeviceInstallation.device_id == device_id,
                )
                .all()
            }

        items: list[PluginMarketplaceItem] = []
        for plugin in rows:
            if not self._can_access_plugin(db, plugin=plugin, user_id=user_id):
                continue
            if listing_type and plugin.listing_type != listing_type:
                continue
            if source and not self._matches_source(plugin, source):
                continue
            if normalized_query and normalized_query not in self._search_text(plugin):
                continue
            release = releases_by_id.get(plugin.latest_release_id)
            if not release:
                continue
            installed = installed_by_plugin_id.get(plugin.id)
            items.append(
                self._to_marketplace_item(
                    db,
                    plugin,
                    release,
                    user_id=user_id,
                    device_id=device_id,
                    installed=installed,
                    owner=(
                        owners_by_id.get(plugin.owner_user_id)
                        if plugin.owner_user_id
                        else None
                    ),
                    grants=grants_by_plugin_id.get(plugin.id, []),
                    device_row=(
                        device_rows_by_kind_id.get(installed.id) if installed else None
                    ),
                    resolve_package_assets=False,
                )
            )
        return PluginMarketplaceListResponse(items=items)

    def get_plugin(
        self,
        db: Session,
        *,
        plugin_id: int,
        user_id: int,
        device_id: str | None = None,
    ) -> PluginMarketplaceItem:
        plugin = self._published_plugin(db, plugin_id, user_id=user_id)
        release = self._latest_release(db, plugin)
        if not release:
            raise HTTPException(status_code=404, detail="Plugin release not found")
        return self._to_marketplace_item(
            db,
            plugin,
            release,
            user_id=user_id,
            device_id=device_id,
        )

    def list_releases(
        self, db: Session, *, plugin_id: int, user_id: int
    ) -> PluginReleaseListResponse:
        self._published_plugin(db, plugin_id, user_id=user_id)
        rows = (
            db.query(PluginRelease)
            .filter(
                PluginRelease.plugin_id == plugin_id,
                PluginRelease.status == "ready",
                PluginRelease.scan_status == "passed",
            )
            .order_by(PluginRelease.published_at.desc(), PluginRelease.id.desc())
            .all()
        )
        return PluginReleaseListResponse(
            items=[self._release_item(row) for row in rows]
        )

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        plugin_id: int,
        release_id: int | None = None,
    ) -> InstalledPlugin:
        self.reconcile_stale_installed_catalog_refs(db, user_id=user_id)
        plugin = self._published_plugin(db, plugin_id, user_id=user_id)
        plugin = db.query(Plugin).filter(Plugin.id == plugin.id).with_for_update().one()
        existing = self._find_installed(db, user_id=user_id, plugin_id=plugin.id)
        if release_id is not None:
            if not existing and release_id != plugin.latest_release_id:
                raise HTTPException(
                    status_code=400,
                    detail="New installs must use the latest marketplace release",
                )
            if existing:
                raise HTTPException(
                    status_code=400,
                    detail="Use PUT /plugins/installed/{id} to upgrade an installed plugin",
                )
        release = self._installable_release(db, plugin, None)
        installed = existing
        payload = self._installed_payload(plugin, release)
        if installed:
            installed.json = payload
            installed.is_active = True
        else:
            installed = Kind(
                user_id=user_id,
                kind="InstalledPlugin",
                name=self._kind_name(plugin.slug),
                namespace="default",
                json=payload,
                is_active=True,
            )
            db.add(installed)
        db.commit()
        db.refresh(installed)
        return self._kind_to_installed(installed)

    def update_release(
        self,
        db: Session,
        *,
        user_id: int,
        installed_id: int,
        release_id: int,
    ) -> InstalledPlugin:
        installed = self._owned_install(db, user_id=user_id, installed_id=installed_id)
        spec = installed.json.get("spec", {})
        plugin_id = spec.get("pluginId")
        if not isinstance(plugin_id, int):
            raise HTTPException(
                status_code=409, detail="Legacy plugin cannot use release update"
            )
        plugin = self._published_plugin(db, plugin_id, user_id=user_id)
        release = self._installable_release(db, plugin, release_id)
        enabled = bool(spec.get("enabled", True))
        component_states = spec.get("componentStates") or {}
        installed.json = self._installed_payload(plugin, release)
        installed.json["spec"]["enabled"] = enabled
        installed.json["spec"]["componentStates"] = component_states
        db.commit()
        db.refresh(installed)
        return self._kind_to_installed(installed)

    def release_package_for_install(
        self, db: Session, *, user_id: int, installed_id: int
    ) -> tuple[bytes, str]:
        installed = self._owned_install(db, user_id=user_id, installed_id=installed_id)
        release_id = installed.json.get("spec", {}).get("releaseId")
        if not isinstance(release_id, int):
            raise HTTPException(status_code=404, detail="Plugin release not found")
        release = db.get(PluginRelease, release_id)
        if not release or release.status != "ready" or release.scan_status != "passed":
            raise HTTPException(status_code=404, detail="Plugin release not available")
        package = plugin_package_storage.get(release.storage_key)
        actual = hashlib.sha256(package).hexdigest()
        if actual != release.sha256:
            raise HTTPException(
                status_code=409, detail="Plugin package checksum mismatch"
            )
        plugin = db.get(Plugin, release.plugin_id)
        filename = f"{plugin.slug if plugin else 'plugin'}-{release.version}.zip"
        return package, filename

    def publish_official_release(
        self,
        db: Session,
        *,
        slug: str,
        package: bytes,
        listing_type: str = "plugin",
        visibility: str = "workspace",
        featured_rank: int | None = None,
        created_by_user_id: int | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> PublishedRelease:
        """Publish a WeWork-owned official release."""
        self._validate_slug(slug)
        if listing_type not in {"plugin", "skill"}:
            raise HTTPException(status_code=422, detail="Invalid plugin listing type")
        if visibility not in {"workspace", "public"}:
            raise HTTPException(status_code=422, detail="Invalid plugin visibility")
        parsed, security_report = self._analyze_package(package)
        if parsed.name != slug:
            raise HTTPException(
                status_code=422,
                detail="Official plugin slug must match the manifest name",
            )
        plugin = db.query(Plugin).filter(Plugin.slug == slug).with_for_update().first()
        if plugin and (
            plugin.source_type != "native"
            or plugin.source_provider != "wework"
            or plugin.owner_user_id != 0
        ):
            raise HTTPException(
                status_code=409,
                detail="Plugin slug is owned by a different publisher",
            )
        if plugin and plugin.listing_type != listing_type:
            raise HTTPException(
                status_code=409, detail="Plugin listing type cannot be changed"
            )
        if not plugin:
            plugin = Plugin(
                slug=slug,
                name=parsed.name,
                display_name=parsed.displayName,
                listing_type=listing_type,
                source_type="native",
                source_provider="wework",
                owner_user_id=0,
                keywords_json=[],
                interface_json={},
                visibility=visibility,
                status="draft",
            )
            db.add(plugin)
            db.flush()
        current_release = (
            db.get(PluginRelease, plugin.latest_release_id)
            if plugin.latest_release_id
            else None
        )
        if current_release and Version(parsed.version) < Version(
            current_release.version
        ):
            raise HTTPException(
                status_code=409,
                detail="Official plugin version must not be older than latest",
            )
        plugin.visibility = visibility
        plugin.featured_rank = featured_rank or 0
        try:
            result = self._publish_release(
                db,
                plugin=plugin,
                package=package,
                parsed=parsed,
                security_report=security_report,
                created_by_user_id=created_by_user_id or 0,
                provenance={
                    "kind": "official",
                    **(provenance or {}),
                },
            )
        except Exception:
            db.rollback()
            raise
        if not result.created:
            try:
                db.commit()
            except Exception:
                db.rollback()
                raise
            db.refresh(result.release)
        return result

    def init_submission(
        self,
        db: Session,
        *,
        user_id: int,
        request: PluginSubmissionInitRequest,
    ) -> PluginSubmissionInitResponse:
        self._validate_slug(request.slug)
        self._validate_version(request.version)
        if not re.fullmatch(r"[0-9a-fA-F]{64}", request.sha256):
            raise HTTPException(status_code=422, detail="sha256 must be hexadecimal")
        visibility = self._resolve_submission_visibility(request)
        purpose = (
            "restricted_share" if visibility == "personal" else "marketplace_publish"
        )
        pending_access = None
        if visibility == "personal" and (request.targets or request.allowCopy):
            # Validate recipients up front so publish fails before package upload.
            validated_targets = self._validated_access_targets(
                db,
                owner_user_id=user_id,
                targets=list(request.targets),
            )
            pending_access = {
                "targets": [target.model_dump() for target in validated_targets],
                "allowCopy": bool(request.allowCopy and validated_targets),
            }
        reclaimed_storage_key: str | None = None
        try:
            plugin = db.query(Plugin).filter(Plugin.slug == request.slug).first()
            if plugin and plugin.owner_user_id != user_id:
                raise HTTPException(
                    status_code=409, detail="Plugin slug is already owned"
                )
            if plugin and plugin.listing_type != request.listingType:
                raise HTTPException(
                    status_code=409, detail="Plugin listing type cannot be changed"
                )
            if not plugin:
                plugin = Plugin(
                    slug=request.slug,
                    name=request.slug,
                    display_name=request.displayName.strip() or request.slug,
                    listing_type=request.listingType,
                    source_type="submission",
                    source_provider="user",
                    owner_user_id=user_id,
                    keywords_json=[],
                    interface_json={},
                    visibility=visibility,
                    status="draft",
                )
                db.add(plugin)
                db.flush()
            else:
                self._apply_submission_visibility_upgrade(
                    db, plugin=plugin, visibility=visibility
                )
            duplicate = (
                db.query(PluginRelease)
                .filter(
                    PluginRelease.plugin_id == plugin.id,
                    PluginRelease.version == request.version,
                )
                .with_for_update()
                .first()
            )
            if duplicate:
                reclaimed, reclaimed_storage_key = (
                    self._discard_reclaimable_submission_release(
                        db,
                        release=duplicate,
                    )
                )
                if not reclaimed:
                    raise HTTPException(
                        status_code=409, detail="Plugin version already exists"
                    )
            release = PluginRelease(
                plugin_id=plugin.id,
                version=request.version,
                manifest_json={},
                interface_json={},
                storage_key="pending",
                sha256=request.sha256.lower(),
                size_bytes=request.sizeBytes,
                status="processing",
                scan_status="pending",
                scan_report_json={
                    "filename": request.filename,
                    "requestedVisibility": visibility,
                    **({"pendingAccess": pending_access} if pending_access else {}),
                },
                created_by_user_id=user_id,
            )
            db.add(release)
            db.flush()
            release.storage_key = self._staging_storage_key(release.id, release.sha256)
            submission = PluginSubmission(
                plugin_id=plugin.id,
                release_id=release.id,
                submitter_user_id=user_id,
                purpose=purpose,
                status="uploading",
            )
            db.add(submission)
            db.flush()
            upload_url, expires_at = plugin_package_storage.presign_upload(
                release.storage_key
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        self._delete_submission_object_best_effort(reclaimed_storage_key)
        return PluginSubmissionInitResponse(
            submissionId=submission.id,
            pluginId=plugin.id,
            releaseId=release.id,
            uploadUrl=upload_url,
            expiresAt=expires_at,
        )

    def _discard_reclaimable_submission_release(
        self,
        db: Session,
        *,
        release: PluginRelease,
    ) -> tuple[bool, str | None]:
        submission = (
            db.query(PluginSubmission)
            .filter(PluginSubmission.release_id == release.id)
            .first()
        )
        if not submission:
            return False, None
        timeout_seconds = (
            settings.PLUGIN_SUBMISSION_SCAN_TIMEOUT_SECONDS
            if submission.status == "scanning"
            else settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS
        )
        expired_at = submission.submitted_at + timedelta(seconds=timeout_seconds)
        expired = submission.status in {"uploading", "scanning"} and (
            datetime.now() >= expired_at
        )
        terminal = submission.status in {"rejected", "cancelled"}
        if not expired and not terminal:
            return False, None
        storage_key = release.storage_key
        db.delete(submission)
        db.delete(release)
        db.flush()
        return True, storage_key if storage_key != "pending" else None

    def _delete_submission_object_best_effort(self, storage_key: str | None) -> None:
        if not storage_key:
            return
        try:
            plugin_package_storage.delete(storage_key)
        except Exception:
            logger.warning(
                "Failed to delete plugin submission object: key=%s",
                storage_key,
                exc_info=True,
            )

    def cancel_submission(
        self,
        db: Session,
        *,
        user_id: int,
        submission_id: int,
    ) -> PluginSubmissionItem:
        submission = self._owned_submission(db, user_id, submission_id, for_update=True)
        if submission.status != "uploading":
            raise HTTPException(
                status_code=409, detail="Submission cannot be cancelled"
            )
        release = db.get(PluginRelease, submission.release_id)
        submission.status = "cancelled"
        submission.reviewed_at = datetime.now()
        if release:
            release.status = "rejected"
            release.scan_status = "failed"
            release.scan_report_json = {"error": "Submission cancelled"}
        storage_key = release.storage_key if release else None
        try:
            db.commit()
        except Exception:
            db.rollback()
            raise
        self._delete_submission_object_best_effort(
            storage_key if storage_key != "pending" else None
        )
        db.refresh(submission)
        return self._submission_item(submission)

    def _resolve_submission_visibility(
        self, request: PluginSubmissionInitRequest
    ) -> str:
        if request.visibility:
            return request.visibility
        return "personal" if request.purpose == "restricted_share" else "workspace"

    def _apply_submission_visibility_upgrade(
        self, db: Session, *, plugin: Plugin, visibility: str
    ) -> None:
        """Validate visibility transitions; apply immediately only when safe.

        Draft / pending_review plugins can take the requested visibility now because
        they are not catalog-visible. Published personal -> marketplace upgrades
        keep personal visibility until review approval.
        """
        del db
        current = plugin.visibility
        if visibility == "personal":
            if plugin.status == "published" and current != "personal":
                raise HTTPException(
                    status_code=409,
                    detail="Published marketplace plugins cannot become personal shares",
                )
            plugin.visibility = "personal"
            return
        if plugin.status == "published" and current == "personal":
            # Keep personal until marketplace review approves the upgrade.
            return
        if current == "public" and visibility == "workspace":
            raise HTTPException(
                status_code=409,
                detail="Public plugins cannot be downgraded to workspace",
            )
        if plugin.status != "published":
            plugin.visibility = visibility
            return
        if visibility in {"workspace", "public"}:
            plugin.visibility = visibility

    def _requested_visibility_for_release(
        self, release: PluginRelease, *, fallback: str
    ) -> str:
        report = release.scan_report_json or {}
        requested = report.get("requestedVisibility")
        if requested in {"personal", "workspace", "public"}:
            return requested
        return fallback

    def complete_submission(
        self, db: Session, *, user_id: int, submission_id: int
    ) -> PluginSubmissionItem:
        submission = self._owned_submission(db, user_id, submission_id, for_update=True)
        if submission.status not in {"uploading", "scanning"}:
            raise HTTPException(status_code=409, detail="Submission is not uploading")
        if submission.status == "uploading":
            submission.status = "scanning"
            release_id = submission.release_id
            db.commit()
        else:
            release_id = submission.release_id
        release = db.get(PluginRelease, release_id)
        plugin = db.get(Plugin, submission.plugin_id)
        if not release or not plugin:
            raise HTTPException(
                status_code=404, detail="Submission resources not found"
            )
        staging_key = release.storage_key
        final_key: str | None = None
        final_object_created = False
        try:
            package = plugin_package_storage.get(release.storage_key)
            self._validate_uploaded_package(release, package)
            parsed, security_report = self._analyze_package(package)
            if parsed.version != release.version:
                raise HTTPException(
                    status_code=422,
                    detail="Manifest version does not match submitted version",
                )
            interface = (
                parsed.interface.model_dump(exclude_none=True)
                if parsed.interface
                else {}
            )
            release.manifest_json = parsed.manifest
            release.interface_json = interface
            release.scan_status = "passed"
            final_key = self._storage_key(plugin.id, release.id, release.sha256)
            if release.storage_key != final_key:
                final_object_created = plugin_package_storage.put_immutable(
                    final_key, package
                )
                release.storage_key = final_key
            staging_report = release.scan_report_json or {}
            requested_visibility = staging_report.get("requestedVisibility")
            pending_access = staging_report.get("pendingAccess")
            scanned_report = self._scan_report(
                parsed,
                security_report,
                provenance={
                    "kind": submission.purpose,
                    "submitterUserId": user_id,
                    "submissionId": submission.id,
                },
            )
            if requested_visibility in {"personal", "workspace", "public"}:
                scanned_report["requestedVisibility"] = requested_visibility
            if isinstance(pending_access, dict):
                scanned_report["pendingAccess"] = pending_access
            release.scan_report_json = scanned_report
            if submission.purpose == "restricted_share":
                plugin.visibility = "personal"
                self._finalize_release(db, plugin=plugin, release=release)
                submission.status = "approved"
                submission.reviewed_at = datetime.now()
                if isinstance(pending_access, dict):
                    self._apply_pending_personal_access(
                        db,
                        plugin=plugin,
                        owner_user_id=user_id,
                        pending_access=pending_access,
                    )
            else:
                if plugin.status != "published":
                    plugin.status = "pending_review"
                    if requested_visibility in {"workspace", "public"}:
                        plugin.visibility = requested_visibility
                submission.status = "pending"
            db.commit()
            if staging_key != final_key:
                try:
                    plugin_package_storage.delete(staging_key)
                except Exception:
                    pass
        except Exception as exc:
            db.rollback()
            if final_object_created and final_key:
                try:
                    plugin_package_storage.delete(final_key)
                except Exception:
                    pass
            failed_submission = db.get(PluginSubmission, submission_id)
            failed_release = db.get(PluginRelease, release_id)
            if failed_submission:
                failed_submission.status = "rejected"
                failed_submission.review_note = str(exc)[:2000]
                failed_submission.reviewed_at = datetime.now()
            if failed_release:
                failed_release.status = "rejected"
                failed_release.scan_status = "failed"
                failed_release.scan_report_json = {"error": str(exc)[:1000]}
            db.commit()
            raise
        db.refresh(submission)
        return self._submission_item(submission)

    def get_submission(
        self, db: Session, *, user_id: int, submission_id: int, is_admin: bool = False
    ) -> PluginSubmissionItem:
        submission = db.get(PluginSubmission, submission_id)
        if not submission or (not is_admin and submission.submitter_user_id != user_id):
            raise HTTPException(status_code=404, detail="Submission not found")
        return self._submission_item(submission)

    def list_submissions(
        self, db: Session, *, status: str | None = None
    ) -> PluginSubmissionListResponse:
        query = db.query(PluginSubmission)
        if status:
            query = query.filter(PluginSubmission.status == status)
        rows = query.order_by(PluginSubmission.submitted_at.desc()).all()
        return PluginSubmissionListResponse(
            items=[self._submission_item(row) for row in rows]
        )

    def review_submission(
        self,
        db: Session,
        *,
        reviewer_user_id: int,
        submission_id: int,
        approved: bool,
        note: str,
    ) -> PluginSubmissionItem:
        submission = (
            db.query(PluginSubmission)
            .filter(PluginSubmission.id == submission_id)
            .with_for_update()
            .first()
        )
        if not submission or submission.status != "pending":
            raise HTTPException(status_code=404, detail="Pending submission not found")
        plugin = db.get(Plugin, submission.plugin_id)
        release = db.get(PluginRelease, submission.release_id)
        if not plugin or not release:
            raise HTTPException(
                status_code=404, detail="Submission resources not found"
            )
        if approved and (
            release.scan_status != "passed" or release.status == "rejected"
        ):
            raise HTTPException(
                status_code=409, detail="Submission release has not passed scanning"
            )
        submission.status = "approved" if approved else "rejected"
        submission.reviewer_user_id = reviewer_user_id
        submission.review_note = (note or "")[:2000]
        submission.reviewed_at = datetime.now()
        if approved:
            requested = self._requested_visibility_for_release(
                release,
                fallback=(
                    "personal"
                    if submission.purpose == "restricted_share"
                    else "workspace"
                ),
            )
            if requested in {"workspace", "public"} and plugin.visibility == "personal":
                self._clear_plugin_grants(db, plugin_id=plugin.id)
                plugin.allow_copy = False
            if requested in {"personal", "workspace", "public"}:
                plugin.visibility = requested
            self._finalize_release(db, plugin=plugin, release=release)
        else:
            release.status = "rejected"
            has_published = (
                db.query(PluginRelease)
                .filter(
                    PluginRelease.plugin_id == plugin.id,
                    PluginRelease.status == "ready",
                )
                .first()
            )
            plugin.status = "published" if has_published else "draft"
        db.commit()
        db.refresh(submission)
        return self._submission_item(submission)

    def _apply_release_listing(self, plugin: Plugin, release: PluginRelease) -> None:
        listing = (release.scan_report_json or {}).get("listing") or {}
        manifest = release.manifest_json or {}
        interface = release.interface_json or {}
        plugin.name = listing.get("name") or manifest.get("name") or plugin.name
        plugin.display_name = (
            listing.get("displayName")
            or interface.get("displayName")
            or plugin.display_name
        )
        description = listing.get("descriptionMd") or manifest.get("description") or ""
        plugin.summary = listing.get("summary") or description[:500]
        plugin.description_md = description[:8192]
        plugin.interface_json = interface

    def _should_promote_latest(
        self, db: Session, plugin: Plugin, release: PluginRelease
    ) -> bool:
        if not plugin.latest_release_id:
            return True
        current = db.get(PluginRelease, plugin.latest_release_id)
        if not current:
            return True
        try:
            return Version(release.version) > Version(current.version)
        except ValueError:
            return release.id >= current.id

    def _publish_release(
        self,
        db: Session,
        *,
        plugin: Plugin,
        package: bytes,
        parsed: PluginUploadInfo,
        security_report: dict[str, Any],
        created_by_user_id: int | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> PublishedRelease:
        """Persist one ready release and clean up its object on transaction failure."""
        if not parsed.version:
            raise HTTPException(status_code=422, detail="Plugin version is required")
        self._validate_version(parsed.version)
        digest = hashlib.sha256(package).hexdigest()
        existing = (
            db.query(PluginRelease)
            .filter(
                PluginRelease.plugin_id == plugin.id,
                PluginRelease.version == parsed.version,
            )
            .with_for_update()
            .first()
        )
        if existing:
            if existing.sha256 != digest:
                raise HTTPException(
                    status_code=409,
                    detail="Plugin version already exists with different content",
                )
            if existing.status == "ready" and existing.scan_status == "passed":
                return PublishedRelease(release=existing, created=False)
            raise HTTPException(
                status_code=409, detail="Plugin version publication is incomplete"
            )

        interface = (
            parsed.interface.model_dump(exclude_none=True) if parsed.interface else {}
        )
        release = PluginRelease(
            plugin_id=plugin.id,
            version=parsed.version,
            manifest_json=parsed.manifest,
            interface_json=interface,
            storage_key="pending",
            sha256=digest,
            size_bytes=len(package),
            status="processing",
            scan_status="passed",
            scan_report_json=self._scan_report(
                parsed,
                security_report,
                provenance=provenance,
            ),
            created_by_user_id=created_by_user_id or 0,
        )
        db.add(release)
        db.flush()
        object_key = self._storage_key(plugin.id, release.id, digest)
        release.storage_key = object_key
        object_created = False
        try:
            object_created = plugin_package_storage.put_immutable(object_key, package)
            plugin.category = str(interface.get("category") or plugin.category or "")
            self._finalize_release(db, plugin=plugin, release=release)
            db.commit()
        except Exception:
            db.rollback()
            if object_created:
                try:
                    plugin_package_storage.delete(object_key)
                except Exception:
                    pass
            raise
        db.refresh(release)
        return PublishedRelease(release=release, created=True)

    def _finalize_release(
        self, db: Session, *, plugin: Plugin, release: PluginRelease
    ) -> None:
        """Apply the shared processing -> ready -> published transition."""
        if release.scan_status != "passed" or release.status == "rejected":
            raise HTTPException(
                status_code=409, detail="Release has not passed package scanning"
            )
        now = datetime.now()
        release.status = "ready"
        if unset_datetime(release.published_at) is None:
            release.published_at = now
        self._apply_release_listing(plugin, release)
        plugin.status = "published"
        if self._should_promote_latest(db, plugin, release):
            plugin.latest_release_id = release.id
        if unset_datetime(plugin.published_at) is None:
            plugin.published_at = now

    def _analyze_package(
        self, package: bytes
    ) -> tuple[PluginUploadInfo, dict[str, Any]]:
        security_report = self._scan_package(package)
        parsed = plugin_package_parser.parse_package(package)
        if not parsed.version:
            raise HTTPException(status_code=422, detail="Plugin version is required")
        self._validate_version(parsed.version)
        return parsed, security_report

    def _scan_report(
        self,
        parsed: PluginUploadInfo,
        security_report: dict[str, Any],
        *,
        provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        report: dict[str, Any] = {
            "components": parsed.components.model_dump(exclude_none=True),
            "listing": {
                "name": parsed.name,
                "displayName": parsed.displayName,
                "summary": parsed.description[:500],
                "descriptionMd": parsed.description,
            },
            "checks": [
                "zip_paths",
                "manifest",
                "checksum",
                "package_size",
                "expanded_size",
                "sensitive_files",
            ],
            **security_report,
        }
        if provenance:
            report["provenance"] = provenance
        return report

    def create_upstream(
        self, db: Session, *, request: PluginUpstreamCreateRequest
    ) -> PluginUpstreamItem:
        self._validate_slug(request.slug)
        if request.upstreamUrl.strip():
            try:
                validate_upstream_url(request.upstreamUrl)
            except UpstreamFetchError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        if db.query(Plugin).filter(Plugin.slug == request.slug).first():
            raise HTTPException(status_code=409, detail="Plugin slug already exists")
        plugin = Plugin(
            slug=request.slug,
            name=request.slug,
            display_name=request.displayName,
            listing_type=request.listingType,
            source_type="mirror",
            source_provider="codex",
            keywords_json=[],
            interface_json={},
            visibility="workspace",
            status="draft",
        )
        db.add(plugin)
        db.flush()
        upstream = PluginUpstream(
            plugin_id=plugin.id,
            provider="codex",
            marketplace_name=request.marketplaceName,
            remote_plugin_id=request.remotePluginId,
            upstream_url=request.upstreamUrl,
            license_info=request.licenseInfo,
            sync_enabled=True,
            sync_policy=request.syncPolicy,
        )
        db.add(upstream)
        db.commit()
        db.refresh(upstream)
        return self._upstream_item(upstream)

    def update_upstream_policy(
        self,
        db: Session,
        *,
        upstream_id: int,
        sync_policy: str,
    ) -> PluginUpstreamItem:
        if sync_policy not in {"auto_after_scan", "review_required"}:
            raise HTTPException(status_code=422, detail="Invalid upstream sync policy")
        upstream = db.get(PluginUpstream, upstream_id)
        if not upstream:
            raise HTTPException(status_code=404, detail="Plugin upstream not found")
        upstream.sync_policy = sync_policy
        db.commit()
        db.refresh(upstream)
        return self._upstream_item(upstream)

    def configure_controlled_upstream(
        self,
        db: Session,
        *,
        slug: str,
        display_name: str,
        marketplace_name: str,
        remote_plugin_id: str,
        upstream_url: str,
        license_info: str,
        listing_type: str = "plugin",
        visibility: str = "workspace",
        sync_policy: str = "auto_after_scan",
    ) -> PluginUpstreamItem:
        """Create or update a controlled mirror without a repository snapshot."""
        self._validate_slug(slug)
        validate_upstream_url(upstream_url)
        if listing_type not in {"plugin", "skill"}:
            raise HTTPException(status_code=422, detail="Invalid plugin listing type")
        if visibility not in {"workspace", "public"}:
            raise HTTPException(status_code=422, detail="Invalid plugin visibility")
        if sync_policy not in {"auto_after_scan", "review_required"}:
            raise HTTPException(status_code=422, detail="Invalid upstream sync policy")
        plugin = db.query(Plugin).filter(Plugin.slug == slug).with_for_update().first()
        if not plugin:
            plugin = Plugin(
                slug=slug,
                name=remote_plugin_id,
                display_name=display_name,
                listing_type=listing_type,
                source_type="mirror",
                source_provider="wework",
                owner_user_id=0,
                keywords_json=[],
                interface_json={},
                visibility=visibility,
                status="draft",
            )
            db.add(plugin)
            db.flush()
        else:
            # Accept legacy Codex-labeled mirrors so re-bootstrap can reclassify
            # them as Wework domestic-public adaptations.
            controlled_sources = {
                ("native", "wework"),
                ("mirror", "wework"),
                ("mirror", "codex"),
            }
            if (
                plugin.owner_user_id != 0
                or (plugin.source_type, plugin.source_provider)
                not in controlled_sources
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Plugin slug is owned by a different publisher",
                )
            if plugin.listing_type != listing_type:
                raise HTTPException(
                    status_code=409,
                    detail="Plugin listing type cannot be changed",
                )

        # Publish identity is Wework domestic public; upstream fetch still uses
        # the Codex/OpenAI marketplace coordinates below.
        plugin.source_type = "mirror"
        plugin.source_provider = "wework"
        plugin.name = remote_plugin_id
        plugin.display_name = display_name
        plugin.visibility = visibility
        upstream = (
            db.query(PluginUpstream)
            .filter(PluginUpstream.plugin_id == plugin.id)
            .with_for_update()
            .first()
        )
        if not upstream:
            upstream = PluginUpstream(plugin_id=plugin.id)
            db.add(upstream)
        upstream.provider = "codex"
        upstream.marketplace_name = marketplace_name
        upstream.remote_plugin_id = remote_plugin_id
        upstream.upstream_url = upstream_url
        upstream.license_info = license_info
        upstream.sync_enabled = True
        upstream.sync_policy = sync_policy
        db.commit()
        db.refresh(upstream)
        return self._upstream_item(upstream)

    def list_upstreams(self, db: Session) -> PluginUpstreamListResponse:
        rows = db.query(PluginUpstream).order_by(PluginUpstream.id.desc()).all()
        return PluginUpstreamListResponse(
            items=[self._upstream_item(row) for row in rows]
        )

    def sync_upstream(self, db: Session, *, upstream_id: int) -> PluginUpstreamItem:
        upstream = db.get(PluginUpstream, upstream_id)
        if not upstream or not upstream.sync_enabled:
            raise HTTPException(status_code=404, detail="Enabled upstream not found")
        upstream.last_checked_at = datetime.now()
        try:
            package = fetch_upstream_package(upstream.upstream_url)
            self._scan_package(package)
            package = self._select_upstream_plugin_package(
                package, upstream.remote_plugin_id
            )
            adapted = adapt_upstream_package(
                provider=upstream.provider,
                marketplace_name=upstream.marketplace_name,
                remote_plugin_id=upstream.remote_plugin_id,
                package=package,
            )
            package = adapted.package
            parsed = plugin_package_parser.parse_package(package)
            version = parsed.version
            if not version:
                raise ValueError("Upstream plugin version is required")
            self._validate_version(version)
            if parsed.name != upstream.remote_plugin_id:
                raise ValueError(
                    "Upstream package does not contain the selected plugin"
                )
            upstream.last_seen_version = version
            existing = (
                db.query(PluginRelease)
                .filter(
                    PluginRelease.plugin_id == upstream.plugin_id,
                    PluginRelease.version == version,
                )
                .first()
            )
            plugin = db.get(Plugin, upstream.plugin_id)
            latest = (
                db.get(PluginRelease, plugin.latest_release_id)
                if plugin and plugin.latest_release_id
                else None
            )
            is_newer = not latest or Version(version) > Version(latest.version)
            if existing:
                self._verify_existing_upstream_release(existing, package)
                if upstream.sync_policy == "auto_after_scan" and is_newer:
                    self._publish_staged_mirrored_release(db, plugin, existing)
            elif is_newer:
                if upstream.sync_policy == "review_required":
                    self._stage_mirrored_release(
                        db,
                        upstream,
                        parsed,
                        package,
                        adapted=adapted,
                    )
                else:
                    self._publish_mirrored_release(
                        db,
                        upstream,
                        parsed,
                        package,
                        adapted=adapted,
                    )
            upstream.last_synced_at = datetime.now()
            upstream.last_error = ""
            db.commit()
        except Exception as exc:
            db.rollback()
            failed = db.get(PluginUpstream, upstream_id)
            if failed:
                failed.last_checked_at = datetime.now()
                failed.last_error = str(exc)[:1000]
                db.commit()
            raise
        db.refresh(upstream)
        return self._upstream_item(upstream)

    def sync_enabled_upstreams(self, db: Session) -> list[PluginUpstreamItem]:
        upstreams: Iterable[PluginUpstream] = (
            db.query(PluginUpstream).filter(PluginUpstream.sync_enabled).all()
        )
        results: list[PluginUpstreamItem] = []
        for upstream in upstreams:
            try:
                results.append(self.sync_upstream(db, upstream_id=upstream.id))
            except Exception:
                db.rollback()
        return results

    def _publish_staged_mirrored_release(
        self,
        db: Session,
        plugin: Plugin | None,
        release: PluginRelease,
    ) -> None:
        """Publish a pending mirror after its policy changes to automatic."""
        if release.status == "ready":
            return
        if not plugin or release.status != "processing":
            return
        submission = (
            db.query(PluginSubmission)
            .filter(
                PluginSubmission.release_id == release.id,
                PluginSubmission.status == "pending",
            )
            .with_for_update()
            .first()
        )
        if not submission:
            raise ValueError("Pending mirrored release has no review submission")
        submission.status = "approved"
        submission.review_note = "Automatically published after scan policy change"
        submission.reviewed_at = datetime.now()
        self._finalize_release(db, plugin=plugin, release=release)

    def _publish_mirrored_release(
        self,
        db,
        upstream,
        parsed,
        package: bytes,
        *,
        adapted: AdaptedUpstreamPackage,
    ) -> None:
        plugin = db.get(Plugin, upstream.plugin_id)
        if not plugin:
            raise ValueError("Upstream plugin identity is missing")
        security_report = self._scan_package(package)
        self._publish_release(
            db,
            plugin=plugin,
            package=package,
            parsed=parsed,
            security_report=security_report,
            provenance=self._upstream_provenance(upstream, adapted),
        )

    def _stage_mirrored_release(
        self,
        db: Session,
        upstream: PluginUpstream,
        parsed: PluginUploadInfo,
        package: bytes,
        *,
        adapted: AdaptedUpstreamPackage,
    ) -> None:
        """Store a scanned mirror candidate without changing the catalog latest."""
        plugin = db.get(Plugin, upstream.plugin_id)
        if not plugin or not parsed.version:
            raise ValueError("Upstream plugin identity or version is missing")
        security_report = self._scan_package(package)
        digest = hashlib.sha256(package).hexdigest()
        interface = (
            parsed.interface.model_dump(exclude_none=True) if parsed.interface else {}
        )
        release = PluginRelease(
            plugin_id=plugin.id,
            version=parsed.version,
            manifest_json=parsed.manifest,
            interface_json=interface,
            storage_key="pending",
            sha256=digest,
            size_bytes=len(package),
            status="processing",
            scan_status="passed",
            scan_report_json=self._scan_report(
                parsed,
                security_report,
                provenance=self._upstream_provenance(upstream, adapted),
            ),
        )
        db.add(release)
        db.flush()
        object_key = self._storage_key(plugin.id, release.id, digest)
        release.storage_key = object_key
        object_created = False
        try:
            object_created = plugin_package_storage.put_immutable(object_key, package)
            db.add(
                PluginSubmission(
                    plugin_id=plugin.id,
                    release_id=release.id,
                    submitter_user_id=0,
                    status="pending",
                )
            )
            if plugin.status != "published":
                plugin.status = "pending_review"
            db.flush()
        except Exception:
            db.rollback()
            if object_created:
                try:
                    plugin_package_storage.delete(object_key)
                except Exception:
                    pass
            raise

    def _upstream_provenance(
        self,
        upstream: PluginUpstream,
        adapted: AdaptedUpstreamPackage,
    ) -> dict[str, Any]:
        return {
            "kind": "upstream",
            "provider": upstream.provider,
            "marketplace": upstream.marketplace_name,
            "remotePluginId": upstream.remote_plugin_id,
            "upstreamUrl": upstream.upstream_url,
            **(
                {
                    "adapter": adapted.adapter,
                    "adapterVersion": adapted.adapter_version,
                    "upstreamVersion": adapted.upstream_version,
                }
                if adapted.adapter
                else {}
            ),
        }

    def _verify_existing_upstream_release(
        self, release: PluginRelease, package: bytes
    ) -> None:
        """Reject mutable upstream content published under an existing version."""
        if release.sha256 == hashlib.sha256(package).hexdigest():
            return
        existing_package = plugin_package_storage.get(release.storage_key)
        ignored_paths = {"UPSTREAM.md", "upstream.lock.json"}
        if self._package_tree_digest(
            existing_package, ignored_paths=ignored_paths
        ) != self._package_tree_digest(package, ignored_paths=ignored_paths):
            raise ValueError(
                f"Upstream version {release.version} changed content without "
                "a version bump"
            )

    def _package_tree_digest(self, package: bytes, *, ignored_paths: set[str]) -> str:
        digest = hashlib.sha256()
        with zipfile.ZipFile(BytesIO(package)) as archive:
            for member in sorted(archive.infolist(), key=lambda item: item.filename):
                if member.is_dir() or member.filename in ignored_paths:
                    continue
                digest.update(member.filename.encode("utf-8"))
                digest.update(b"\0")
                content = archive.read(member)
                if member.filename.endswith(".py"):
                    try:
                        content = ast.dump(
                            ast.parse(content.decode("utf-8")),
                            include_attributes=False,
                        ).encode("utf-8")
                    except (SyntaxError, UnicodeDecodeError):
                        pass
                digest.update(content)
                digest.update(b"\0")
        return digest.hexdigest()

    def _select_upstream_plugin_package(
        self, package: bytes, remote_plugin_id: str
    ) -> bytes:
        """Extract the selected plugin from a multi-plugin Codex marketplace ZIP."""
        try:
            with zipfile.ZipFile(BytesIO(package)) as archive:
                candidates: list[tuple[str, str]] = []
                for name in archive.namelist():
                    for manifest_path in (
                        ".codex-plugin/plugin.json",
                        ".claude-plugin/plugin.json",
                    ):
                        if not name.endswith(manifest_path):
                            continue
                        try:
                            manifest = json.loads(archive.read(name).decode("utf-8"))
                        except (KeyError, UnicodeDecodeError, json.JSONDecodeError):
                            continue
                        plugin_name = str(manifest.get("name") or "")
                        if plugin_name == remote_plugin_id:
                            candidates.append((name[: -len(manifest_path)], name))
                if not candidates:
                    return package
                root, _ = sorted(candidates, key=lambda item: len(item[0]))[0]
                output = BytesIO()
                with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as selected:
                    for member in archive.infolist():
                        if member.is_dir() or not member.filename.startswith(root):
                            continue
                        relative = member.filename[len(root) :]
                        if relative:
                            copied = zipfile.ZipInfo(relative, member.date_time)
                            copied.create_system = member.create_system
                            copied.external_attr = member.external_attr
                            copied.internal_attr = member.internal_attr
                            copied.flag_bits = member.flag_bits
                            copied.compress_type = zipfile.ZIP_DEFLATED
                            selected.writestr(copied, archive.read(member))
                return output.getvalue()
        except zipfile.BadZipFile:
            return package

    def _to_marketplace_item(
        self,
        db,
        plugin,
        release,
        *,
        user_id: int | None,
        device_id: str | None = None,
        installed: Kind | None = None,
        owner: User | None = None,
        grants: list[ResourceMember] | None = None,
        device_row: PluginDeviceInstallation | None = None,
        resolve_package_assets: bool = True,
    ):
        if installed is None and user_id is not None:
            installed = self._find_installed(db, user_id=user_id, plugin_id=plugin.id)
        installed_spec = installed.json.get("spec", {}) if installed else {}
        if device_row is None and installed and device_id:
            device_row = self._device_installation(db, installed.id, device_id)
        installed_for_device = bool(
            installed
            and installed.is_active
            and (
                not device_id
                or self._device_has_release(
                    device_row,
                    installed_spec.get("releaseId"),
                )
            )
        )
        source_provider = self._source_provider(plugin)
        scan_report = release.scan_report_json or {}
        if grants is None:
            grants = self._plugin_grants(db, plugin.id)
        if owner is None and plugin.owner_user_id:
            owner = db.get(User, plugin.owner_user_id)
        access_role = (
            "owner"
            if user_id is not None and plugin.owner_user_id == user_id
            else "recipient" if plugin.visibility == "personal" else "catalog"
        )
        return PluginMarketplaceItem(
            id=plugin.id,
            remotePluginId=f"wegent~Plugin_{plugin.id}",
            name=plugin.name,
            displayName=plugin.display_name,
            description=plugin.summary or plugin.description_md,
            version=release.version,
            author=None,
            visibility=plugin.visibility,
            featured=is_featured_rank(plugin.featured_rank),
            installed=installed_for_device,
            installedPluginId=(
                installed.id if installed and installed.is_active else None
            ),
            enabled=(
                bool(installed_spec.get("enabled")) if installed_for_device else False
            ),
            interface=self._marketplace_interface(
                release,
                plugin,
                resolve_package_assets=resolve_package_assets,
            ),
            components=scan_report.get("components") or {},
            manifest=release.manifest_json or {},
            ownerUserId=plugin.owner_user_id or 0,
            ownerDisplayName=owner.user_name if owner else "",
            accessRole=access_role,
            allowCopy=bool(plugin.allow_copy),
            grantUserCount=sum(grant.entity_type == "user" for grant in grants),
            grantNamespaceCount=sum(
                grant.entity_type == "namespace" for grant in grants
            ),
            latestReleaseId=release.id,
            listingType=plugin.listing_type,
            sourceProvider=source_provider,
            sourceLabel=self._source_label(plugin),
            updateAvailable=bool(
                installed_for_device and installed_spec.get("releaseId") != release.id
            ),
            currentDeviceInstallation=(
                self._device_installation_item(device_row) if device_row else None
            ),
        )

    def _marketplace_interface(
        self,
        release: PluginRelease,
        plugin: Plugin,
        *,
        resolve_package_assets: bool = True,
    ) -> dict[str, Any] | None:
        interface = release.interface_json or plugin.interface_json or {}
        asset_values = (
            interface.get("composerIcon"),
            interface.get("logo"),
            interface.get("logoDark"),
        )
        if not any(
            isinstance(value, str) and value.startswith(("./", "assets/"))
            for value in asset_values
        ):
            return interface or None
        if not resolve_package_assets:
            # List path must stay light; detail views can resolve package assets.
            return interface or None
        cache_key = release.sha256 or release.storage_key
        cached = self._resolved_interface_cache.get(cache_key)
        if cached is not None:
            self._resolved_interface_cache.move_to_end(cache_key)
            return cached
        try:
            package = plugin_package_storage.get(release.storage_key)
            resolved = plugin_package_parser.resolve_interface_assets(
                package,
                interface,
            )
        except (PluginPackageStorageError, HTTPException, ValueError):
            return interface or None
        self._resolved_interface_cache[cache_key] = resolved
        self._resolved_interface_cache.move_to_end(cache_key)
        while (
            len(self._resolved_interface_cache) > MAX_RESOLVED_INTERFACE_CACHE_ENTRIES
        ):
            self._resolved_interface_cache.popitem(last=False)
        return resolved or None

    def _installed_item_id(self, item: InstalledPlugin) -> int | None:
        value = (item.metadata.get("labels") or {}).get("id")
        return int(value) if str(value).isdigit() else None

    def _device_installation(
        self,
        db: Session,
        installed_kind_id: int,
        device_id: str,
    ) -> PluginDeviceInstallation | None:
        return (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id == installed_kind_id,
                PluginDeviceInstallation.device_id == device_id,
            )
            .first()
        )

    def _device_has_release(
        self,
        row: PluginDeviceInstallation | None,
        release_id: object,
    ) -> bool:
        return bool(
            row
            and isinstance(release_id, int)
            and row.state == "installed"
            and row.actual_release_id == release_id
        )

    def _device_installation_item(
        self, row: PluginDeviceInstallation
    ) -> PluginDeviceInstallationItem:
        return PluginDeviceInstallationItem(
            deviceId=row.device_id,
            desiredReleaseId=row.desired_release_id,
            actualReleaseId=unset_id(row.actual_release_id),
            state=row.state,
            errorCode=unset_str(row.error_code),
            errorMessage=unset_str(row.error_message),
            attemptCount=row.attempt_count,
            lastSyncAt=unset_datetime(row.last_sync_at),
            updatedAt=row.updated_at,
        )

    def _installed_payload(self, plugin: Plugin, release: PluginRelease) -> dict:
        components = (release.scan_report_json or {}).get("components") or {}
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": self._kind_name(plugin.slug), "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "providerKey": "wegent-market",
                    "pluginKey": plugin.name,
                    "catalogItemId": str(plugin.id),
                    "marketplace": marketplace_name_for_visibility(plugin.visibility),
                },
                "origin": "market",
                "pluginId": plugin.id,
                "releaseId": release.id,
                "desiredVersion": release.version,
                "updatePolicy": "manual",
                "sourceProvider": self._source_provider(plugin),
                "sourceLabel": self._source_label(plugin),
                "visibility": plugin.visibility,
                "displayName": plugin.display_name,
                "description": plugin.summary or plugin.description_md,
                "version": release.version,
                "installState": "installed",
                "enabled": True,
                "componentStates": self._component_states(components),
                "manifest": release.manifest_json,
                "components": components,
                "interface": release.interface_json or None,
                "packageRef": {
                    "storageKey": release.storage_key,
                    "checksum": f"sha256:{release.sha256}",
                    "sizeBytes": release.size_bytes,
                },
                "sourcePayload": {"releaseId": release.id},
            },
            "status": {"state": "PendingSync"},
        }

    def _installable_release(self, db, plugin, release_id):
        selected_id = release_id or plugin.latest_release_id
        release = db.get(PluginRelease, selected_id) if selected_id else None
        if (
            not release
            or release.plugin_id != plugin.id
            or release.status != "ready"
            or release.scan_status != "passed"
        ):
            raise HTTPException(status_code=404, detail="Installable release not found")
        return release

    def _latest_release(self, db, plugin):
        if not plugin.latest_release_id:
            return None
        release = db.get(PluginRelease, plugin.latest_release_id)
        if not release or release.status != "ready" or release.scan_status != "passed":
            return None
        return release

    def _published_plugin(self, db, plugin_id, *, user_id: int | None = None):
        plugin = db.get(Plugin, plugin_id)
        if (
            not plugin
            or plugin.status != "published"
            or plugin.visibility not in {"personal", "workspace", "public"}
        ):
            raise HTTPException(status_code=404, detail="Marketplace plugin not found")
        if user_id is not None and not self._can_access_plugin(
            db, plugin=plugin, user_id=user_id
        ):
            raise HTTPException(status_code=404, detail="Marketplace plugin not found")
        return plugin

    def _can_access_plugin(
        self, db: Session, *, plugin: Plugin, user_id: int | None
    ) -> bool:
        """Apply optional direct-user or department grants to workspace plugins.

        Args:
            db: Database session
            plugin: Plugin to check access for
            user_id: User ID, or None for unauthenticated access

        Returns:
            True if user can access plugin, False otherwise

        Notes:
            - Public plugins are accessible to everyone (including unauthenticated users)
            - Owner can always access their own plugins
            - Workspace plugins with no user_id return False (require authentication)
        """
        # Public plugins are accessible to everyone
        if plugin.visibility == "public":
            return True

        # Unauthenticated users can only access public plugins
        if user_id is None:
            return False

        # Owner can always access their own plugins
        if plugin.owner_user_id == user_id:
            return True
        plugin_type_values = (ResourceType.PLUGIN.value, ResourceType.PLUGIN.name)
        approved_values = (MemberStatus.APPROVED.value, MemberStatus.APPROVED.name)
        grants = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(plugin_type_values),
                ResourceMember.resource_id == plugin.id,
                ResourceMember.status.in_(approved_values),
            )
            .all()
        )
        if not grants:
            return plugin.visibility == "workspace"
        if any(
            grant.entity_type == "user" and grant.entity_id == str(user_id)
            for grant in grants
        ):
            return True
        granted_namespace_ids = {
            grant.entity_id for grant in grants if grant.entity_type == "namespace"
        }
        if not granted_namespace_ids:
            return False
        user_namespaces = (
            db.query(Namespace.id, Namespace.name)
            .join(
                ResourceMember,
                and_(
                    ResourceMember.resource_type == "Namespace",
                    ResourceMember.resource_id == Namespace.id,
                ),
            )
            .filter(
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_values),
                Namespace.is_active.is_(True),
            )
            .all()
        )
        direct_ids = {str(row.id) for row in user_namespaces}
        if direct_ids & granted_namespace_ids:
            return True
        user_namespace_names = [row.name for row in user_namespaces]
        if not user_namespace_names:
            return False
        granted_names = [
            row.name
            for row in db.query(Namespace.name)
            .filter(
                Namespace.id.in_(
                    int(namespace_id)
                    for namespace_id in granted_namespace_ids
                    if namespace_id.isdigit()
                ),
                Namespace.is_active.is_(True),
            )
            .all()
        ]
        return any(
            member_name == granted_name or member_name.startswith(f"{granted_name}/")
            for member_name in user_namespace_names
            for granted_name in granted_names
        )

    def get_plugin_access(
        self, db: Session, *, plugin_id: int, user_id: int
    ) -> PluginAccessResponse:
        plugin = self._owned_plugin(db, plugin_id=plugin_id, user_id=user_id)
        targets = [
            PluginAccessTarget(
                entityType=grant.entity_type,
                entityId=grant.entity_id,
                displayName=grant.entity_display_name,
            )
            for grant in self._plugin_grants(db, plugin.id)
        ]
        return PluginAccessResponse(
            pluginId=plugin.id,
            scope="restricted" if targets else "private",
            targets=targets,
            allowCopy=bool(plugin.allow_copy and targets),
        )

    def _clear_plugin_grants(self, db: Session, *, plugin_id: int) -> None:
        (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.PLUGIN.value, ResourceType.PLUGIN.name)
                ),
                ResourceMember.resource_id == plugin_id,
            )
            .delete(synchronize_session=False)
        )

    def _apply_pending_personal_access(
        self,
        db: Session,
        *,
        plugin: Plugin,
        owner_user_id: int,
        pending_access: dict,
    ) -> None:
        raw_targets = pending_access.get("targets") or []
        if not isinstance(raw_targets, list) or not raw_targets:
            plugin.allow_copy = False
            return
        targets = self._validated_access_targets(
            db,
            owner_user_id=owner_user_id,
            targets=[
                PluginAccessTarget.model_validate(item)
                for item in raw_targets
                if isinstance(item, dict)
            ],
        )
        self._clear_plugin_grants(db, plugin_id=plugin.id)
        for target in targets:
            db.add(
                ResourceMember.create(
                    resource_type=ResourceType.PLUGIN.value,
                    resource_id=plugin.id,
                    entity_type=target.entityType,
                    entity_id=target.entityId,
                    entity_display_name=target.displayName,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=owner_user_id,
                    reviewed_by_user_id=owner_user_id,
                    reviewed_at=datetime.now(),
                )
            )
        plugin.visibility = "personal"
        plugin.allow_copy = bool(pending_access.get("allowCopy") and targets)

    def update_plugin_access(
        self,
        db: Session,
        *,
        plugin_id: int,
        user_id: int,
        request: PluginAccessUpdateRequest,
    ) -> tuple[PluginAccessResponse, list[tuple[int, int]]]:
        plugin = self._owned_plugin(db, plugin_id=plugin_id, user_id=user_id)
        requested_targets = request.targets if request.scope == "restricted" else []
        targets = self._validated_access_targets(
            db,
            owner_user_id=user_id,
            targets=requested_targets,
        )
        if request.scope == "restricted" and not targets:
            raise HTTPException(
                status_code=422,
                detail="Restricted sharing requires at least one member or department",
            )

        recipient_installs = self._recipient_installations(
            db,
            plugin_id=plugin.id,
            owner_user_id=user_id,
        )
        (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.PLUGIN.value, ResourceType.PLUGIN.name)
                ),
                ResourceMember.resource_id == plugin.id,
            )
            .delete(synchronize_session=False)
        )
        for target in targets:
            db.add(
                ResourceMember.create(
                    resource_type=ResourceType.PLUGIN.value,
                    resource_id=plugin.id,
                    entity_type=target.entityType,
                    entity_id=target.entityId,
                    entity_display_name=target.displayName,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=user_id,
                    reviewed_by_user_id=user_id,
                    reviewed_at=datetime.now(),
                )
            )
        plugin.visibility = "personal"
        plugin.allow_copy = bool(request.allowCopy and targets)
        db.flush()
        revoked = [
            (recipient_user_id, installed_id)
            for recipient_user_id, installed_id in recipient_installs
            if not self._can_access_plugin(
                db,
                plugin=plugin,
                user_id=recipient_user_id,
            )
        ]
        self._deactivate_revoked_installations(db, revoked)
        db.commit()
        return (
            self.get_plugin_access(db, plugin_id=plugin.id, user_id=user_id),
            revoked,
        )

    def _deactivate_revoked_installations(
        self,
        db: Session,
        revoked: list[tuple[int, int]],
    ) -> None:
        if not revoked:
            return
        revoked_ids = {installed_id for _, installed_id in revoked}
        rows = (
            db.query(Kind)
            .filter(
                Kind.id.in_(revoked_ids),
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .all()
        )
        for row in rows:
            spec = dict(row.json.get("spec", {}))
            spec["enabled"] = False
            spec["installState"] = "uninstalled"
            row.json["spec"] = spec
            row.is_active = False
            flag_modified(row, "json")

    def plugin_copy_descriptor(
        self, db: Session, *, plugin_id: int, user_id: int
    ) -> PluginCopyResponse:
        plugin = self._published_plugin(db, plugin_id, user_id=user_id)
        if plugin.owner_user_id == user_id:
            raise HTTPException(
                status_code=409,
                detail="Owners already have the source plugin",
            )
        if not plugin.allow_copy:
            raise HTTPException(status_code=403, detail="Plugin copying is not allowed")
        release = self._latest_release(db, plugin)
        if not release:
            raise HTTPException(status_code=404, detail="Plugin release not found")
        download_url, expires_at = plugin_package_storage.presign_download(
            release.storage_key
        )
        return PluginCopyResponse(
            sourcePluginId=plugin.id,
            sourceReleaseId=release.id,
            sourcePluginName=plugin.name,
            sourceDisplayName=plugin.display_name,
            version=release.version,
            sha256=release.sha256,
            downloadUrl=download_url,
            expiresAt=expires_at,
        )

    def _owned_plugin(self, db: Session, *, plugin_id: int, user_id: int) -> Plugin:
        plugin = db.get(Plugin, plugin_id)
        if not plugin or plugin.owner_user_id != user_id:
            raise HTTPException(status_code=404, detail="Owned plugin not found")
        if plugin.status != "published" or plugin.visibility != "personal":
            raise HTTPException(status_code=409, detail="Plugin is not shareable")
        return plugin

    def _plugin_grants(self, db: Session, plugin_id: int) -> list[ResourceMember]:
        return (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.PLUGIN.value, ResourceType.PLUGIN.name)
                ),
                ResourceMember.resource_id == plugin_id,
                ResourceMember.status.in_(
                    (MemberStatus.APPROVED.value, MemberStatus.APPROVED.name)
                ),
            )
            .order_by(ResourceMember.entity_type, ResourceMember.entity_display_name)
            .all()
        )

    def _validated_access_targets(
        self,
        db: Session,
        *,
        owner_user_id: int,
        targets: list[PluginAccessTarget],
    ) -> list[PluginAccessTarget]:
        normalized: list[PluginAccessTarget] = []
        seen: set[tuple[str, str]] = set()
        for target in targets:
            key = (target.entityType, target.entityId)
            if key in seen:
                continue
            seen.add(key)
            if target.entityType == "user":
                if target.entityId == str(owner_user_id):
                    continue
                user = (
                    db.get(User, int(target.entityId))
                    if target.entityId.isdigit()
                    else None
                )
                if not user or not user.is_active:
                    raise HTTPException(
                        status_code=422,
                        detail="Invalid plugin share user",
                    )
                normalized.append(
                    PluginAccessTarget(
                        entityType="user",
                        entityId=str(user.id),
                        displayName=user.user_name,
                    )
                )
                continue
            namespace = (
                db.get(Namespace, int(target.entityId))
                if target.entityId.isdigit()
                else None
            )
            if not namespace or not namespace.is_active:
                raise HTTPException(
                    status_code=422,
                    detail="Invalid plugin share department",
                )
            if not self._can_select_namespace(
                db,
                namespace=namespace,
                user_id=owner_user_id,
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Department is not accessible",
                )
            normalized.append(
                PluginAccessTarget(
                    entityType="namespace",
                    entityId=str(namespace.id),
                    displayName=namespace.display_name or namespace.name,
                )
            )
        return normalized

    def _can_select_namespace(
        self, db: Session, *, namespace: Namespace, user_id: int
    ) -> bool:
        if namespace.owner_user_id == user_id:
            return True
        return (
            db.query(ResourceMember.id)
            .filter(
                ResourceMember.resource_type.in_(("Namespace", "NAMESPACE")),
                ResourceMember.resource_id == namespace.id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(
                    (MemberStatus.APPROVED.value, MemberStatus.APPROVED.name)
                ),
            )
            .first()
            is not None
        )

    def _recipient_installations(
        self, db: Session, *, plugin_id: int, owner_user_id: int
    ) -> list[tuple[int, int]]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.user_id != owner_user_id,
                Kind.is_active.is_(True),
            )
            .all()
        )
        return [
            (row.user_id, row.id)
            for row in rows
            if (row.json.get("spec", {}) if isinstance(row.json, dict) else {}).get(
                "pluginId"
            )
            == plugin_id
        ]

    def grant_plugin_visibility(
        self,
        db: Session,
        *,
        plugin_id: int,
        entity_type: str,
        entity_id: str,
    ) -> None:
        plugin = db.get(Plugin, plugin_id)
        if not plugin:
            raise HTTPException(status_code=404, detail="Plugin not found")
        approved = MemberStatus.APPROVED.value
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.PLUGIN.value,
                ResourceMember.resource_id == plugin_id,
                ResourceMember.entity_type == entity_type,
                ResourceMember.entity_id == entity_id,
            )
            .first()
        )
        if member:
            member.status = approved
        else:
            db.add(
                ResourceMember(
                    resource_type=ResourceType.PLUGIN.value,
                    resource_id=plugin_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    status=approved,
                )
            )
        db.commit()

    def _load_installed_kinds_by_plugin_id(
        self, db: Session, *, user_id: int
    ) -> dict[int, Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
            )
            .all()
        )
        by_plugin_id: dict[int, list[Kind]] = {}
        for row in rows:
            spec = row.json.get("spec", {}) if isinstance(row.json, dict) else {}
            plugin_id = spec.get("pluginId")
            if not isinstance(plugin_id, int):
                source = spec.get("source") or {}
                catalog_item_id = source.get("catalogItemId")
                if isinstance(catalog_item_id, str) and catalog_item_id.isdigit():
                    plugin_id = int(catalog_item_id)
                else:
                    continue
            by_plugin_id.setdefault(plugin_id, []).append(row)
        selected: dict[int, Kind] = {}
        for plugin_id, matches in by_plugin_id.items():
            active = [row for row in matches if row.is_active]
            selected[plugin_id] = active[0] if active else matches[0]
        return selected

    def _load_grants_by_plugin_ids(
        self, db: Session, plugin_ids: list[int]
    ) -> dict[int, list[ResourceMember]]:
        if not plugin_ids:
            return {}
        rows = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.PLUGIN.value, ResourceType.PLUGIN.name)
                ),
                ResourceMember.resource_id.in_(plugin_ids),
                ResourceMember.status.in_(
                    (MemberStatus.APPROVED.value, MemberStatus.APPROVED.name)
                ),
            )
            .order_by(ResourceMember.entity_type, ResourceMember.entity_display_name)
            .all()
        )
        grouped: dict[int, list[ResourceMember]] = {}
        for row in rows:
            grouped.setdefault(row.resource_id, []).append(row)
        return grouped

    def _find_installed(self, db, *, user_id, plugin_id):
        return self._load_installed_kinds_by_plugin_id(db, user_id=user_id).get(
            plugin_id
        )

    def _published_plugin_by_key(self, db: Session, plugin_key: str) -> Plugin | None:
        normalized = plugin_key.strip()
        if not normalized:
            return None
        plugin = (
            db.query(Plugin)
            .filter(Plugin.status == "published", Plugin.name == normalized)
            .first()
        )
        if plugin:
            return plugin
        return (
            db.query(Plugin)
            .filter(Plugin.status == "published", Plugin.slug == normalized)
            .first()
        )

    def _installed_kind_catalog_score(
        self, db: Session, row: Kind
    ) -> tuple[int, int, int]:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
        source = spec.get("source") if isinstance(spec.get("source"), dict) else {}
        plugin_key = str(source.get("pluginKey") or "").strip().lower()
        plugin_id = spec.get("pluginId")
        release_id = spec.get("releaseId")
        plugin = db.get(Plugin, plugin_id) if plugin_id else None
        release = db.get(PluginRelease, release_id) if release_id else None
        key_ok = bool(
            plugin
            and plugin_key
            and plugin_key in {plugin.name.lower(), (plugin.slug or "").lower()}
        )
        release_ok = bool(release and plugin and release.plugin_id == plugin.id)
        return (1 if key_ok else 0, 1 if release_ok else 0, row.id)

    def _reconcile_installed_kind_catalog_ref(
        self, db: Session, *, row: Kind, plugin_key: str
    ) -> bool:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
        source = spec.get("source") if isinstance(spec.get("source"), dict) else {}
        plugin_id = spec.get("pluginId")
        release_id = spec.get("releaseId")
        plugin = db.get(Plugin, plugin_id) if plugin_id else None
        release = db.get(PluginRelease, release_id) if release_id else None
        matched = self._published_plugin_by_key(db, plugin_key)
        key_mismatch = bool(
            plugin
            and plugin_key.lower()
            not in {plugin.name.lower(), (plugin.slug or "").lower()}
        )
        release_missing = bool(release_id and release is None)
        plugin_missing = bool(plugin_id and plugin is None)
        release_wrong = bool(
            matched and release is not None and release.plugin_id != matched.id
        )
        needs_repair = (
            key_mismatch or release_missing or plugin_missing or release_wrong
        )
        if matched:
            target_release = self._latest_release(db, matched)
            if release and release.plugin_id == matched.id:
                target_release = release
            if not target_release:
                return False
            expected_marketplace = marketplace_name_for_visibility(matched.visibility)
            if (
                not needs_repair
                and plugin_id == matched.id
                and release_id == target_release.id
                and str(source.get("catalogItemId") or "") == str(matched.id)
                and str(source.get("marketplace") or "") == expected_marketplace
            ):
                return False
            self._apply_catalog_ref_to_installed_kind(
                row, plugin=matched, release=target_release
            )
            self._reset_failed_device_installations(
                db, installed_kind_id=row.id, release_id=target_release.id
            )
            return True
        if not (needs_repair or plugin_id or release_id):
            return False
        # Catalog entry is gone after reimport; detach cloud IDs so sync stops 404ing.
        self._detach_stale_catalog_ref_from_installed_kind(row)
        self._clear_device_installations(db, installed_kind_id=row.id)
        return True

    def _apply_catalog_ref_to_installed_kind(
        self, row: Kind, *, plugin: Plugin, release: PluginRelease
    ) -> None:
        payload = dict(row.json) if isinstance(row.json, dict) else {}
        spec = dict(payload.get("spec") or {})
        source = dict(spec.get("source") or {})
        source.update(
            {
                "type": "marketplace",
                "providerKey": "wegent-market",
                "pluginKey": plugin.name,
                "catalogItemId": str(plugin.id),
                "marketplace": marketplace_name_for_visibility(plugin.visibility),
            }
        )
        package_ref = {
            "storageKey": release.storage_key,
            "checksum": f"sha256:{release.sha256}",
            "sizeBytes": release.size_bytes,
        }
        source_payload = dict(spec.get("sourcePayload") or {})
        source_payload["releaseId"] = release.id
        spec.update(
            {
                "source": source,
                "origin": spec.get("origin") or "market",
                "pluginId": plugin.id,
                "releaseId": release.id,
                "desiredVersion": release.version,
                "version": release.version,
                "displayName": plugin.display_name or spec.get("displayName"),
                "description": plugin.summary
                or plugin.description_md
                or spec.get("description"),
                "sourceProvider": self._source_provider(plugin),
                "sourceLabel": self._source_label(plugin),
                "visibility": plugin.visibility,
                "installState": "installed",
                "manifest": release.manifest_json or spec.get("manifest"),
                "interface": release.interface_json or spec.get("interface"),
                "components": (release.scan_report_json or {}).get("components")
                or spec.get("components")
                or {},
                "packageRef": package_ref,
                "sourcePayload": source_payload,
            }
        )
        payload["spec"] = spec
        metadata = dict(payload.get("metadata") or {})
        metadata["name"] = self._kind_name(plugin.slug or plugin.name)
        payload["metadata"] = metadata
        row.json = payload
        row.name = metadata["name"]
        flag_modified(row, "json")

    def _detach_stale_catalog_ref_from_installed_kind(self, row: Kind) -> None:
        payload = dict(row.json) if isinstance(row.json, dict) else {}
        spec = dict(payload.get("spec") or {})
        source = dict(spec.get("source") or {})
        source.pop("catalogItemId", None)
        spec.update(
            {
                "source": source,
                "pluginId": None,
                "releaseId": None,
                "packageRef": None,
                "installState": "installed",
            }
        )
        source_payload = dict(spec.get("sourcePayload") or {})
        source_payload.pop("releaseId", None)
        spec["sourcePayload"] = source_payload
        payload["spec"] = spec
        row.json = payload
        flag_modified(row, "json")

    def _deactivate_duplicate_installed_kind(self, db: Session, row: Kind) -> bool:
        payload = dict(row.json) if isinstance(row.json, dict) else {}
        spec = dict(payload.get("spec") or {})
        if not row.is_active and spec.get("installState") == "uninstalled":
            return False
        spec["enabled"] = False
        spec["installState"] = "uninstalled"
        payload["spec"] = spec
        row.json = payload
        row.is_active = False
        flag_modified(row, "json")
        self._clear_device_installations(db, installed_kind_id=row.id)
        return True

    def _clear_device_installations(
        self, db: Session, *, installed_kind_id: int
    ) -> None:
        (
            db.query(PluginDeviceInstallation)
            .filter(PluginDeviceInstallation.installed_kind_id == installed_kind_id)
            .delete(synchronize_session=False)
        )

    def _reset_failed_device_installations(
        self, db: Session, *, installed_kind_id: int, release_id: int
    ) -> None:
        rows = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id == installed_kind_id,
                PluginDeviceInstallation.state == "failed",
            )
            .all()
        )
        for row in rows:
            row.state = "pending"
            row.desired_release_id = release_id
            row.error_code = ""
            row.error_message = ""
            row.attempt_count = 0

    def _owned_install(self, db, *, user_id, installed_id):
        row = (
            db.query(Kind)
            .filter(
                Kind.id == installed_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active,
            )
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Installed plugin not found")
        return row

    def _owned_submission(
        self,
        db: Session,
        user_id: int,
        submission_id: int,
        *,
        for_update: bool = False,
    ) -> PluginSubmission:
        query = db.query(PluginSubmission).filter(PluginSubmission.id == submission_id)
        if for_update:
            query = query.with_for_update()
        row = query.first()
        if not row or row.submitter_user_id != user_id:
            raise HTTPException(status_code=404, detail="Submission not found")
        return row

    def _validate_uploaded_package(self, release, package):
        if len(package) != release.size_bytes:
            raise HTTPException(
                status_code=422, detail="Uploaded package size mismatch"
            )
        actual = hashlib.sha256(package).hexdigest()
        if actual != release.sha256:
            raise HTTPException(
                status_code=422, detail="Uploaded package checksum mismatch"
            )

    def _scan_package(self, package: bytes) -> dict:
        """Reject unsafe archives and report executable capabilities for review."""
        try:
            return scan_plugin_package(package)
        except PluginPackageScanError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    def _staging_storage_key(self, release_id: int, digest: str) -> str:
        return f"plugins/staging/{release_id}/{digest}.zip"

    def _storage_key(self, plugin_id, release_id, digest):
        return f"plugins/{plugin_id}/{release_id}/{digest}.zip"

    def _component_states(self, components):
        states = {}
        for key, prefix in (
            ("skills", "skill"),
            ("commands", "command"),
            ("agents", "agent"),
            ("hooks", "hook"),
            ("mcps", "mcp"),
            ("lsps", "lsp"),
            ("monitors", "monitor"),
            ("bins", "bin"),
        ):
            for item in components.get(key, []):
                name = item.get("name") if isinstance(item, dict) else None
                if name:
                    states[f"{prefix}:{name}"] = True
        return states

    def _release_item(self, release):
        return PluginReleaseItem(
            id=release.id,
            pluginId=release.plugin_id,
            version=release.version,
            releaseNotes=release.release_notes,
            checksum=f"sha256:{release.sha256}",
            sizeBytes=release.size_bytes,
            publishedAt=unset_datetime(release.published_at),
        )

    def _submission_item(self, submission):
        return PluginSubmissionItem(
            id=submission.id,
            pluginId=submission.plugin_id,
            releaseId=submission.release_id,
            purpose=submission.purpose,
            status=submission.status,
            reviewNote=submission.review_note,
            submittedAt=submission.submitted_at,
            reviewedAt=unset_datetime(submission.reviewed_at),
        )

    def _upstream_item(self, upstream):
        return PluginUpstreamItem(
            id=upstream.id,
            pluginId=upstream.plugin_id,
            provider=upstream.provider,
            marketplaceName=upstream.marketplace_name,
            remotePluginId=upstream.remote_plugin_id,
            upstreamUrl=upstream.upstream_url,
            licenseInfo=upstream.license_info,
            syncEnabled=upstream.sync_enabled,
            syncPolicy=upstream.sync_policy,
            lastSeenVersion=unset_str(upstream.last_seen_version),
            lastCheckedAt=unset_datetime(upstream.last_checked_at),
            lastSyncedAt=unset_datetime(upstream.last_synced_at),
            lastError=unset_str(upstream.last_error),
        )

    def _source_provider(self, plugin):
        if plugin.source_provider == "codex":
            return "codex"
        if plugin.source_type == "submission":
            return "user"
        return "wegent"

    def _source_label(self, plugin):
        if plugin.source_provider == "codex":
            return "Codex 官方 · Wework 镜像"
        if plugin.visibility == "personal":
            return "个人插件"
        if plugin.source_type == "submission":
            return "社区插件"
        return "Wegent 官方"

    def _matches_source(self, plugin, source):
        normalized = source.strip().lower()
        return normalized in {
            plugin.source_provider.lower(),
            plugin.source_type.lower(),
            "featured" if is_featured_rank(plugin.featured_rank) else "",
        }

    def _search_text(self, plugin):
        keywords = " ".join(str(item) for item in (plugin.keywords_json or []))
        return (
            f"{plugin.name} {plugin.display_name} {plugin.summary} {keywords}".lower()
        )

    def _validate_slug(self, value):
        if not SLUG_PATTERN.fullmatch(value):
            raise HTTPException(status_code=422, detail="Invalid plugin slug")

    def _validate_version(self, value):
        if not SEMVER_PATTERN.fullmatch(value):
            raise HTTPException(status_code=422, detail="Plugin version must be SemVer")

    def _kind_name(self, slug):
        digest = hashlib.sha256(slug.encode()).hexdigest()[:10]
        return f"{slug[:89]}-{digest}"

    def _kind_to_installed(self, row):
        payload = dict(row.json)
        metadata = dict(payload.get("metadata", {}))
        labels = dict(metadata.get("labels", {}))
        labels["id"] = str(row.id)
        metadata["labels"] = labels
        payload["metadata"] = metadata
        return InstalledPlugin.model_validate(payload)


plugin_marketplace_service = PluginMarketplaceService()
