# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud catalog, immutable releases, and restricted sharing for Smart apps."""

import base64
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from packaging.version import Version
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.smart_app_marketplace import (
    EPOCH_TIME,
    SmartApp,
    SmartAppRelease,
    SmartAppSubmission,
)
from app.models.user import User
from app.schemas.smart_app import (
    SmartAppAccessResponse,
    SmartAppAccessTarget,
    SmartAppAccessUpdateRequest,
    SmartAppDownloadDescriptor,
    SmartAppMarketplaceItem,
    SmartAppMarketplaceListResponse,
    SmartAppOwnedListResponse,
    SmartAppSubmissionCompleteResponse,
    SmartAppSubmissionInitRequest,
    SmartAppSubmissionInitResponse,
    SmartAppSubmissionItem,
)
from app.services.marketplace_artifact_storage import marketplace_artifact_storage
from app.services.marketplace_submission_upload import (
    build_marketplace_submission_upload_url,
)
from app.services.marketplace_tag_service import marketplace_tag_service
from app.services.smart_app_download_link import build_smart_app_download_url
from app.services.smart_app_package_parser import (
    MAX_SMART_APP_PACKAGE_SIZE_BYTES,
    SEMVER_PATTERN,
    ParsedSmartAppPackage,
    smart_app_package_parser,
)

_DATA_URL = re.compile(r"^data:(image/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$")
_APPROVED = (MemberStatus.APPROVED.value, MemberStatus.APPROVED.name)
_MAX_EXTENSIONS_BYTES = 64 * 1024


@dataclass(frozen=True)
class SmartAppArtifactDownload:
    storage_key: str
    filename: str
    size_bytes: int


class SmartAppMarketplaceService:
    def list_marketplace(
        self,
        db: Session,
        *,
        user_id: int,
        query: str = "",
        source: str = "",
        tag: str = "",
    ) -> SmartAppMarketplaceListResponse:
        apps = db.query(SmartApp).filter(SmartApp.status == "published").all()
        normalized_query = query.strip().lower()
        items = []
        for app in apps:
            role = self._access_role(db, app=app, user_id=user_id)
            if role is None:
                continue
            if app.source_type == "user" and role == "owner":
                continue
            if (
                source
                and source != app.source_type
                and not (source == "shared" and role == "recipient")
            ):
                continue
            tags = list(app.tags_json or [])
            if tag and tag not in tags:
                continue
            if (
                normalized_query
                and normalized_query
                not in " ".join(
                    (app.name, app.display_name, app.summary, app.description_md)
                ).lower()
            ):
                continue
            items.append(self._item(db, app=app, role=role))
        items.sort(
            key=lambda item: (
                item.sourceType != "official",
                not item.featured,
                -item.updatedAt.timestamp(),
            )
        )
        return SmartAppMarketplaceListResponse(items=items)

    def list_owned(self, db: Session, *, user_id: int) -> SmartAppOwnedListResponse:
        apps = (
            db.query(SmartApp)
            .filter(SmartApp.owner_user_id == user_id, SmartApp.status == "published")
            .order_by(SmartApp.updated_at.desc())
            .all()
        )
        return SmartAppOwnedListResponse(
            items=[self._item(db, app=app, role="owner") for app in apps]
        )

    def get_marketplace_item(
        self, db: Session, *, smart_app_id: int, user_id: int
    ) -> SmartAppMarketplaceItem:
        app = self._published_app(db, smart_app_id)
        role = self._access_role(db, app=app, user_id=user_id)
        if role is None:
            raise HTTPException(status_code=404, detail="Smart app not found")
        return self._item(db, app=app, role=role)

    def init_submission(
        self,
        db: Session,
        *,
        user_id: int,
        request: SmartAppSubmissionInitRequest,
    ) -> SmartAppSubmissionInitResponse:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", request.sha256):
            raise HTTPException(status_code=422, detail="sha256 must be hexadecimal")
        if not SEMVER_PATTERN.fullmatch(request.version):
            raise HTTPException(status_code=422, detail="version must be SemVer")
        tags = marketplace_tag_service.validate_resource_tags(
            db, request.tags, require_nonempty=True
        )
        icon = self._decode_image(request.iconDataUrl, icon=True)
        screenshots = [
            self._decode_image(data_url, icon=False)
            for data_url in request.screenshotDataUrls
        ]
        extensions = self._validated_extensions(request.extensions, "extensions")
        release_extensions = self._validated_extensions(
            request.releaseExtensions, "releaseExtensions"
        )
        app = self._submission_app(
            db,
            user_id=user_id,
            app_id=request.smartAppId,
            name=request.name,
            display_name=request.displayName,
        )
        if request.smartAppId is None and not request.targets:
            raise HTTPException(
                status_code=422, detail="User Smart apps require at least one recipient"
            )
        targets = (
            self._validated_targets(db, owner_user_id=user_id, targets=request.targets)
            if request.targets
            else self._grant_targets(db, app.id)
        )
        self._ensure_newer_version(db, app=app, version=request.version)
        pending = (
            db.query(SmartAppSubmission.id)
            .filter(
                SmartAppSubmission.smart_app_id == app.id,
                SmartAppSubmission.version == request.version,
                SmartAppSubmission.status.in_(("uploading", "scanning")),
            )
            .first()
        )
        if pending:
            raise HTTPException(
                status_code=409, detail="Smart app version is uploading"
            )

        nonce = uuid.uuid4().hex
        prefix = f"smart-apps/staging/{user_id}/{nonce}"
        package_key = f"{prefix}/{request.filename}"
        asset_keys: list[dict[str, str]] = []
        created_keys: list[str] = []
        try:
            icon_key = f"{prefix}/icon.{icon[1]}"
            marketplace_artifact_storage.put(icon_key, icon[0], content_type=icon[2])
            created_keys.append(icon_key)
            for index, (data, extension, content_type) in enumerate(screenshots):
                key = f"{prefix}/screenshot-{index + 1}.{extension}"
                marketplace_artifact_storage.put(key, data, content_type=content_type)
                created_keys.append(key)
                asset_keys.append({"key": key, "contentType": content_type})
            submission = SmartAppSubmission(
                smart_app_id=app.id,
                owner_user_id=user_id,
                version=request.version,
                status="uploading",
                staging_storage_key=package_key,
                sha256=request.sha256.lower(),
                size_bytes=request.sizeBytes,
                metadata_json={
                    "filename": request.filename,
                    "summary": request.summary,
                    "descriptionMd": request.descriptionMd,
                    "tags": tags,
                    "releaseNotes": request.releaseNotes,
                    "extensions": extensions,
                    "releaseExtensions": release_extensions,
                    "icon": {"key": icon_key, "contentType": icon[2]},
                    "screenshots": asset_keys,
                    "targets": [target.model_dump() for target in targets],
                },
            )
            db.add(submission)
            db.commit()
            db.refresh(submission)
            upload_url, expires_at = build_marketplace_submission_upload_url(
                kind="smart_app",
                submission_id=submission.id,
                user_id=user_id,
            )
            return SmartAppSubmissionInitResponse(
                submissionId=submission.id,
                smartAppId=app.id,
                uploadUrl=upload_url,
                expiresAt=expires_at,
            )
        except Exception:
            db.rollback()
            for key in created_keys:
                try:
                    marketplace_artifact_storage.delete(key)
                except Exception:
                    pass
            raise

    def upload_submission_package(
        self,
        db: Session,
        *,
        submission_id: int,
        user_id: int,
        package: bytes,
    ) -> None:
        submission = self._owned_submission(db, submission_id, user_id, for_update=True)
        try:
            if submission.status != "uploading":
                raise HTTPException(
                    status_code=409, detail="Submission is not uploading"
                )
            self._verify_uploaded_package(submission, package)
            marketplace_artifact_storage.put(
                submission.staging_storage_key,
                package,
                content_type="application/zip",
            )
            db.commit()
        except Exception:
            db.rollback()
            raise

    def complete_submission(
        self, db: Session, *, submission_id: int, user_id: int
    ) -> SmartAppSubmissionCompleteResponse:
        submission = self._owned_submission(db, submission_id, user_id, for_update=True)
        if submission.status != "uploading":
            raise HTTPException(status_code=409, detail="Submission is not uploading")
        submission.status = "scanning"
        db.commit()
        try:
            package = marketplace_artifact_storage.get(submission.staging_storage_key)
            self._verify_uploaded_package(submission, package)
            parsed = smart_app_package_parser.parse(package)
            app = db.get(SmartApp, submission.smart_app_id)
            if (
                app is None
                or parsed.name != app.name
                or parsed.version != submission.version
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Uploaded Smart app identity does not match the submission",
                )
            self._ensure_newer_version(db, app=app, version=parsed.version)
            release, asset_keys = self._publish_release(
                db,
                app=app,
                parsed=parsed,
                package=package,
                metadata=dict(submission.metadata_json or {}),
                created_by_user_id=user_id,
            )
            targets = [
                SmartAppAccessTarget.model_validate(target)
                for target in (submission.metadata_json or {}).get("targets", [])
            ]
            self._replace_grants(db, app=app, owner_user_id=user_id, targets=targets)
            submission.status = "published"
            db.commit()
            db.refresh(app)
            self._delete_staging(submission)
            return SmartAppSubmissionCompleteResponse(
                submission=self._submission_item(submission),
                item=self._item(db, app=app, role="owner"),
            )
        except Exception as exc:
            db.rollback()
            submission = db.get(SmartAppSubmission, submission_id)
            if submission:
                submission.status = "rejected"
                submission.error_message = str(exc)[:1000]
                db.commit()
            raise

    def cancel_submission(
        self, db: Session, *, submission_id: int, user_id: int
    ) -> SmartAppSubmissionItem:
        submission = self._owned_submission(db, submission_id, user_id, for_update=True)
        if submission.status not in {"uploading", "scanning"}:
            raise HTTPException(
                status_code=409, detail="Submission cannot be cancelled"
            )
        submission.status = "cancelled"
        db.commit()
        self._delete_staging(submission)
        return self._submission_item(submission)

    def get_access(
        self, db: Session, *, smart_app_id: int, user_id: int
    ) -> SmartAppAccessResponse:
        app = self._owned_user_app(db, smart_app_id, user_id)
        targets = self._grant_targets(db, app.id)
        return SmartAppAccessResponse(
            smartAppId=app.id,
            scope="restricted" if targets else "private",
            targets=targets,
        )

    def update_access(
        self,
        db: Session,
        *,
        smart_app_id: int,
        user_id: int,
        request: SmartAppAccessUpdateRequest,
    ) -> SmartAppAccessResponse:
        app = self._owned_user_app(db, smart_app_id, user_id)
        targets = (
            self._validated_targets(db, owner_user_id=user_id, targets=request.targets)
            if request.scope == "restricted"
            else []
        )
        self._replace_grants(db, app=app, owner_user_id=user_id, targets=targets)
        app.visibility = "restricted" if targets else "private"
        db.commit()
        return self.get_access(db, smart_app_id=smart_app_id, user_id=user_id)

    def download_descriptor(
        self, db: Session, *, smart_app_id: int, user_id: int
    ) -> SmartAppDownloadDescriptor:
        app = self._published_app(db, smart_app_id)
        if self._access_role(db, app=app, user_id=user_id) is None:
            raise HTTPException(status_code=404, detail="Smart app not found")
        release = self._latest_release(db, app)
        url, expires_at = build_smart_app_download_url(
            smart_app_id=app.id,
            release_id=release.id,
            user_id=user_id,
        )
        return SmartAppDownloadDescriptor(
            smartAppId=app.id,
            releaseId=release.id,
            version=release.version,
            filename=f"{app.name}-{release.version}.zip",
            downloadUrl=url,
            sha256=release.sha256,
            sizeBytes=release.size_bytes,
            expiresAt=expires_at,
        )

    def download_artifact(
        self,
        db: Session,
        *,
        smart_app_id: int,
        release_id: int,
        user_id: int,
    ) -> SmartAppArtifactDownload:
        """Resolve one ticketed artifact while rechecking current access."""
        app = self._published_app(db, smart_app_id)
        if self._access_role(db, app=app, user_id=user_id) is None:
            raise HTTPException(status_code=404, detail="Smart app not found")
        release = (
            db.query(SmartAppRelease)
            .filter(
                SmartAppRelease.id == release_id,
                SmartAppRelease.smart_app_id == app.id,
                SmartAppRelease.scan_status == "passed",
            )
            .first()
        )
        if not release:
            raise HTTPException(status_code=404, detail="Smart app release not found")
        return SmartAppArtifactDownload(
            storage_key=release.storage_key,
            filename=f"{app.name}-{release.version}.zip",
            size_bytes=release.size_bytes,
        )

    def publish_official_package(
        self,
        db: Session,
        *,
        package: bytes,
        summary: str,
        description_md: str,
        tags: list[str],
        icon: bytes,
        icon_content_type: str,
        screenshots: list[tuple[bytes, str]],
        release_notes: str = "",
        featured_rank: int = 0,
        extensions: dict[str, Any] | None = None,
        release_extensions: dict[str, Any] | None = None,
    ) -> tuple[SmartApp, SmartAppRelease, bool]:
        parsed = smart_app_package_parser.parse(package)
        validated_tags = marketplace_tag_service.validate_resource_tags(
            db, tags, require_nonempty=True
        )
        app = (
            db.query(SmartApp)
            .filter(SmartApp.owner_user_id == 0, SmartApp.name == parsed.name)
            .first()
        )
        if not app:
            app = SmartApp(
                owner_user_id=0,
                name=parsed.name,
                display_name=parsed.display_name,
                source_type="official",
                visibility="public",
                status="draft",
                tags_json=validated_tags,
            )
            db.add(app)
            db.flush()
        duplicate = (
            db.query(SmartAppRelease)
            .filter(
                SmartAppRelease.smart_app_id == app.id,
                SmartAppRelease.version == parsed.version,
            )
            .first()
        )
        if duplicate:
            if duplicate.sha256 != hashlib.sha256(package).hexdigest():
                raise HTTPException(
                    status_code=409, detail="Official Smart app version already differs"
                )
            return app, duplicate, False
        self._ensure_newer_version(db, app=app, version=parsed.version)
        nonce = uuid.uuid4().hex
        icon_key = f"smart-apps/staging/official/{nonce}/icon"
        marketplace_artifact_storage.put(icon_key, icon, content_type=icon_content_type)
        screenshot_meta = []
        for index, (value, content_type) in enumerate(screenshots):
            key = f"smart-apps/staging/official/{nonce}/screenshot-{index + 1}"
            marketplace_artifact_storage.put(key, value, content_type=content_type)
            screenshot_meta.append({"key": key, "contentType": content_type})
        staging_keys = [icon_key, *(item["key"] for item in screenshot_meta)]
        try:
            release, _ = self._publish_release(
                db,
                app=app,
                parsed=parsed,
                package=package,
                metadata={
                    "summary": summary,
                    "descriptionMd": description_md,
                    "tags": validated_tags,
                    "releaseNotes": release_notes,
                    "extensions": self._validated_extensions(
                        extensions or {}, "extensions"
                    ),
                    "releaseExtensions": self._validated_extensions(
                        release_extensions or {}, "releaseExtensions"
                    ),
                    "icon": {"key": icon_key, "contentType": icon_content_type},
                    "screenshots": screenshot_meta,
                },
                created_by_user_id=0,
            )
            app.source_type = "official"
            app.visibility = "public"
            app.featured_rank = featured_rank
            db.commit()
            return app, release, True
        finally:
            for key in staging_keys:
                try:
                    marketplace_artifact_storage.delete(key)
                except Exception:
                    pass

    def _submission_app(
        self,
        db: Session,
        *,
        user_id: int,
        app_id: int | None,
        name: str,
        display_name: str,
    ) -> SmartApp:
        if app_id is not None:
            app = self._owned_user_app(db, app_id, user_id, require_published=False)
            if app.name != name:
                raise HTTPException(
                    status_code=409, detail="Smart app name cannot change"
                )
            return app
        app = (
            db.query(SmartApp)
            .filter(SmartApp.owner_user_id == user_id, SmartApp.name == name)
            .first()
        )
        if app:
            return app
        app = SmartApp(
            owner_user_id=user_id,
            name=name,
            display_name=display_name,
            source_type="user",
            visibility="restricted",
            status="draft",
            tags_json=[],
        )
        db.add(app)
        db.flush()
        return app

    def _publish_release(
        self,
        db: Session,
        *,
        app: SmartApp,
        parsed: ParsedSmartAppPackage,
        package: bytes,
        metadata: dict,
        created_by_user_id: int,
    ) -> tuple[SmartAppRelease, list[str]]:
        digest = hashlib.sha256(package).hexdigest()
        release_key = f"smart-apps/releases/{app.id}/{parsed.version}/{digest}.zip"
        marketplace_artifact_storage.put_immutable(
            release_key, package, content_type="application/zip"
        )
        final_assets = self._activate_assets(app.id, metadata)
        release = SmartAppRelease(
            smart_app_id=app.id,
            version=parsed.version,
            manifest_json=parsed.manifest,
            release_notes=str(metadata.get("releaseNotes") or ""),
            storage_key=release_key,
            sha256=digest,
            size_bytes=len(package),
            scan_status="passed",
            scan_report_json=parsed.scan_report,
            extensions_json=self._validated_extensions(
                metadata.get("releaseExtensions") or {}, "releaseExtensions"
            ),
            created_by_user_id=created_by_user_id,
        )
        db.add(release)
        db.flush()
        app.display_name = parsed.display_name
        app.summary = str(metadata.get("summary") or parsed.description)
        app.description_md = str(metadata.get("descriptionMd") or parsed.description)
        app.tags_json = list(metadata.get("tags") or [])
        app.icon_storage_key = final_assets[0]
        app.screenshots_json = final_assets[1]
        app.extensions_json = self._merge_extensions(
            dict(app.extensions_json or {}),
            self._validated_extensions(metadata.get("extensions") or {}, "extensions"),
        )
        app.latest_release_id = release.id
        app.status = "published"
        if not app.published_at or app.published_at == EPOCH_TIME:
            app.published_at = datetime.now()
        return release, [final_assets[0], *final_assets[1]]

    def _activate_assets(self, app_id: int, metadata: dict) -> tuple[str, list[str]]:
        icon_meta = dict(metadata.get("icon") or {})
        icon_value = marketplace_artifact_storage.get(str(icon_meta["key"]))
        icon_digest = hashlib.sha256(icon_value).hexdigest()
        icon_type = str(icon_meta.get("contentType") or "image/png")
        icon_extension = self._extension(icon_type)
        icon_key = f"smart-apps/assets/{app_id}/icon-{icon_digest}.{icon_extension}"
        marketplace_artifact_storage.put_immutable(
            icon_key, icon_value, content_type=icon_type
        )
        screenshot_keys = []
        for index, raw in enumerate(metadata.get("screenshots") or []):
            item = dict(raw)
            value = marketplace_artifact_storage.get(str(item["key"]))
            digest = hashlib.sha256(value).hexdigest()
            content_type = str(item.get("contentType") or "image/png")
            key = (
                f"smart-apps/assets/{app_id}/screenshot-{index + 1}-{digest}."
                f"{self._extension(content_type)}"
            )
            marketplace_artifact_storage.put_immutable(
                key, value, content_type=content_type
            )
            screenshot_keys.append(key)
        return icon_key, screenshot_keys

    def _item(
        self, db: Session, *, app: SmartApp, role: str
    ) -> SmartAppMarketplaceItem:
        release = self._latest_release(db, app)
        owner = db.get(User, app.owner_user_id) if app.owner_user_id else None
        icon_url = ""
        if app.icon_storage_key:
            icon_url = marketplace_artifact_storage.presign_download(
                app.icon_storage_key
            )[0]
        screenshot_urls = [
            marketplace_artifact_storage.presign_download(key)[0]
            for key in (app.screenshots_json or [])
        ]
        manifest = dict(release.manifest_json or {})
        return SmartAppMarketplaceItem(
            id=app.id,
            name=app.name,
            displayName=app.display_name,
            summary=app.summary,
            descriptionMd=app.description_md,
            sourceType=app.source_type,
            ownerUserId=app.owner_user_id,
            ownerDisplayName=(owner.user_name if owner else "Wegent"),
            accessRole=role,
            tags=list(app.tags_json or []),
            iconUrl=icon_url,
            screenshotUrls=screenshot_urls,
            featured=bool(app.featured_rank),
            latestReleaseId=release.id,
            version=release.version,
            releaseNotes=release.release_notes,
            sizeBytes=release.size_bytes,
            requirements=dict(manifest.get("requirements") or {}),
            extensions=dict(app.extensions_json or {}),
            releaseExtensions=dict(release.extensions_json or {}),
            scanStatus="passed",
            updatedAt=app.updated_at,
            publishedAt=(
                release.published_at
                if not app.published_at or app.published_at == EPOCH_TIME
                else app.published_at
            ),
        )

    def _latest_release(self, db: Session, app: SmartApp) -> SmartAppRelease:
        release = (
            db.query(SmartAppRelease)
            .filter(
                SmartAppRelease.id == app.latest_release_id,
                SmartAppRelease.smart_app_id == app.id,
            )
            .first()
        )
        if not release:
            raise HTTPException(status_code=404, detail="Smart app release not found")
        return release

    @staticmethod
    def _validated_extensions(value: dict[str, Any], field: str) -> dict[str, Any]:
        extensions = dict(value or {})
        if extensions and "schemaVersion" not in extensions:
            extensions["schemaVersion"] = 1
        try:
            encoded = json.dumps(
                extensions, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=422, detail=f"{field} must contain JSON-compatible values"
            ) from exc
        if len(encoded) > _MAX_EXTENSIONS_BYTES:
            raise HTTPException(
                status_code=422,
                detail=f"{field} must not exceed {_MAX_EXTENSIONS_BYTES} bytes",
            )
        return extensions

    @classmethod
    def _merge_extensions(
        cls, existing: dict[str, Any], updates: dict[str, Any]
    ) -> dict[str, Any]:
        merged = dict(existing)
        for key, value in updates.items():
            current = merged.get(key)
            merged[key] = (
                cls._merge_extensions(current, value)
                if isinstance(current, dict) and isinstance(value, dict)
                else value
            )
        return merged

    def _published_app(self, db: Session, app_id: int) -> SmartApp:
        app = db.get(SmartApp, app_id)
        if not app or app.status != "published":
            raise HTTPException(status_code=404, detail="Smart app not found")
        return app

    def _owned_user_app(
        self,
        db: Session,
        app_id: int,
        user_id: int,
        *,
        require_published: bool = True,
    ) -> SmartApp:
        app = db.get(SmartApp, app_id)
        if (
            not app
            or app.owner_user_id != user_id
            or app.source_type != "user"
            or (require_published and app.status != "published")
        ):
            raise HTTPException(status_code=404, detail="Owned Smart app not found")
        return app

    def _access_role(self, db: Session, *, app: SmartApp, user_id: int) -> str | None:
        if app.source_type == "official" and app.visibility == "public":
            return "official"
        if app.owner_user_id == user_id:
            return "owner"
        if app.visibility != "restricted":
            return None
        namespace_ids = self._user_namespace_ids(db, user_id)
        grant = (
            db.query(ResourceMember.id)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.SMART_APP.value, ResourceType.SMART_APP.name)
                ),
                ResourceMember.resource_id == app.id,
                ResourceMember.status.in_(_APPROVED),
                or_(
                    and_(
                        ResourceMember.entity_type == "user",
                        ResourceMember.entity_id == str(user_id),
                    ),
                    and_(
                        ResourceMember.entity_type == "namespace",
                        ResourceMember.entity_id.in_(namespace_ids or {"-1"}),
                    ),
                ),
            )
            .first()
        )
        return "recipient" if grant else None

    def _user_namespace_ids(self, db: Session, user_id: int) -> set[str]:
        owned = {
            str(row.id)
            for row in db.query(Namespace.id)
            .filter(Namespace.owner_user_id == user_id, Namespace.is_active.is_(True))
            .all()
        }
        member = {
            str(row.resource_id)
            for row in db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type.in_(("Namespace", "NAMESPACE")),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(_APPROVED),
            )
            .all()
        }
        return owned | member

    def _validated_targets(
        self,
        db: Session,
        *,
        owner_user_id: int,
        targets: list[SmartAppAccessTarget],
    ) -> list[SmartAppAccessTarget]:
        normalized = []
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
                        status_code=422, detail="Invalid Smart app share user"
                    )
                normalized.append(
                    SmartAppAccessTarget(
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
                    status_code=422, detail="Invalid Smart app share department"
                )
            if str(namespace.id) not in self._user_namespace_ids(db, owner_user_id):
                raise HTTPException(
                    status_code=403, detail="Department is not accessible"
                )
            normalized.append(
                SmartAppAccessTarget(
                    entityType="namespace",
                    entityId=str(namespace.id),
                    displayName=namespace.display_name or namespace.name,
                )
            )
        return normalized

    def _replace_grants(
        self,
        db: Session,
        *,
        app: SmartApp,
        owner_user_id: int,
        targets: list[SmartAppAccessTarget],
    ) -> None:
        db.query(ResourceMember).filter(
            ResourceMember.resource_type.in_(
                (ResourceType.SMART_APP.value, ResourceType.SMART_APP.name)
            ),
            ResourceMember.resource_id == app.id,
        ).delete(synchronize_session=False)
        now = datetime.now()
        for target in targets:
            db.add(
                ResourceMember.create(
                    resource_type=ResourceType.SMART_APP.value,
                    resource_id=app.id,
                    entity_type=target.entityType,
                    entity_id=target.entityId,
                    entity_display_name=target.displayName,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=owner_user_id,
                    reviewed_by_user_id=owner_user_id,
                    reviewed_at=now,
                )
            )
        app.visibility = "restricted" if targets else "private"

    def _grant_targets(self, db: Session, app_id: int) -> list[SmartAppAccessTarget]:
        grants = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(
                    (ResourceType.SMART_APP.value, ResourceType.SMART_APP.name)
                ),
                ResourceMember.resource_id == app_id,
                ResourceMember.status.in_(_APPROVED),
            )
            .all()
        )
        return [
            SmartAppAccessTarget(
                entityType=grant.entity_type,
                entityId=grant.entity_id,
                displayName=grant.entity_display_name,
            )
            for grant in grants
        ]

    def _ensure_newer_version(
        self, db: Session, *, app: SmartApp, version: str
    ) -> None:
        releases = (
            db.query(SmartAppRelease.version)
            .filter(SmartAppRelease.smart_app_id == app.id)
            .all()
        )
        if any(row.version == version for row in releases):
            raise HTTPException(
                status_code=409, detail="Smart app version already exists"
            )
        if releases and Version(version) <= max(
            Version(row.version) for row in releases
        ):
            raise HTTPException(
                status_code=409, detail="Smart app version must be newer than latest"
            )

    def _owned_submission(
        self,
        db: Session,
        submission_id: int,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> SmartAppSubmission:
        query = db.query(SmartAppSubmission).filter(
            SmartAppSubmission.id == submission_id
        )
        if for_update:
            query = query.with_for_update()
        submission = query.first()
        if not submission or submission.owner_user_id != user_id:
            raise HTTPException(
                status_code=404, detail="Smart app submission not found"
            )
        return submission

    def _verify_uploaded_package(
        self, submission: SmartAppSubmission, package: bytes
    ) -> None:
        if len(package) != submission.size_bytes:
            raise HTTPException(
                status_code=400, detail="Uploaded Smart app size changed"
            )
        if len(package) > MAX_SMART_APP_PACKAGE_SIZE_BYTES:
            raise HTTPException(
                status_code=413, detail="Smart app package is too large"
            )
        if hashlib.sha256(package).hexdigest() != submission.sha256:
            raise HTTPException(
                status_code=400, detail="Uploaded Smart app hash changed"
            )

    def _submission_item(
        self, submission: SmartAppSubmission
    ) -> SmartAppSubmissionItem:
        return SmartAppSubmissionItem(
            id=submission.id,
            smartAppId=submission.smart_app_id,
            version=submission.version,
            status=submission.status,
            error=submission.error_message,
            createdAt=submission.created_at,
        )

    def _decode_image(self, data_url: str, *, icon: bool) -> tuple[bytes, str, str]:
        match = _DATA_URL.fullmatch(data_url.strip())
        if not match:
            raise HTTPException(status_code=422, detail="Unsupported Smart app image")
        content_type = match.group(1)
        if icon and content_type not in {"image/png", "image/webp"}:
            raise HTTPException(
                status_code=422, detail="Smart app icon must be PNG or WebP"
            )
        try:
            value = base64.b64decode(match.group(2), validate=True)
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail="Smart app image is invalid"
            ) from exc
        limit = 512 * 1024 if icon else 2 * 1024 * 1024
        if not value or len(value) > limit:
            raise HTTPException(status_code=422, detail="Smart app image is too large")
        return value, self._extension(content_type), content_type

    @staticmethod
    def _extension(content_type: str) -> str:
        return {"image/png": "png", "image/webp": "webp", "image/jpeg": "jpg"}[
            content_type
        ]

    def _delete_staging(self, submission: SmartAppSubmission) -> None:
        keys = [submission.staging_storage_key]
        metadata = dict(submission.metadata_json or {})
        keys.append(str((metadata.get("icon") or {}).get("key") or ""))
        keys.extend(
            str(item.get("key") or "") for item in metadata.get("screenshots") or []
        )
        for key in filter(None, keys):
            try:
                marketplace_artifact_storage.delete(key)
            except Exception:
                pass


smart_app_marketplace_service = SmartAppMarketplaceService()
