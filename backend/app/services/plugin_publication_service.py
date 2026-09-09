# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Enterprise plugin publication state machine and projections."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import uuid
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from fastapi import HTTPException
from sqlalchemy import case, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.plugin_marketplace import (
    EPOCH_TIME,
    Plugin,
    PluginRelease,
    unset_datetime,
)
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
    PluginPublicationActionEligibility,
    PluginPublicationCheckItem,
    PluginPublicationCreateRequest,
    PluginPublicationDeclaration,
    PluginPublicationEventItem,
    PluginPublicationFailureDetail,
    PluginPublicationGitLabState,
    PluginPublicationRequestDetail,
    PluginPublicationRequestListResponse,
    PluginPublicationRequestSummary,
    PluginPublicationRevisionCreateRequest,
    PluginPublicationRevisionItem,
    PluginPublicationSubmitter,
    PluginPublicationUploadResponse,
    PluginReleaseMetadata,
    PluginReleasePublishResponse,
    ReconcilePluginPublicationRequest,
    ReturnPluginPublicationRequest,
)
from app.services.marketplace_submission_upload import (
    build_plugin_publication_upload_url,
)
from app.services.plugin_marketplace_identity import (
    ENTERPRISE_CATALOG_NAMESPACE,
    personal_catalog_namespace,
)
from app.services.plugin_marketplace_service import (
    PluginMarketplaceService,
    PublishedRelease,
    plugin_marketplace_service,
)
from app.services.plugin_package_scanner import PluginPackageScanError
from app.services.plugin_package_storage import (
    PluginPackageStorage,
    PluginPackageStorageError,
    plugin_package_storage,
)
from app.services.plugin_publication_artifact import (
    canonical_complete_tree_sha256,
    canonical_plugin_files,
    canonical_source_tree_sha256,
    canonical_source_tree_sha256_from_files,
    read_plugin_root_member,
    release_envelope_sha256,
    validate_release_idempotency_key,
)
from app.services.plugin_publication_check_service import (
    PluginPublicationCheckService,
    PublicationCheckResult,
    PublicationInspection,
    plugin_publication_check_service,
)
from app.services.plugin_publication_gitlab_service import (
    GitLabMaterialization,
    PluginPublicationGitLabError,
    PluginPublicationGitLabGateway,
    PluginPublicationGitLabVerificationError,
    plugin_publication_gitlab_service,
)
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

TERMINAL_PUBLICATION_STATUSES = {"published", "withdrawn", "closed"}
GITLAB_EVENT_LOCKED_PUBLICATION_STATUSES = {
    *TERMINAL_PUBLICATION_STATUSES,
    "merged",
    "publishing",
    "publish_failed",
}
REVISION_CREATABLE_PUBLICATION_STATUSES = {
    "changes_requested",
    "automatic_check_failed",
    "code_changes_requested",
    "publish_failed",
    "withdrawn",
    "closed",
}
ADMIN_REVIEW_STATUSES = {"awaiting_admin", "admin_review"}
CODE_REVIEW_STATUSES = {
    "admin_accepted",
    "materializing",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
    "merged",
}
WITHDRAWABLE_PUBLICATION_STATUSES = {
    "uploading",
    "submitted",
    "automatic_checking",
    "automatic_check_failed",
    "awaiting_admin",
    "admin_review",
    "changes_requested",
    "admin_accepted",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
}

CONTROLLED_SOURCE_BRANCH = re.compile(
    r"wework/publication-(?P<request_id>[1-9][0-9]*)-r(?P<revision>[1-9][0-9]*)\Z"
)
ALLOWED_GITLAB_TRANSITIONS = {
    "admin_accepted": {"draft_mr_open", "merged", "closed"},
    "materializing": {"draft_mr_open", "merged", "closed"},
    "draft_mr_open": {
        "draft_mr_open",
        "ci_running",
        "code_changes_requested",
        "merge_ready",
        "merged",
        "closed",
    },
    "ci_running": {
        "ci_running",
        "code_changes_requested",
        "merge_ready",
        "merged",
        "closed",
    },
    "code_changes_requested": {
        "code_changes_requested",
        "ci_running",
        "merge_ready",
        "merged",
        "closed",
    },
    "merge_ready": {"merge_ready", "merged", "closed"},
    "merged": {"merged"},
}
PIPELINE_STATUS_ORDER = {
    "created": 0,
    "pending": 1,
    "running": 2,
    "success": 3,
    "failed": 3,
    "canceled": 3,
}
TERMINAL_PIPELINE_STATUSES = {"success", "failed", "canceled"}

DECLARATION_LABELS = {
    "externalNetworkAccess": "External network access",
    "executesCommands": "System commands or scripts",
    "readsOrWritesLocalFiles": "Local file access",
    "usesCredentials": "Credential use",
    "applicationPermissions": "Application permissions",
}

MAX_REVIEW_PACKAGE_ENTRIES = 500
MAX_REVIEW_CAPABILITIES = 500
MAX_REVIEW_MANIFEST_NODES = 1_000
MAX_REVIEW_MANIFEST_DEPTH = 6
MAX_REVIEW_MANIFEST_COLLECTION_ITEMS = 100
MAX_REVIEW_MANIFEST_STRING_LENGTH = 1_000
SENSITIVE_MANIFEST_KEY = re.compile(
    r"(?:password|passwd|secret|token|credential|private[-_ ]?key|"
    r"api[-_ ]?key|cookie|authorization)",
    re.IGNORECASE,
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class PluginPublicationService:
    """Own publication revisions while GitLab and Release remain separate gates."""

    def __init__(
        self,
        *,
        storage: PluginPackageStorage = plugin_package_storage,
        check_service: PluginPublicationCheckService = plugin_publication_check_service,
        gitlab: PluginPublicationGitLabGateway = plugin_publication_gitlab_service,
        marketplace: PluginMarketplaceService = plugin_marketplace_service,
    ) -> None:
        self.storage = storage
        self.check_service = check_service
        self.gitlab = gitlab
        self.marketplace = marketplace

    def create_request(
        self,
        db: Session,
        *,
        user_id: int,
        payload: PluginPublicationCreateRequest,
    ) -> PluginPublicationUploadResponse:
        self._lock_submitter_for_activation(db, user_id=user_id)
        active_requests = self._lock_active_requests_with_capacity(db, user_id=user_id)
        source_plugin, source_mode = self._source_plugin_for_create(
            db, user_id=user_id, payload=payload
        )
        if any(
            source_plugin_id == source_plugin.id
            for _, source_plugin_id in active_requests
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "This personal plugin already has an active publication request; "
                    "create a new revision on that request"
                ),
            )
        request = PluginPublicationRequest(
            source_plugin_id=source_plugin.id,
            submitter_user_id=user_id,
            current_revision=1,
            aggregate_status="uploading",
            risk_level="none",
        )
        db.add(request)
        db.flush()
        revision = self._new_revision(
            db,
            request=request,
            revision_number=1,
            user_id=user_id,
            payload=payload,
        )
        request.current_revision_id = revision.id
        self._event(
            db,
            revision_id=revision.id,
            event_type="request.created",
            actor_type="user",
            actor_id=user_id,
            message="Enterprise publication request created",
            payload={"sourceMode": source_mode},
        )
        return self._finish_upload_initialization(
            db, request=request, revision=revision
        )

    def create_revision(
        self,
        db: Session,
        *,
        user_id: int,
        request_id: int,
        payload: PluginPublicationRevisionCreateRequest,
    ) -> PluginPublicationUploadResponse:
        self._lock_submitter_for_activation(db, user_id=user_id)
        request = self._owned_request(
            db, user_id=user_id, request_id=request_id, for_update=True
        )
        if request.aggregate_status not in REVISION_CREATABLE_PUBLICATION_STATUSES:
            raise HTTPException(
                status_code=409,
                detail="A new revision is not allowed in the current state",
            )
        current_revision = self._current_revision(db, request)
        if (
            current_revision.merge_request_iid
            and current_revision.merge_request_status not in {"closed", "merged"}
        ):
            try:
                self.gitlab.close_merge_request(
                    merge_request_iid=current_revision.merge_request_iid
                )
                current_revision.merge_request_status = "closed"
            except PluginPublicationGitLabError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "The previous MR could not be closed; "
                        "a new revision was not created"
                    ),
                ) from exc
        if request.aggregate_status in TERMINAL_PUBLICATION_STATUSES:
            active_requests = self._lock_active_requests_with_capacity(
                db, user_id=user_id
            )
            if any(
                request_id != request.id
                and source_plugin_id == request.source_plugin_id
                for request_id, source_plugin_id in active_requests
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This personal plugin already has another active "
                        "publication request"
                    ),
                )
        revision_number = request.current_revision + 1
        revision = self._new_revision(
            db,
            request=request,
            revision_number=revision_number,
            user_id=user_id,
            payload=payload,
        )
        request.current_revision = revision_number
        request.current_revision_id = revision.id
        request.aggregate_status = "uploading"
        request.risk_level = "none"
        self._event(
            db,
            revision_id=revision.id,
            event_type="revision.created",
            actor_type="user",
            actor_id=user_id,
            message=f"Publication revision {revision_number} created",
        )
        return self._finish_upload_initialization(
            db, request=request, revision=revision
        )

    @trace_sync("plugin.publication.complete", "backend.plugin_publication")
    def complete_revision(
        self,
        db: Session,
        *,
        user_id: int,
        request_id: int,
        revision_number: int,
    ) -> PluginPublicationRequestDetail:
        request, revision = self._owned_current_revision(
            db,
            user_id=user_id,
            request_id=request_id,
            revision_number=revision_number,
            for_update=True,
        )
        if revision.status != "uploading":
            if revision.status in {
                "automatic_check_failed",
                "awaiting_admin",
                "admin_review",
                "changes_requested",
                *CODE_REVIEW_STATUSES,
                "publishing",
                "published",
                "publish_failed",
            }:
                return self.get_request(db, user_id=user_id, request_id=request_id)
            raise HTTPException(status_code=409, detail="Revision cannot be completed")

        try:
            package = self.storage.get(revision.staging_storage_key)
        except PluginPackageStorageError:
            db.rollback()
            raise
        if len(package) != revision.size_bytes:
            return self._fail_automatic_checks(
                db,
                request_id=request.id,
                revision_id=revision.id,
                user_id=user_id,
                code="package.size_mismatch",
                message="Uploaded snapshot size does not match sizeBytes",
            )
        actual_sha256 = hashlib.sha256(package).hexdigest()
        if actual_sha256 != revision.snapshot_sha256:
            return self._fail_automatic_checks(
                db,
                request_id=request.id,
                revision_id=revision.id,
                user_id=user_id,
                code="package.sha256_mismatch",
                message="Uploaded snapshot SHA256 does not match snapshotSha256",
            )
        source_plugin = db.get(Plugin, request.source_plugin_id)
        if not source_plugin:
            raise HTTPException(
                status_code=404, detail="Source personal plugin not found"
            )
        try:
            inspection = self.check_service.inspect(
                package,
                expected_slug=source_plugin.slug,
                expected_version=revision.requested_version,
                risk_declaration=dict(revision.risk_declaration or {}),
                test_notes=revision.test_notes,
            )
            canonical_files = canonical_plugin_files(package)
            source_tree_sha256 = canonical_source_tree_sha256_from_files(
                canonical_files
            )
        except (PluginPackageScanError, HTTPException, ValueError) as exc:
            message = exc.detail if isinstance(exc, HTTPException) else str(exc)
            return self._fail_automatic_checks(
                db,
                request_id=request.id,
                revision_id=revision.id,
                user_id=user_id,
                code="package.inspection_failed",
                message=str(message),
            )

        final_key = self._snapshot_storage_key(
            request.id, revision.revision, revision.snapshot_sha256
        )
        created_object = self.storage.put_immutable(final_key, package)
        completed_status = self._checks_status(inspection.checks)
        personal_release: PublishedRelease | None = None
        personal_release_id = 0
        personal_release_storage_key = ""
        try:
            if (
                completed_status == "awaiting_admin"
                and not revision.source_release_id
                and self._request_uses_slug_source(db, request_id=request.id)
            ):
                personal_release = self.marketplace.publish_personal_release(
                    db,
                    plugin_id=source_plugin.id,
                    owner_user_id=user_id,
                    package=package,
                    storage=self.storage,
                    created_by_user_id=user_id,
                    provenance={
                        "kind": "publication_source",
                        "requestId": request.id,
                        "revision": revision.revision,
                        "snapshotSha256": revision.snapshot_sha256,
                    },
                    defer_commit=True,
                )
                personal_release_id = personal_release.release.id
                personal_release_storage_key = personal_release.release.storage_key
            revision.manifest_snapshot = self._safe_manifest_snapshot(
                inspection.parsed.manifest
            )
            package_entries = sorted(
                canonical_files,
                key=lambda path: path.encode("utf-8"),
            )
            revision.package_entries_json = [
                self._trim_review_text(path, limit=1_000)
                for path in package_entries[:MAX_REVIEW_PACKAGE_ENTRIES]
            ]
            revision.package_entry_count = len(package_entries)
            revision.capabilities_json = self._capability_inventory(inspection)
            revision.storage_key = final_key
            revision.source_tree_sha256 = source_tree_sha256
            revision.status = completed_status
            revision.completed_at = _utc_now()
            request.aggregate_status = revision.status
            request.risk_level = self._risk_level(inspection.checks)
            if personal_release:
                revision.source_release_id = personal_release.release.id
            if unset_datetime(request.submitted_at) is None:
                request.submitted_at = _utc_now()
            self._replace_checks(db, revision.id, inspection.checks)
            self._event(
                db,
                revision_id=revision.id,
                event_type="revision.submitted",
                actor_type="user",
                actor_id=user_id,
                message=(
                    f"Revision {revision.revision} submitted with immutable snapshot "
                    f"{revision.snapshot_sha256}"
                ),
            )
            self._event(
                db,
                revision_id=revision.id,
                event_type="automatic_checks.completed",
                actor_type="system",
                message=(
                    "Automatic checks completed"
                    if revision.status == "awaiting_admin"
                    else "Automatic checks found blocking issues"
                ),
            )
            db.commit()
        except Exception:
            db.rollback()
            if created_object:
                self._delete_object_best_effort(final_key)
            if personal_release and personal_release.created:
                self._delete_object_best_effort(personal_release_storage_key)
            raise
        if revision.staging_storage_key != final_key:
            self._delete_object_best_effort(revision.staging_storage_key)
        if personal_release and personal_release.created:
            self.marketplace.notify_catalog_release(db, personal_release_id)
        return self.get_request(db, user_id=user_id, request_id=request.id)

    def upload_revision_package(
        self,
        db: Session,
        *,
        user_id: int,
        request_id: int,
        revision_number: int,
        package: bytes,
    ) -> None:
        """Store a ticketed publication snapshot through the Backend origin."""
        _, revision = self._owned_current_revision(
            db,
            user_id=user_id,
            request_id=request_id,
            revision_number=revision_number,
            for_update=True,
        )
        try:
            if revision.status != "uploading":
                raise HTTPException(
                    status_code=409, detail="Publication revision is not uploading"
                )
            if len(package) != revision.size_bytes:
                raise HTTPException(
                    status_code=422, detail="Uploaded snapshot size mismatch"
                )
            if hashlib.sha256(package).hexdigest() != revision.snapshot_sha256:
                raise HTTPException(
                    status_code=422, detail="Uploaded snapshot checksum mismatch"
                )
            self.storage.put(revision.staging_storage_key, package)
            db.commit()
        except Exception:
            db.rollback()
            raise

    def list_requests(
        self,
        db: Session,
        *,
        user_id: int | None,
        is_admin: bool,
        page: int,
        limit: int,
        status: str | None = None,
        risk_level: str | None = None,
        submitter: str | None = None,
        query: str | None = None,
        source_plugin_id: int | None = None,
        active_only: bool = False,
        submitted_after: datetime | None = None,
        submitted_before: datetime | None = None,
    ) -> PluginPublicationRequestListResponse:
        submitted_after = self._normalize_query_datetime(submitted_after)
        submitted_before = self._normalize_query_datetime(submitted_before)
        if (
            submitted_after is not None
            and submitted_before is not None
            and submitted_after > submitted_before
        ):
            raise HTTPException(
                status_code=422,
                detail="submittedAfter must be earlier than or equal to submittedBefore",
            )
        rows_query = db.query(PluginPublicationRequest)
        if not is_admin:
            rows_query = rows_query.filter(
                PluginPublicationRequest.submitter_user_id == user_id
            )
        if status:
            rows_query = rows_query.filter(
                PluginPublicationRequest.aggregate_status == status
            )
        if risk_level:
            rows_query = rows_query.filter(
                PluginPublicationRequest.risk_level == risk_level
            )
        if source_plugin_id:
            rows_query = rows_query.filter(
                PluginPublicationRequest.source_plugin_id == source_plugin_id
            )
        if active_only:
            rows_query = rows_query.filter(
                PluginPublicationRequest.aggregate_status.notin_(
                    TERMINAL_PUBLICATION_STATUSES
                )
            )
        if submitter:
            submitter_ids = [
                row.id
                for row in db.query(User.id)
                .filter(User.user_name.ilike(f"%{submitter.strip()}%"))
                .all()
            ]
            rows_query = rows_query.filter(
                PluginPublicationRequest.submitter_user_id.in_(submitter_ids)
            )
        if query:
            plugin_ids = [
                row.id
                for row in db.query(Plugin.id)
                .filter(
                    or_(
                        Plugin.slug.ilike(f"%{query.strip()}%"),
                        Plugin.display_name.ilike(f"%{query.strip()}%"),
                    )
                )
                .all()
            ]
            rows_query = rows_query.filter(
                PluginPublicationRequest.source_plugin_id.in_(plugin_ids)
            )
        effective_submitted_at = case(
            (
                PluginPublicationRequest.submitted_at == EPOCH_TIME,
                PluginPublicationRequest.created_at,
            ),
            else_=PluginPublicationRequest.submitted_at,
        )
        if submitted_after is not None:
            rows_query = rows_query.filter(effective_submitted_at >= submitted_after)
        if submitted_before is not None:
            rows_query = rows_query.filter(effective_submitted_at <= submitted_before)
        total = rows_query.count()
        is_terminal = PluginPublicationRequest.aggregate_status.in_(
            TERMINAL_PUBLICATION_STATUSES
        )
        terminal_rank = case((is_terminal, 1), else_=0)
        pending_submitted_at = case((is_terminal, None), else_=effective_submitted_at)
        terminal_submitted_at = case((is_terminal, effective_submitted_at), else_=None)
        rows = (
            rows_query.order_by(
                terminal_rank.asc(),
                pending_submitted_at.asc(),
                terminal_submitted_at.desc(),
                PluginPublicationRequest.id.asc(),
            )
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )
        return PluginPublicationRequestListResponse(
            items=[self._summary(db, row) for row in rows],
            total=total,
            page=page,
            limit=limit,
        )

    def get_request(
        self,
        db: Session,
        *,
        user_id: int | None,
        request_id: int,
        is_admin: bool = False,
        revision_number: int | None = None,
    ) -> PluginPublicationRequestDetail:
        request = db.get(PluginPublicationRequest, request_id)
        if not request or (not is_admin and request.submitter_user_id != user_id):
            raise HTTPException(status_code=404, detail="Publication request not found")
        return self._detail(
            db,
            request,
            is_admin=is_admin,
            revision_number=revision_number,
        )

    def withdraw_request(
        self, db: Session, *, user_id: int, request_id: int
    ) -> PluginPublicationRequestDetail:
        request, revision = self._owned_current_revision(
            db,
            user_id=user_id,
            request_id=request_id,
            revision_number=None,
            for_update=True,
        )
        if request.aggregate_status == "withdrawn":
            return self._detail(db, request)
        if request.aggregate_status not in WITHDRAWABLE_PUBLICATION_STATUSES:
            raise HTTPException(
                status_code=409,
                detail="Publication request can no longer be withdrawn",
            )
        if revision.merge_request_iid:
            try:
                self.gitlab.close_merge_request(
                    merge_request_iid=revision.merge_request_iid
                )
                revision.merge_request_status = "closed"
            except PluginPublicationGitLabError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=("MR could not be closed; publication was not withdrawn"),
                ) from exc
        request.aggregate_status = "withdrawn"
        revision.status = "withdrawn"
        self._event(
            db,
            revision_id=revision.id,
            event_type="request.withdrawn",
            actor_type="user",
            actor_id=user_id,
            message="Publication request withdrawn",
        )
        db.commit()
        return self._detail(db, request)

    def return_request(
        self,
        db: Session,
        *,
        admin_user: User,
        request_id: int,
        payload: ReturnPluginPublicationRequest,
    ) -> PluginPublicationRequestDetail:
        request, revision = self._admin_current_revision(
            db,
            request_id=request_id,
            current_revision=payload.currentRevision,
        )
        if request.aggregate_status == "changes_requested":
            return self._detail(db, request, is_admin=True)
        if request.aggregate_status not in ADMIN_REVIEW_STATUSES | {
            "code_changes_requested"
        }:
            raise HTTPException(
                status_code=409, detail="Request is not awaiting administrator review"
            )
        if revision.merge_request_iid and revision.merge_request_status not in {
            "closed",
            "merged",
        }:
            try:
                self.gitlab.close_merge_request(
                    merge_request_iid=revision.merge_request_iid
                )
                revision.merge_request_status = "closed"
            except PluginPublicationGitLabError as exc:
                raise HTTPException(
                    status_code=502,
                    detail="MR could not be closed; request was not returned",
                ) from exc
        request.aggregate_status = "changes_requested"
        revision.status = "changes_requested"
        self._event(
            db,
            revision_id=revision.id,
            event_type="admin.changes_requested",
            actor_type="admin",
            actor_id=admin_user.id,
            actor_name=admin_user.user_name,
            message=payload.reason.strip(),
            payload={"requiredChanges": payload.requiredChanges},
        )
        db.commit()
        return self._detail(db, request, is_admin=True)

    @trace_sync("plugin.publication.accept", "backend.plugin_publication")
    def accept_request(
        self,
        db: Session,
        *,
        admin_user: User,
        request_id: int,
        payload: AcceptPluginPublicationRequest,
    ) -> PluginPublicationRequestDetail:
        request, revision = self._admin_current_revision(
            db,
            request_id=request_id,
            current_revision=payload.currentRevision,
        )
        if (
            revision.merge_request_iid
            and request.aggregate_status in CODE_REVIEW_STATUSES
        ):
            return self._detail(db, request, is_admin=True)
        if request.aggregate_status not in ADMIN_REVIEW_STATUSES | {"materializing"}:
            raise HTTPException(
                status_code=409, detail="Request is not eligible for acceptance"
            )
        checks = self._checks(db, revision.id)
        blockers = [
            check.check_code
            for check in checks
            if check.severity == "blocker" and check.status in {"blocked", "failed"}
        ]
        if blockers:
            raise HTTPException(
                status_code=409,
                detail={"code": "PUBLICATION_CHECKS_BLOCKED", "checks": blockers},
            )
        required_warnings = {
            check.check_code
            for check in checks
            if check.acknowledgement_required and check.status == "warning"
        }
        acknowledged = set(payload.acknowledgedWarningCodes)
        missing = sorted(required_warnings - acknowledged)
        if missing:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "PUBLICATION_WARNINGS_NOT_ACKNOWLEDGED",
                    "checks": missing,
                },
            )
        for check in checks:
            if (
                check.check_code in acknowledged
                and check.check_code in required_warnings
            ):
                check.acknowledged = True
                check.acknowledged_by_user_id = admin_user.id
        request.aggregate_status = "materializing"
        revision.status = "materializing"
        self._event(
            db,
            revision_id=revision.id,
            event_type="admin.accepted",
            actor_type="admin",
            actor_id=admin_user.id,
            actor_name=admin_user.user_name,
            message="Administrator accepted the revision for MR materialization",
            payload={"acknowledgedWarningCodes": sorted(acknowledged)},
        )
        db.commit()
        return self._materialize(db, request=request, revision=revision)

    @trace_sync("plugin.publication.reconcile", "backend.plugin_publication")
    def reconcile_request(
        self,
        db: Session,
        *,
        admin_user: User,
        request_id: int,
        payload: ReconcilePluginPublicationRequest,
    ) -> PluginPublicationRequestDetail:
        del admin_user
        request, revision = self._admin_current_revision(
            db,
            request_id=request_id,
            current_revision=payload.currentRevision,
        )
        if request.aggregate_status == "materializing":
            return self._materialize(db, request=request, revision=revision)
        if request.aggregate_status not in CODE_REVIEW_STATUSES:
            raise HTTPException(
                status_code=409, detail="Request has no GitLab state to reconcile"
            )
        source_plugin = db.get(Plugin, request.source_plugin_id)
        if not source_plugin:
            raise HTTPException(
                status_code=404, detail="Source personal plugin not found"
            )
        try:
            materialization = self.gitlab.reconcile(
                request_id=request.id,
                revision=revision.revision,
                slug=source_plugin.slug,
                snapshot_sha256=revision.snapshot_sha256,
                source_tree_sha256=revision.source_tree_sha256,
            )
        except PluginPublicationGitLabVerificationError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except PluginPublicationGitLabError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        self._apply_reconciliation(request, revision, materialization)
        self._event(
            db,
            revision_id=revision.id,
            event_type="gitlab.reconciled",
            actor_type="system",
            message="GitLab merge request state reconciled",
        )
        db.commit()
        return self._detail(db, request, is_admin=True)

    def record_gitlab_event(
        self,
        db: Session,
        *,
        payload: dict[str, Any],
        event_id: str,
        event_name: str,
        expected_project_id: str,
    ) -> PluginPublicationRequestDetail | None:
        event_key = f"gitlab:{event_id}"
        if (
            db.query(PluginPublicationEvent.id)
            .filter(PluginPublicationEvent.external_event_id == event_key)
            .first()
        ):
            return None
        project = payload.get("project") or {}
        project_id = str(project.get("id") or payload.get("project_id") or "")
        if project_id != expected_project_id:
            raise HTTPException(
                status_code=403, detail="GitLab event project is not allowed"
            )
        located_revision = self._revision_for_gitlab_event(
            db, payload=payload, project_id=project_id
        )
        if not located_revision:
            return None
        request = (
            db.query(PluginPublicationRequest)
            .filter(PluginPublicationRequest.id == located_revision.request_id)
            .with_for_update()
            .first()
        )
        if not request:
            return None
        if (
            db.query(PluginPublicationEvent.id)
            .filter(PluginPublicationEvent.external_event_id == event_key)
            .first()
        ):
            return None
        revision = (
            db.query(PluginPublicationRevision)
            .filter(
                PluginPublicationRevision.id == located_revision.id,
                PluginPublicationRevision.request_id == request.id,
            )
            .populate_existing()
            .with_for_update()
            .first()
        )
        if not revision:
            return None
        is_current_revision = request.current_revision_id == revision.id
        event_can_mutate = (
            is_current_revision
            and request.aggregate_status not in GITLAB_EVENT_LOCKED_PUBLICATION_STATUSES
        )
        transition_applied = event_can_mutate and self._apply_gitlab_event_status(
            request, revision, event_name, payload
        )
        projected_event = self._project_gitlab_event(
            event_name=event_name,
            payload=payload,
            transition_applied=transition_applied,
        )
        self._event(
            db,
            revision_id=revision.id,
            event_type=projected_event["event_type"],
            actor_type=projected_event["actor_type"],
            actor_name=projected_event["actor_name"],
            message=projected_event["message"],
            payload={
                "eventName": event_name,
                "state": revision.status,
                **projected_event["payload"],
                "reason": (
                    ""
                    if transition_applied
                    else (
                        "stale_revision"
                        if not is_current_revision
                        else (
                            "terminal_or_release_state"
                            if not event_can_mutate
                            else "non_monotonic_or_unsupported"
                        )
                    )
                ),
            },
            external_event_id=event_key,
        )
        db.commit()
        return self._detail(db, request, is_admin=True)

    def _project_gitlab_event(
        self,
        *,
        event_name: str,
        payload: dict[str, Any],
        transition_applied: bool,
    ) -> dict[str, Any]:
        if not transition_applied:
            return {
                "event_type": "gitlab.event_ignored",
                "actor_type": "gitlab",
                "actor_name": None,
                "message": f"GitLab event ignored: {event_name}",
                "payload": {},
            }
        attributes = payload.get("object_attributes") or {}
        normalized_event = event_name.lower()
        if "pipeline" in normalized_event and str(
            attributes.get("status") or ""
        ).lower() in {"failed", "canceled"}:
            return {
                "event_type": "gitlab.pipeline_failed",
                "actor_type": "pipeline",
                "actor_name": None,
                "message": "GitLab Pipeline did not pass",
                "payload": {
                    "pipelineStatus": str(attributes.get("status") or ""),
                    "failureDetails": self._pipeline_failure_details(payload),
                },
            }
        if "merge request" in normalized_event and (
            str(attributes.get("state") or "").lower() == "closed"
            or str(attributes.get("action") or "").lower() == "close"
        ):
            user = payload.get("user") or {}
            actor_name = str(user.get("name") or user.get("username") or "").strip()
            return {
                "event_type": "gitlab.merge_request_closed",
                "actor_type": "gitlab",
                "actor_name": actor_name or None,
                "message": "GitLab merge request was closed without a supplied reason",
                "payload": {"reasonProvided": False},
            }
        return {
            "event_type": "gitlab.event_received",
            "actor_type": "gitlab",
            "actor_name": None,
            "message": f"GitLab event synchronized: {event_name}",
            "payload": {},
        }

    def _pipeline_failure_details(
        self, payload: dict[str, Any]
    ) -> list[dict[str, str]]:
        raw_builds = payload.get("builds")
        if not isinstance(raw_builds, list):
            return []
        details: list[dict[str, str]] = []
        for raw_build in raw_builds[:50]:
            if not isinstance(raw_build, dict):
                continue
            status = str(raw_build.get("status") or "").strip().lower()
            if status not in {"failed", "canceled"}:
                continue
            job_name = str(raw_build.get("name") or "").strip()[:200]
            if not job_name:
                continue
            detail = {
                "jobName": job_name,
                "status": status,
            }
            stage = str(raw_build.get("stage") or "").strip()[:200]
            reason = str(raw_build.get("failure_reason") or "").strip()[:500]
            job_url = str(
                raw_build.get("web_url") or raw_build.get("url") or ""
            ).strip()
            if stage:
                detail["stage"] = stage
            if reason:
                detail["reason"] = reason
            if job_url.startswith(("https://", "http://")):
                detail["jobUrl"] = job_url[:2000]
            details.append(detail)
        return details

    @trace_sync("plugin.publication.release", "backend.plugin_publication")
    def publish_enterprise_release(
        self,
        db: Session,
        *,
        package: bytes,
        metadata: PluginReleaseMetadata,
        idempotency_key: str,
        release_key_id: int,
    ) -> PluginReleasePublishResponse:
        if release_key_id <= 0:
            raise HTTPException(
                status_code=401,
                detail="Authenticated plugin release principal is required",
            )
        release_envelope = metadata.model_dump(mode="json")
        validate_release_idempotency_key(idempotency_key, release_envelope)
        actual_sha256 = hashlib.sha256(package).hexdigest()
        if actual_sha256 != metadata.artifact.sha256:
            raise HTTPException(status_code=422, detail="Artifact SHA256 mismatch")
        envelope = {
            "principal": {
                "type": "plugin_release_key",
                "id": release_key_id,
            },
            "release": release_envelope,
        }
        request_sha256 = release_envelope_sha256(envelope)
        binding, cached_response = self._claim_release_idempotency(
            db,
            idempotency_key=idempotency_key,
            request_sha256=request_sha256,
            artifact_sha256=metadata.artifact.sha256,
            envelope=envelope,
        )
        if cached_response:
            return cached_response
        request: PluginPublicationRequest | None = None
        revision: PluginPublicationRevision | None = None
        try:
            request, revision = self._authorize_release_provenance(
                db, metadata=metadata, package=package
            )
            result = self.marketplace.publish_catalog_release(
                db,
                catalog_namespace=ENTERPRISE_CATALOG_NAMESPACE,
                slug=metadata.plugin.slug,
                package=package,
                listing_type=metadata.plugin.listingType,
                visibility="workspace",
                origin_plugin_id=request.source_plugin_id if request else 0,
                publication_revision_id=revision.id if revision else 0,
                source_commit_sha=metadata.source.sourceCommitSha,
                provenance={
                    "kind": "gitlab_protected_master",
                    "projectId": metadata.source.projectId,
                    "ref": metadata.source.ref,
                    "pipelineId": metadata.source.pipelineId,
                    "pipelineUrl": metadata.source.pipelineUrl,
                    "commitSha": metadata.source.sourceCommitSha,
                    "artifactSha256": metadata.artifact.sha256,
                    "requestId": metadata.requestId,
                    "revision": metadata.revision,
                    "idempotencyKey": idempotency_key,
                    "releaseKeyId": release_key_id,
                    **metadata.source.metadata.model_dump(),
                },
                defer_commit=True,
            )
            if request and revision:
                request.aggregate_status = "published"
                request.target_plugin_id = result.release.plugin_id
                revision.status = "published"
                self._event(
                    db,
                    revision_id=revision.id,
                    event_type="release.published",
                    actor_type="release_service",
                    message=(f"Enterprise release {metadata.plugin.version} published"),
                    payload={
                        "pluginId": result.release.plugin_id,
                        "releaseId": result.release.id,
                    },
                )
            response = PluginReleasePublishResponse(
                pluginId=result.release.plugin_id,
                releaseId=result.release.id,
                created=result.created,
                slug=metadata.plugin.slug,
                version=metadata.plugin.version,
                sha256=metadata.artifact.sha256,
            )
            binding.status = "completed"
            binding.response_json = response.model_dump(mode="json")
            binding.plugin_id = result.release.plugin_id
            binding.release_id = result.release.id
            binding.last_error = ""
            db.commit()
        except Exception as exc:
            db.rollback()
            self._persist_release_failure(
                db,
                idempotency_key=idempotency_key,
                request_sha256=request_sha256,
                artifact_sha256=metadata.artifact.sha256,
                envelope=envelope,
                request_id=metadata.requestId,
                revision_number=metadata.revision,
                error=exc,
            )
            raise
        if result.created:
            self.marketplace.notify_catalog_release(db, result.release.id)
        return response

    def _claim_release_idempotency(
        self,
        db: Session,
        *,
        idempotency_key: str,
        request_sha256: str,
        artifact_sha256: str,
        envelope: dict[str, Any],
    ) -> tuple[PluginReleaseIdempotency, PluginReleasePublishResponse | None]:
        existing = (
            db.query(PluginReleaseIdempotency)
            .filter(PluginReleaseIdempotency.idempotency_key == idempotency_key)
            .with_for_update()
            .first()
        )
        if existing:
            return self._reuse_release_idempotency(
                existing,
                request_sha256=request_sha256,
                artifact_sha256=artifact_sha256,
            )
        binding = PluginReleaseIdempotency(
            idempotency_key=idempotency_key,
            request_sha256=request_sha256,
            artifact_sha256=artifact_sha256,
            envelope_json=envelope,
            status="processing",
            response_json={},
        )
        db.add(binding)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            concurrent = (
                db.query(PluginReleaseIdempotency)
                .filter(PluginReleaseIdempotency.idempotency_key == idempotency_key)
                .with_for_update()
                .first()
            )
            if not concurrent:
                raise
            return self._reuse_release_idempotency(
                concurrent,
                request_sha256=request_sha256,
                artifact_sha256=artifact_sha256,
            )
        return binding, None

    def _reuse_release_idempotency(
        self,
        binding: PluginReleaseIdempotency,
        *,
        request_sha256: str,
        artifact_sha256: str,
    ) -> tuple[PluginReleaseIdempotency, PluginReleasePublishResponse | None]:
        if (
            binding.request_sha256 != request_sha256
            or binding.artifact_sha256 != artifact_sha256
        ):
            raise HTTPException(
                status_code=409,
                detail="Idempotency-Key is already bound to another release request",
            )
        if binding.status == "completed":
            return binding, PluginReleasePublishResponse.model_validate(
                binding.response_json
            )
        if binding.status == "processing":
            raise HTTPException(
                status_code=409,
                detail="Release with this Idempotency-Key is still processing",
            )
        binding.status = "processing"
        binding.last_error = ""
        return binding, None

    def _authorize_release_provenance(
        self,
        db: Session,
        *,
        metadata: PluginReleaseMetadata,
        package: bytes,
    ) -> tuple[
        PluginPublicationRequest | None,
        PluginPublicationRevision | None,
    ]:
        request = None
        revision = None
        if metadata.requestId:
            request = (
                db.query(PluginPublicationRequest)
                .filter(PluginPublicationRequest.id == metadata.requestId)
                .with_for_update()
                .first()
            )
            if not request:
                raise HTTPException(
                    status_code=404, detail="Publication request not found"
                )
            if request.aggregate_status in {"withdrawn", "closed"}:
                raise HTTPException(
                    status_code=409,
                    detail="Withdrawn publication requests cannot be released",
                )
            if metadata.revision != request.current_revision:
                raise HTTPException(
                    status_code=409, detail="Publication revision is stale"
                )
            revision = self._current_revision(db, request)
            if not revision or revision.requested_version != metadata.plugin.version:
                raise HTTPException(
                    status_code=409,
                    detail="Published version does not match the accepted revision",
                )
            if (
                revision.gitlab_project_id != metadata.source.projectId
                or not revision.merge_request_iid
                or not revision.source_branch
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Publication revision has no controlled GitLab merge request",
                )
            self._validate_materialized_risk_contract(package, revision)
            if request.aggregate_status not in CODE_REVIEW_STATUSES | {
                "publishing",
                "publish_failed",
                "published",
            }:
                raise HTTPException(
                    status_code=409,
                    detail="Publication request has not reached code review",
                )
        else:
            active_request = (
                db.query(PluginPublicationRequest.id)
                .join(
                    Plugin,
                    Plugin.id == PluginPublicationRequest.source_plugin_id,
                )
                .filter(
                    Plugin.slug == metadata.plugin.slug,
                    PluginPublicationRequest.aggregate_status.in_(
                        CODE_REVIEW_STATUSES | {"publishing", "publish_failed"}
                    ),
                )
                .first()
            )
            if active_request:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This slug has an active controlled publication request; "
                        "requestId and revision are required"
                    ),
                )
        artifact_tree_sha256 = canonical_complete_tree_sha256(package)
        try:
            self.gitlab.verify_release_provenance(
                project_id=metadata.source.projectId,
                ref=metadata.source.ref,
                commit_sha=metadata.source.sourceCommitSha,
                pipeline_id=metadata.source.pipelineId,
                pipeline_url=metadata.source.pipelineUrl,
                slug=metadata.plugin.slug,
                artifact_tree_sha256=artifact_tree_sha256,
                merge_request_iid=revision.merge_request_iid if revision else 0,
                source_branch=revision.source_branch if revision else "",
            )
        except PluginPublicationGitLabVerificationError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except PluginPublicationGitLabError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if request and revision:
            request.aggregate_status = "publishing"
            revision.status = "publishing"
            revision.commit_sha = metadata.source.sourceCommitSha
        return request, revision

    def _persist_release_failure(
        self,
        db: Session,
        *,
        idempotency_key: str,
        request_sha256: str,
        artifact_sha256: str,
        envelope: dict[str, Any],
        request_id: int | None,
        revision_number: int | None,
        error: Exception,
    ) -> None:
        binding = (
            db.query(PluginReleaseIdempotency)
            .filter(PluginReleaseIdempotency.idempotency_key == idempotency_key)
            .first()
        )
        if not binding:
            binding = PluginReleaseIdempotency(
                idempotency_key=idempotency_key,
                request_sha256=request_sha256,
                artifact_sha256=artifact_sha256,
                envelope_json=envelope,
                response_json={},
            )
            db.add(binding)
        if binding.status != "completed":
            binding.status = "failed"
            binding.last_error = str(error)[:1000]
        if request_id and revision_number:
            request = db.get(PluginPublicationRequest, request_id)
            if (
                request
                and request.current_revision == revision_number
                and request.aggregate_status not in TERMINAL_PUBLICATION_STATUSES
            ):
                revision = self._current_revision(db, request)
                if revision:
                    request.aggregate_status = "publish_failed"
                    revision.status = "publish_failed"
                    self._event(
                        db,
                        revision_id=revision.id,
                        event_type="release.failed",
                        actor_type="release_service",
                        message=(
                            "Enterprise release failed; previous latest remains active"
                        ),
                    )
        db.commit()

    def _validate_materialized_risk_contract(
        self,
        package: bytes,
        revision: PluginPublicationRevision,
    ) -> None:
        try:
            with zipfile.ZipFile(BytesIO(package)) as archive:
                risk = self._read_single_json_member(archive, "plugin-risk.json")
                marker = self._read_single_json_member(
                    archive, ".wework-publication.json"
                )
        except (json.JSONDecodeError, UnicodeDecodeError, zipfile.BadZipFile) as exc:
            raise HTTPException(
                status_code=422, detail="Invalid materialized publication metadata"
            ) from exc
        expected_risk = {
            "schemaVersion": 1,
            "riskDeclaration": dict(revision.risk_declaration or {}),
            "testNotes": revision.test_notes,
        }
        if risk != expected_risk:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Published risk declaration does not match the accepted revision"
                ),
            )
        actual_tree_sha256 = canonical_source_tree_sha256(package)
        if actual_tree_sha256 != revision.source_tree_sha256:
            raise HTTPException(
                status_code=409,
                detail="Published source tree does not match the accepted revision",
            )
        expected_marker = {
            "requestId": revision.request_id,
            "revision": revision.revision,
            "snapshotSha256": revision.snapshot_sha256,
            "sourceTreeSha256": revision.source_tree_sha256,
        }
        if marker != expected_marker:
            raise HTTPException(
                status_code=409,
                detail="Published artifact is not linked to the accepted snapshot",
            )

    def _read_single_json_member(
        self, archive: zipfile.ZipFile, filename: str
    ) -> dict[str, Any]:
        value = json.loads(read_plugin_root_member(archive, filename).decode("utf-8"))
        if not isinstance(value, dict):
            raise HTTPException(
                status_code=422, detail=f"{filename} must contain a JSON object"
            )
        return value

    def has_active_request(self, db: Session, *, source_plugin_id: int) -> bool:
        return (
            db.query(PluginPublicationRequest.id)
            .filter(
                PluginPublicationRequest.source_plugin_id == source_plugin_id,
                PluginPublicationRequest.aggregate_status.notin_(
                    TERMINAL_PUBLICATION_STATUSES
                ),
            )
            .first()
            is not None
        )

    def _source_plugin_for_create(
        self,
        db: Session,
        *,
        user_id: int,
        payload: PluginPublicationCreateRequest,
    ) -> tuple[Plugin, str]:
        namespace = personal_catalog_namespace(user_id)
        if payload.sourcePluginId:
            plugin = (
                db.query(Plugin)
                .filter(Plugin.id == payload.sourcePluginId)
                .with_for_update()
                .first()
            )
            if not plugin or plugin.owner_user_id != user_id:
                raise HTTPException(status_code=404, detail="Personal plugin not found")
            if plugin.visibility != "personal" or plugin.status == "deleted":
                raise HTTPException(
                    status_code=409, detail="Source plugin is not a personal plugin"
                )
            if plugin.catalog_namespace != namespace:
                raise HTTPException(
                    status_code=409,
                    detail="Source plugin catalog identity is not personal",
                )
            if payload.sourceReleaseId:
                release = db.get(PluginRelease, payload.sourceReleaseId)
                if not release or release.plugin_id != plugin.id:
                    raise HTTPException(
                        status_code=422,
                        detail="sourceReleaseId does not belong to sourcePluginId",
                    )
            return plugin, "plugin"
        slug = (payload.slug or "").strip()
        self.marketplace._validate_slug(slug)
        plugin = (
            db.query(Plugin)
            .filter(
                Plugin.catalog_namespace == namespace,
                Plugin.slug == slug,
            )
            .with_for_update()
            .first()
        )
        if plugin:
            if plugin.owner_user_id != user_id:
                raise HTTPException(
                    status_code=409, detail="Personal plugin is not owned"
                )
            return plugin, "slug"
        plugin = Plugin(
            catalog_namespace=namespace,
            slug=slug,
            name=slug,
            display_name=(payload.displayName or slug).strip() or slug,
            listing_type=payload.listingType,
            source_type="submission",
            source_provider="user",
            owner_user_id=user_id,
            keywords_json=[],
            interface_json={},
            visibility="personal",
            status="draft",
        )
        db.add(plugin)
        db.flush()
        return plugin, "slug"

    def _request_uses_slug_source(self, db: Session, *, request_id: int) -> bool:
        created = (
            db.query(PluginPublicationEvent)
            .join(
                PluginPublicationRevision,
                PluginPublicationRevision.id == PluginPublicationEvent.revision_id,
            )
            .filter(
                PluginPublicationRevision.request_id == request_id,
                PluginPublicationEvent.event_type == "request.created",
            )
            .first()
        )
        return bool(
            created and (created.payload_json or {}).get("sourceMode") == "slug"
        )

    def _new_revision(
        self,
        db: Session,
        *,
        request: PluginPublicationRequest,
        revision_number: int,
        user_id: int,
        payload: (
            PluginPublicationCreateRequest | PluginPublicationRevisionCreateRequest
        ),
    ) -> PluginPublicationRevision:
        self.marketplace._validate_version(payload.requestedVersion)
        revision = PluginPublicationRevision(
            request_id=request.id,
            revision=revision_number,
            source_release_id=payload.sourceReleaseId or 0,
            requested_version=payload.requestedVersion,
            snapshot_sha256=payload.snapshotSha256,
            storage_key="",
            staging_storage_key="pending",
            filename=payload.filename,
            size_bytes=payload.sizeBytes,
            manifest_snapshot={},
            package_entries_json=[],
            package_entry_count=0,
            capabilities_json=[],
            risk_declaration=payload.riskDeclaration.model_dump(),
            release_notes=payload.releaseNotes,
            test_notes=payload.testNotes,
            source_updated_at=payload.sourceUpdatedAt or EPOCH_TIME,
            status="uploading",
            created_by_user_id=user_id,
        )
        db.add(revision)
        db.flush()
        revision.staging_storage_key = self._staging_storage_key(
            request.id,
            revision_number,
            revision.id,
            revision.snapshot_sha256,
        )
        return revision

    def _finish_upload_initialization(
        self,
        db: Session,
        *,
        request: PluginPublicationRequest,
        revision: PluginPublicationRevision,
    ) -> PluginPublicationUploadResponse:
        try:
            upload_url, expires_at = build_plugin_publication_upload_url(
                request_id=request.id,
                revision=revision.revision,
                user_id=request.submitter_user_id,
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        return PluginPublicationUploadResponse(
            requestId=request.id,
            sourcePluginId=request.source_plugin_id,
            revision=self._revision_item(revision),
            uploadUrl=upload_url,
            expiresAt=expires_at,
        )

    def _lock_submitter_for_activation(self, db: Session, *, user_id: int) -> None:
        """Serialize every transition that starts an active owner request."""
        submitter = (
            db.query(User.id).filter(User.id == user_id).with_for_update().first()
        )
        if not submitter:
            raise HTTPException(
                status_code=404, detail="Publication submitter not found"
            )

    def _lock_active_requests_with_capacity(
        self, db: Session, *, user_id: int
    ) -> list[tuple[int, int]]:
        capacity = settings.WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS
        active_requests = (
            db.query(
                PluginPublicationRequest.id,
                PluginPublicationRequest.source_plugin_id,
            )
            .filter(
                PluginPublicationRequest.submitter_user_id == user_id,
                PluginPublicationRequest.aggregate_status.notin_(
                    TERMINAL_PUBLICATION_STATUSES
                ),
            )
            .order_by(PluginPublicationRequest.id.asc())
            .limit(capacity)
            .with_for_update()
            .all()
        )
        if len(active_requests) >= capacity:
            raise HTTPException(
                status_code=429,
                detail="Too many active plugin publication requests",
            )
        return [
            (int(request_id), int(source_plugin_id))
            for request_id, source_plugin_id in active_requests
        ]

    def _fail_automatic_checks(
        self,
        db: Session,
        *,
        request_id: int,
        revision_id: int,
        user_id: int,
        code: str,
        message: str,
    ) -> PluginPublicationRequestDetail:
        db.rollback()
        request = db.get(PluginPublicationRequest, request_id)
        revision = db.get(PluginPublicationRevision, revision_id)
        if not request or not revision:
            raise HTTPException(
                status_code=404, detail="Publication revision not found"
            )
        request.aggregate_status = "automatic_check_failed"
        request.risk_level = "critical"
        revision.status = "automatic_check_failed"
        revision.completed_at = _utc_now()
        self._replace_checks(
            db,
            revision.id,
            [
                PublicationCheckResult(
                    code=code,
                    title="Snapshot validation",
                    severity="blocker",
                    status="failed",
                    summary=message[:1000],
                    evidence=[],
                )
            ],
        )
        self._event(
            db,
            revision_id=revision.id,
            event_type="automatic_checks.failed",
            actor_type="system",
            actor_id=user_id,
            message=message[:1000],
        )
        db.commit()
        return self._detail(db, request)

    def _materialize(
        self,
        db: Session,
        *,
        request: PluginPublicationRequest,
        revision: PluginPublicationRevision,
    ) -> PluginPublicationRequestDetail:
        source_plugin = db.get(Plugin, request.source_plugin_id)
        if not source_plugin:
            raise HTTPException(
                status_code=404, detail="Source personal plugin not found"
            )
        try:
            package = self.storage.get(revision.storage_key)
            materialization = self.gitlab.materialize(
                request_id=request.id,
                revision=revision.revision,
                slug=source_plugin.slug,
                plugin_name=(
                    source_plugin.display_name
                    or source_plugin.name
                    or source_plugin.slug
                ),
                version=revision.requested_version,
                snapshot_sha256=revision.snapshot_sha256,
                source_tree_sha256=revision.source_tree_sha256,
                package=package,
                risk_declaration=dict(revision.risk_declaration or {}),
                test_notes=revision.test_notes,
            )
        except (PluginPackageStorageError, PluginPublicationGitLabError) as exc:
            failed_request = db.get(PluginPublicationRequest, request.id)
            failed_revision = db.get(PluginPublicationRevision, revision.id)
            if failed_request and failed_revision:
                self._event(
                    db,
                    revision_id=failed_revision.id,
                    event_type="gitlab.materialization_failed",
                    actor_type="system",
                    message=str(exc)[:1000],
                )
                db.commit()
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        request = (
            db.query(PluginPublicationRequest)
            .filter(PluginPublicationRequest.id == request.id)
            .populate_existing()
            .with_for_update()
            .one()
        )
        revision = (
            db.query(PluginPublicationRevision)
            .filter(PluginPublicationRevision.id == revision.id)
            .populate_existing()
            .with_for_update()
            .one()
        )
        if (
            request.current_revision_id == revision.id
            and request.aggregate_status in CODE_REVIEW_STATUSES
            and revision.merge_request_iid == materialization.merge_request_iid
        ):
            return self._detail(db, request, is_admin=True)
        if (
            request.current_revision_id != revision.id
            or request.aggregate_status != "materializing"
        ):
            self._discard_stale_materialization(materialization)
            self._event(
                db,
                revision_id=revision.id,
                event_type="gitlab.materialization_ignored",
                actor_type="system",
                message="MR materialization finished after request state changed",
                payload={
                    "mergeRequestIid": materialization.merge_request_iid,
                    "currentStatus": request.aggregate_status,
                },
            )
            db.commit()
            return self._detail(db, request, is_admin=True)
        self._apply_materialization(request, revision, materialization)
        self._event(
            db,
            revision_id=revision.id,
            event_type="gitlab.draft_mr_created",
            actor_type="system",
            message=f"MR !{materialization.merge_request_iid} created",
            payload={
                "mergeRequestUrl": materialization.merge_request_url,
                "commitSha": materialization.commit_sha,
            },
        )
        db.commit()
        return self._detail(db, request, is_admin=True)

    def _discard_stale_materialization(
        self, materialization: GitLabMaterialization
    ) -> None:
        if not materialization.merge_request_iid:
            return
        try:
            self.gitlab.close_merge_request(
                merge_request_iid=materialization.merge_request_iid
            )
        except PluginPublicationGitLabError:
            logger.warning(
                "Failed to close stale publication MR: iid=%s",
                materialization.merge_request_iid,
                exc_info=True,
            )

    def _apply_materialization(
        self,
        request: PluginPublicationRequest,
        revision: PluginPublicationRevision,
        materialization: GitLabMaterialization,
    ) -> None:
        self._apply_materialization_coordinates(revision, materialization)
        target_status = (
            "merged"
            if materialization.merge_request_status == "merged"
            else "draft_mr_open"
        )
        revision.status = target_status
        request.aggregate_status = target_status

    def _apply_reconciliation(
        self,
        request: PluginPublicationRequest,
        revision: PluginPublicationRevision,
        materialization: GitLabMaterialization,
    ) -> None:
        self._apply_materialization_coordinates(revision, materialization)
        target_status = {
            "merged": "merged",
            "closed": "closed",
        }.get(materialization.merge_request_status)
        if target_status in ALLOWED_GITLAB_TRANSITIONS.get(
            request.aggregate_status, set()
        ):
            revision.status = target_status
            request.aggregate_status = target_status

    def _apply_materialization_coordinates(
        self,
        revision: PluginPublicationRevision,
        materialization: GitLabMaterialization,
    ) -> None:
        revision.gitlab_project_id = materialization.project_id
        revision.gitlab_project_url = materialization.project_url
        revision.source_branch = materialization.source_branch
        revision.merge_request_iid = materialization.merge_request_iid
        revision.merge_request_url = materialization.merge_request_url
        revision.merge_request_status = materialization.merge_request_status
        revision.commit_sha = materialization.commit_sha

    def _revision_for_gitlab_event(
        self,
        db: Session,
        *,
        payload: dict[str, Any],
        project_id: str,
    ) -> PluginPublicationRevision | None:
        attributes = payload.get("object_attributes") or {}
        merge_request = payload.get("merge_request") or attributes
        mr_iid = self._positive_int(merge_request.get("iid"))
        if mr_iid:
            return (
                db.query(PluginPublicationRevision)
                .filter(
                    PluginPublicationRevision.gitlab_project_id == project_id,
                    PluginPublicationRevision.merge_request_iid == mr_iid,
                )
                .first()
            )
        raw_ref = str(attributes.get("ref") or payload.get("ref") or "")
        ref = raw_ref.removeprefix("refs/heads/")
        match = CONTROLLED_SOURCE_BRANCH.fullmatch(ref)
        if not match:
            return None
        return (
            db.query(PluginPublicationRevision)
            .filter(
                PluginPublicationRevision.request_id == int(match.group("request_id")),
                PluginPublicationRevision.revision == int(match.group("revision")),
                PluginPublicationRevision.gitlab_project_id == project_id,
                PluginPublicationRevision.source_branch == ref,
            )
            .first()
        )

    def _apply_gitlab_event_status(
        self,
        request: PluginPublicationRequest,
        revision: PluginPublicationRevision,
        event_name: str,
        payload: dict[str, Any],
    ) -> bool:
        attributes = payload.get("object_attributes") or {}
        normalized_event = event_name.lower()
        target_status = ""
        if "merge request" in normalized_event:
            state = str(attributes.get("state") or "")
            action = str(attributes.get("action") or "")
            if state == "merged" or action == "merge":
                target_status = "merged"
            elif state == "closed" or action == "close":
                target_status = "closed"
            elif state == "opened" or action in {"open", "reopen"}:
                target_status = "draft_mr_open"
        elif "pipeline" in normalized_event:
            if not self._pipeline_event_matches_revision(revision, attributes):
                return False
            pipeline_status = str(attributes.get("status") or "")
            if pipeline_status in {"running", "pending", "created"}:
                target_status = "ci_running"
            elif pipeline_status == "success":
                target_status = "merge_ready"
            elif pipeline_status in {"failed", "canceled"}:
                target_status = "code_changes_requested"
        allowed = ALLOWED_GITLAB_TRANSITIONS.get(request.aggregate_status, set())
        if not target_status or target_status not in allowed:
            return False
        if "merge request" in normalized_event:
            revision.merge_request_status = str(
                attributes.get("state") or attributes.get("action") or ""
            )
            if target_status == "merged":
                revision.commit_sha = str(
                    attributes.get("merge_commit_sha")
                    or attributes.get("last_commit", {}).get("id")
                    or revision.commit_sha
                )
        else:
            revision.pipeline_status = str(attributes.get("status") or "")
            revision.pipeline_id = self._positive_int(
                attributes.get("id"), default=revision.pipeline_id
            )
            revision.pipeline_url = str(attributes.get("url") or revision.pipeline_url)
        revision.status = request.aggregate_status = target_status
        return True

    def _pipeline_event_matches_revision(
        self,
        revision: PluginPublicationRevision,
        attributes: dict[str, Any],
    ) -> bool:
        pipeline_id = self._positive_int(attributes.get("id"))
        pipeline_sha = str(attributes.get("sha") or "").strip().lower()
        pipeline_status = str(attributes.get("status") or "").strip().lower()
        materialized_sha = str(revision.commit_sha or "").strip().lower()
        if (
            pipeline_id <= 0
            or pipeline_status not in PIPELINE_STATUS_ORDER
            or not re.fullmatch(r"[0-9a-f]{40}", pipeline_sha)
            or pipeline_sha != materialized_sha
            or not re.fullmatch(r"[0-9a-f]{64}", revision.snapshot_sha256 or "")
            or not re.fullmatch(r"[0-9a-f]{64}", revision.source_tree_sha256 or "")
        ):
            return False
        # The materializer commit is accepted only after its marker binds this
        # revision's snapshot and source-tree hashes. Matching that exact commit
        # therefore keeps the pipeline event on the same immutable revision.
        if not revision.pipeline_id or pipeline_id > revision.pipeline_id:
            return True
        if pipeline_id < revision.pipeline_id:
            return False
        current_status = str(revision.pipeline_status or "").strip().lower()
        if current_status in TERMINAL_PIPELINE_STATUSES:
            return False
        if current_status not in PIPELINE_STATUS_ORDER:
            return True
        return (
            PIPELINE_STATUS_ORDER[pipeline_status]
            > PIPELINE_STATUS_ORDER[current_status]
        )

    def _positive_int(self, value: Any, *, default: int = 0) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    def _owned_request(
        self,
        db: Session,
        *,
        user_id: int,
        request_id: int,
        for_update: bool = False,
    ) -> PluginPublicationRequest:
        query = db.query(PluginPublicationRequest).filter(
            PluginPublicationRequest.id == request_id
        )
        if for_update:
            query = query.with_for_update()
        request = query.first()
        if not request or request.submitter_user_id != user_id:
            raise HTTPException(status_code=404, detail="Publication request not found")
        return request

    def _owned_current_revision(
        self,
        db: Session,
        *,
        user_id: int,
        request_id: int,
        revision_number: int | None,
        for_update: bool,
    ) -> tuple[PluginPublicationRequest, PluginPublicationRevision]:
        request = self._owned_request(
            db, user_id=user_id, request_id=request_id, for_update=for_update
        )
        if revision_number is not None and request.current_revision != revision_number:
            raise HTTPException(status_code=409, detail="Publication revision is stale")
        revision = self._current_revision(db, request)
        if not revision:
            raise HTTPException(
                status_code=404, detail="Publication revision not found"
            )
        return request, revision

    def _admin_current_revision(
        self,
        db: Session,
        *,
        request_id: int,
        current_revision: int,
    ) -> tuple[PluginPublicationRequest, PluginPublicationRevision]:
        request = (
            db.query(PluginPublicationRequest)
            .filter(PluginPublicationRequest.id == request_id)
            .with_for_update()
            .first()
        )
        if not request:
            raise HTTPException(status_code=404, detail="Publication request not found")
        if request.current_revision != current_revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "PUBLICATION_REVISION_STALE",
                    "currentRevision": request.current_revision,
                },
            )
        revision = self._current_revision(db, request)
        if not revision:
            raise HTTPException(
                status_code=404, detail="Publication revision not found"
            )
        return request, revision

    def _summary(
        self, db: Session, request: PluginPublicationRequest
    ) -> PluginPublicationRequestSummary:
        plugin = db.get(Plugin, request.source_plugin_id)
        revision = self._current_revision(db, request)
        submitter = db.get(User, request.submitter_user_id)
        checks = self._checks(db, revision.id) if revision else []
        submitted_at = (
            request.submitted_at
            if unset_datetime(request.submitted_at) is not None
            else request.created_at
        )
        return PluginPublicationRequestSummary(
            id=request.id,
            pluginId=request.source_plugin_id,
            pluginName=(plugin.display_name or plugin.name) if plugin else "",
            pluginSlug=plugin.slug if plugin else "",
            requestedVersion=revision.requested_version if revision else "",
            submitter=PluginPublicationSubmitter(
                id=request.submitter_user_id,
                userName=submitter.user_name if submitter else "",
                email=getattr(submitter, "email", None) if submitter else None,
            ),
            currentRevision=request.current_revision,
            stage=self._stage(request.aggregate_status),
            status=request.aggregate_status,
            riskLevel=request.risk_level,
            blockerCount=sum(
                check.severity == "blocker" and check.status in {"blocked", "failed"}
                for check in checks
            ),
            warningCount=sum(check.status == "warning" for check in checks),
            gitlabStatus=self._gitlab_status(revision) if revision else None,
            waitingDurationSeconds=self._waiting_duration_seconds(
                request,
                submitted_at=submitted_at,
            ),
            submittedAt=submitted_at,
            updatedAt=request.updated_at,
        )

    def _detail(
        self,
        db: Session,
        request: PluginPublicationRequest,
        *,
        is_admin: bool = False,
        revision_number: int | None = None,
    ) -> PluginPublicationRequestDetail:
        summary = self._summary(db, request)
        current_revision = self._current_revision(db, request)
        if not current_revision:
            raise HTTPException(
                status_code=404, detail="Publication revision not found"
            )
        revision = current_revision
        if revision_number is not None:
            revision = (
                db.query(PluginPublicationRevision)
                .filter(
                    PluginPublicationRevision.request_id == request.id,
                    PluginPublicationRevision.revision == revision_number,
                )
                .first()
            )
            if not revision:
                raise HTTPException(
                    status_code=404,
                    detail="Publication revision not found",
                )
        selected_checks = self._checks(db, revision.id)
        current_checks = (
            selected_checks
            if revision.id == current_revision.id
            else self._checks(db, current_revision.id)
        )
        revision_rows = (
            db.query(PluginPublicationRevision)
            .filter(PluginPublicationRevision.request_id == request.id)
            .order_by(PluginPublicationRevision.revision.asc())
            .all()
        )
        revision_items = [
            self._revision_item(row, checks=self._checks(db, row.id))
            for row in revision_rows
        ]
        events = (
            db.query(PluginPublicationEvent)
            .filter(PluginPublicationEvent.revision_id == revision.id)
            .order_by(
                PluginPublicationEvent.created_at.asc(), PluginPublicationEvent.id
            )
            .all()
        )
        gitlab = None
        if revision.gitlab_project_id or revision.merge_request_iid:
            gitlab = self._gitlab_state(revision)
        return PluginPublicationRequestDetail(
            **summary.model_dump(),
            enterprisePluginId=request.target_plugin_id or None,
            revision=self._revision_item(revision, checks=selected_checks),
            revisions=revision_items,
            checks=[self._check_item(check) for check in selected_checks],
            events=[self._event_item(event) for event in events],
            gitlab=gitlab,
            actionEligibility=self._action_eligibility(
                request, current_checks, is_admin=is_admin
            ),
        )

    def _current_revision(
        self,
        db: Session,
        request: PluginPublicationRequest,
    ) -> PluginPublicationRevision | None:
        """Resolve the aggregate pointer only when it belongs to this request."""
        return (
            db.query(PluginPublicationRevision)
            .filter(
                PluginPublicationRevision.id == request.current_revision_id,
                PluginPublicationRevision.request_id == request.id,
            )
            .first()
        )

    def _normalize_query_datetime(self, value: datetime | None) -> datetime | None:
        if value is None or value.tzinfo is None:
            return value
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def _waiting_duration_seconds(
        self,
        request: PluginPublicationRequest,
        *,
        submitted_at: datetime,
    ) -> int:
        end = (
            request.updated_at
            if request.aggregate_status in TERMINAL_PUBLICATION_STATUSES
            else _utc_now()
        )
        return max(0, int((end - submitted_at).total_seconds()))

    def _gitlab_state(
        self, revision: PluginPublicationRevision
    ) -> PluginPublicationGitLabState:
        return PluginPublicationGitLabState(
            projectUrl=revision.gitlab_project_url or None,
            sourceBranch=revision.source_branch or None,
            mergeRequestIid=revision.merge_request_iid or None,
            mergeRequestUrl=revision.merge_request_url or None,
            mergeRequestStatus=revision.merge_request_status or None,
            pipelineId=revision.pipeline_id or None,
            pipelineUrl=revision.pipeline_url or None,
            pipelineStatus=revision.pipeline_status or None,
            commitSha=revision.commit_sha or None,
        )

    def _gitlab_status(self, revision: PluginPublicationRevision) -> str | None:
        if revision.merge_request_status in {"merged", "closed"}:
            return revision.merge_request_status
        return revision.pipeline_status or revision.merge_request_status or None

    def _capability_inventory(
        self,
        inspection: PublicationInspection,
    ) -> list[str]:
        components = inspection.parsed.components.model_dump(exclude_none=True)
        capabilities: list[str] = []
        seen: set[str] = set()

        def append(value: str) -> None:
            cleaned = self._trim_review_text(value.strip(), limit=300)
            if (
                cleaned
                and cleaned not in seen
                and len(capabilities) < MAX_REVIEW_CAPABILITIES
            ):
                seen.add(cleaned)
                capabilities.append(cleaned)

        component_types = (
            "skills",
            "commands",
            "agents",
            "hooks",
            "mcps",
            "connectors",
            "lsps",
            "monitors",
            "bins",
        )
        for component_type in component_types:
            singular = component_type[:-1]
            for item in components.get(component_type, []):
                if not isinstance(item, dict):
                    continue
                name = item.get("name") or item.get("slug")
                if name:
                    append(f"{singular}:{name}")
        workbench = components.get("workbench")
        if isinstance(workbench, dict):
            if workbench.get("frontend"):
                append("workbench:frontend")
            desktop = workbench.get("desktop")
            if isinstance(desktop, dict):
                append("workbench:desktop")
                for capability in desktop.get("capabilities") or []:
                    append(f"workbench:{capability}")
        if inspection.parsed.interface:
            for capability in inspection.parsed.interface.capabilities:
                append(f"interface:{capability}")
        return capabilities[:MAX_REVIEW_CAPABILITIES]

    def _safe_manifest_snapshot(self, manifest: dict[str, Any]) -> dict[str, Any]:
        budget = [MAX_REVIEW_MANIFEST_NODES]
        sanitized = self._safe_manifest_value(manifest, budget=budget)
        return sanitized if isinstance(sanitized, dict) else {}

    def _safe_manifest_value(
        self,
        value: Any,
        *,
        budget: list[int],
        depth: int = 0,
    ) -> Any:
        if budget[0] <= 0 or depth >= MAX_REVIEW_MANIFEST_DEPTH:
            return "[truncated]"
        budget[0] -= 1
        if isinstance(value, dict):
            output: dict[str, Any] = {}
            keys = list(value)
            selected_keys = sorted(
                keys[:MAX_REVIEW_MANIFEST_COLLECTION_ITEMS],
                key=lambda item: str(item).encode("utf-8"),
            )
            for raw_key in selected_keys:
                key = self._trim_review_text(str(raw_key), limit=200)
                if key in output:
                    continue
                if SENSITIVE_MANIFEST_KEY.search(key):
                    output[key] = "[redacted]"
                else:
                    output[key] = self._safe_manifest_value(
                        value[raw_key], budget=budget, depth=depth + 1
                    )
            if len(keys) > MAX_REVIEW_MANIFEST_COLLECTION_ITEMS:
                output["__truncated__"] = (
                    f"{len(keys) - MAX_REVIEW_MANIFEST_COLLECTION_ITEMS} keys omitted"
                )
            return output
        if isinstance(value, list):
            result = [
                self._safe_manifest_value(
                    item,
                    budget=budget,
                    depth=depth + 1,
                )
                for item in value[:MAX_REVIEW_MANIFEST_COLLECTION_ITEMS]
            ]
            if len(value) > MAX_REVIEW_MANIFEST_COLLECTION_ITEMS:
                result.append(
                    f"[{len(value) - MAX_REVIEW_MANIFEST_COLLECTION_ITEMS} items omitted]"
                )
            return result
        if value is None or isinstance(value, (bool, int)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else str(value)
        if isinstance(value, str):
            return self._trim_review_text(
                value,
                limit=MAX_REVIEW_MANIFEST_STRING_LENGTH,
            )
        return self._trim_review_text(
            str(value),
            limit=MAX_REVIEW_MANIFEST_STRING_LENGTH,
        )

    def _trim_review_text(self, value: str, *, limit: int) -> str:
        if len(value) <= limit:
            return value
        return f"{value[: limit - 3]}..."

    def _revision_item(
        self,
        revision: PluginPublicationRevision,
        *,
        checks: list[PluginPublicationCheck] | None = None,
    ) -> PluginPublicationRevisionItem:
        declaration = dict(revision.risk_declaration or {})
        checks_by_code = {check.check_code: check for check in checks or []}
        command_check = checks_by_code.get("risk.command_declaration")
        items: list[PluginPublicationDeclaration] = []
        for key, label in DECLARATION_LABELS.items():
            value = declaration.get(key)
            declared = bool(value)
            details: list[str] = []
            if key == "externalNetworkAccess":
                details = list(declaration.get("externalDomains") or [])
            elif key == "executesCommands":
                details = list(declaration.get("commandExamples") or [])
            elif key == "applicationPermissions":
                details = list(value or [])
            detected = None
            if key == "executesCommands" and command_check:
                detected = command_check.status in {"warning", "blocked"}
            items.append(
                PluginPublicationDeclaration(
                    key=key,
                    label=label,
                    declared=declared,
                    detected=detected,
                    confirmed=(
                        command_check.acknowledged
                        if key == "executesCommands" and command_check
                        else None
                    ),
                    details=[str(item) for item in details],
                )
            )
        return PluginPublicationRevisionItem(
            id=revision.id,
            number=revision.revision,
            requestedVersion=revision.requested_version,
            snapshotSha256=revision.snapshot_sha256,
            sourceTreeSha256=revision.source_tree_sha256 or None,
            status=revision.status,
            releaseNotes=revision.release_notes or None,
            testNotes=revision.test_notes or None,
            sourceUpdatedAt=unset_datetime(revision.source_updated_at),
            createdAt=revision.created_at,
            declarations=items,
            manifest=self._safe_manifest_snapshot(
                dict(revision.manifest_snapshot or {})
            ),
            packageEntries=[
                self._trim_review_text(str(path), limit=1_000)
                for path in (revision.package_entries_json or [])[
                    :MAX_REVIEW_PACKAGE_ENTRIES
                ]
            ],
            packageEntryCount=revision.package_entry_count,
            packageEntriesTruncated=(
                revision.package_entry_count > len(revision.package_entries_json or [])
            ),
            capabilities=[
                self._trim_review_text(str(capability), limit=300)
                for capability in (revision.capabilities_json or [])[
                    :MAX_REVIEW_CAPABILITIES
                ]
            ],
        )

    def _check_item(self, check: PluginPublicationCheck) -> PluginPublicationCheckItem:
        return PluginPublicationCheckItem(
            id=check.id,
            checkCode=check.check_code,
            title=check.title,
            severity=check.severity,
            status=check.status,
            summary=check.summary or None,
            evidence=[str(value) for value in (check.evidence_json or [])],
            jobUrl=check.job_url or None,
            acknowledgementRequired=check.acknowledgement_required,
            acknowledged=check.acknowledged,
        )

    def _event_item(self, event: PluginPublicationEvent) -> PluginPublicationEventItem:
        required_changes: list[str] = []
        failure_details: list[PluginPublicationFailureDetail] = []
        if isinstance(event.payload_json, dict):
            raw_changes = event.payload_json.get("requiredChanges")
            if isinstance(raw_changes, list):
                required_changes = [
                    value.strip()[:500]
                    for value in raw_changes[:100]
                    if isinstance(value, str) and value.strip()
                ]
            raw_failures = event.payload_json.get("failureDetails")
            if isinstance(raw_failures, list):
                for value in raw_failures[:50]:
                    if not isinstance(value, dict):
                        continue
                    try:
                        failure_details.append(
                            PluginPublicationFailureDetail.model_validate(value)
                        )
                    except ValueError:
                        continue
        return PluginPublicationEventItem(
            id=event.id,
            eventType=event.event_type,
            actorType=event.actor_type,
            actorName=event.actor_name or None,
            message=event.message,
            requiredChanges=required_changes,
            failureDetails=failure_details,
            createdAt=event.created_at,
        )

    def _checks(self, db: Session, revision_id: int) -> list[PluginPublicationCheck]:
        return (
            db.query(PluginPublicationCheck)
            .filter(PluginPublicationCheck.revision_id == revision_id)
            .order_by(PluginPublicationCheck.id)
            .all()
        )

    def _replace_checks(
        self,
        db: Session,
        revision_id: int,
        checks: list[PublicationCheckResult],
    ) -> None:
        (
            db.query(PluginPublicationCheck)
            .filter(PluginPublicationCheck.revision_id == revision_id)
            .delete(synchronize_session=False)
        )
        for check in checks:
            db.add(
                PluginPublicationCheck(
                    revision_id=revision_id,
                    stage="automatic",
                    check_code=check.code,
                    title=check.title,
                    severity=check.severity,
                    status=check.status,
                    summary=check.summary[:1000],
                    evidence_json=check.evidence,
                    execution_environment=check.execution_environment,
                    acknowledgement_required=check.acknowledgement_required,
                )
            )

    def _event(
        self,
        db: Session,
        *,
        revision_id: int,
        event_type: str,
        actor_type: str,
        message: str,
        actor_id: int = 0,
        actor_name: str = "",
        payload: dict[str, Any] | None = None,
        external_event_id: str | None = None,
    ) -> None:
        db.add(
            PluginPublicationEvent(
                revision_id=revision_id,
                event_type=event_type,
                actor_type=actor_type,
                actor_id=actor_id,
                actor_name=actor_name,
                message=message[:1000],
                payload_json=payload or {},
                external_event_id=external_event_id or f"internal:{uuid.uuid4()}",
            )
        )

    def _action_eligibility(
        self,
        request: PluginPublicationRequest,
        checks: list[PluginPublicationCheck],
        *,
        is_admin: bool,
    ) -> PluginPublicationActionEligibility:
        blocked = [
            check.check_code
            for check in checks
            if check.severity == "blocker" and check.status in {"blocked", "failed"}
        ]
        in_admin_review = request.aggregate_status in ADMIN_REVIEW_STATUSES
        return PluginPublicationActionEligibility(
            canWithdraw=(
                not is_admin
                and request.aggregate_status in WITHDRAWABLE_PUBLICATION_STATUSES
            ),
            canCreateRevision=(
                not is_admin
                and request.aggregate_status in REVISION_CREATABLE_PUBLICATION_STATUSES
            ),
            canViewEnterprisePlugin=(
                not is_admin
                and request.aggregate_status == "published"
                and bool(request.target_plugin_id)
            ),
            canReturn=is_admin
            and (
                in_admin_review or request.aggregate_status == "code_changes_requested"
            ),
            canAccept=is_admin and in_admin_review and not blocked,
            canReconcile=(
                is_admin and request.aggregate_status in CODE_REVIEW_STATUSES
            ),
            blockedReasons=blocked,
        )

    def _stage(self, status: str) -> str:
        if status in {"uploading", "submitted"}:
            return "submit_request"
        if status in {"automatic_checking", "automatic_check_failed"}:
            return "automated_checks"
        if status in ADMIN_REVIEW_STATUSES | {"changes_requested", "admin_accepted"}:
            return "administrator_review"
        if status in CODE_REVIEW_STATUSES:
            return "code_review"
        return "release"

    def _checks_status(self, checks: list[PublicationCheckResult]) -> str:
        if any(
            check.severity == "blocker" and check.status in {"blocked", "failed"}
            for check in checks
        ):
            return "automatic_check_failed"
        return "awaiting_admin"

    def _risk_level(self, checks: list[PublicationCheckResult]) -> str:
        blocker_count = sum(
            check.severity == "blocker" and check.status in {"blocked", "failed"}
            for check in checks
        )
        warning_count = sum(check.status == "warning" for check in checks)
        if blocker_count:
            return "critical"
        if warning_count >= 3:
            return "high"
        if warning_count == 2:
            return "medium"
        if warning_count == 1:
            return "low"
        return "none"

    def _staging_storage_key(
        self, request_id: int, revision: int, revision_id: int, digest: str
    ) -> str:
        return (
            f"plugins/publications/staging/{request_id}/{revision}/"
            f"{revision_id}-{digest}.zip"
        )

    def _snapshot_storage_key(self, request_id: int, revision: int, digest: str) -> str:
        return f"plugins/publications/{request_id}/{revision}/{digest}.zip"

    def _delete_object_best_effort(self, storage_key: str) -> None:
        if not storage_key or storage_key == "pending":
            return
        try:
            self.storage.delete(storage_key)
        except Exception:
            logger.warning(
                "Failed to delete publication staging object: key=%s",
                storage_key,
                exc_info=True,
            )


plugin_publication_service = PluginPublicationService()
