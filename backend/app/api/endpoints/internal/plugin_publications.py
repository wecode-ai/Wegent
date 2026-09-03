# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal callbacks for the protected plugin publication pipeline."""

from __future__ import annotations

import hashlib
import json
import secrets
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.schemas.plugin_publication import (
    PluginGitLabWebhookResponse,
    PluginReleaseMetadata,
    PluginReleaseProvenance,
    PluginReleasePublishResponse,
)
from app.services.auth.plugin_release_key import (
    PluginReleasePrincipal,
    verify_plugin_release_key,
)
from app.services.plugin_package_parser import (
    MAX_PLUGIN_PACKAGE_SIZE_BYTES,
    plugin_package_parser,
)
from app.services.plugin_publication_artifact import (
    validate_release_idempotency_key_format,
)
from app.services.plugin_publication_service import plugin_publication_service

router = APIRouter(prefix="/plugins", tags=["plugin-publications-internal"])
UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024


@router.post("/releases", response_model=PluginReleasePublishResponse)
async def publish_plugin_release(
    metadata: Annotated[str, Form(...)],
    package: Annotated[UploadFile, File(...)],
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=81, max_length=81)
    ],
    principal: PluginReleasePrincipal = Depends(verify_plugin_release_key),
    db: Session = Depends(get_db),
) -> PluginReleasePublishResponse:
    """Publish the exact artifact produced by a protected master pipeline."""
    release_metadata = _parse_metadata(metadata)
    validate_release_idempotency_key_format(idempotency_key)
    provenance = release_metadata.source
    _ensure_protected_master(provenance)
    package_bytes = await _read_package(package)
    if release_metadata.artifact.file != (package.filename or ""):
        raise HTTPException(status_code=422, detail="Artifact filename mismatch")
    artifact_sha256 = hashlib.sha256(package_bytes).hexdigest()
    if release_metadata.artifact.sha256 != artifact_sha256:
        raise HTTPException(status_code=422, detail="Artifact SHA256 mismatch")
    if release_metadata.artifact.sizeBytes != len(package_bytes):
        raise HTTPException(status_code=422, detail="Artifact size mismatch")
    parsed = plugin_package_parser.parse_package(package_bytes)
    if not parsed.version:
        raise HTTPException(status_code=422, detail="Plugin version is required")
    if (
        parsed.name != release_metadata.plugin.slug
        or parsed.version != release_metadata.plugin.version
    ):
        raise HTTPException(
            status_code=422,
            detail="Artifact manifest does not match release metadata",
        )
    return plugin_publication_service.publish_enterprise_release(
        db,
        package=package_bytes,
        metadata=release_metadata,
        idempotency_key=idempotency_key,
        release_key_id=principal.key_id,
    )


@router.post("/gitlab/events", response_model=PluginGitLabWebhookResponse)
async def synchronize_gitlab_event(
    request: Request,
    gitlab_token: Annotated[str, Header(alias="X-Gitlab-Token")],
    event_name: Annotated[str, Header(alias="X-Gitlab-Event")],
    event_id: Annotated[str, Header(alias="X-Gitlab-Event-UUID")],
    db: Session = Depends(get_db),
) -> PluginGitLabWebhookResponse:
    """Synchronize GitLab state; this endpoint never publishes an artifact."""
    expected = settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Plugin publication GitLab webhook is not configured",
        )
    if not secrets.compare_digest(gitlab_token, expected):
        raise HTTPException(status_code=401, detail="Invalid GitLab webhook token")
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="GitLab event must be an object")
    configured_project = settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID
    if not configured_project:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Plugin publication GitLab project is not configured",
        )
    event_project = _gitlab_project_id(payload)
    if event_project != configured_project:
        raise HTTPException(
            status_code=403, detail="GitLab event project is not allowed"
        )
    detail = plugin_publication_service.record_gitlab_event(
        db,
        payload=payload,
        event_id=event_id,
        event_name=event_name,
        expected_project_id=configured_project,
    )
    return PluginGitLabWebhookResponse(
        requestId=detail.id if detail else None,
        status=detail.status if detail else None,
    )


def _parse_metadata(value: str) -> PluginReleaseMetadata:
    try:
        raw: Any = json.loads(value)
        return PluginReleaseMetadata.model_validate(raw)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail="Invalid release metadata") from exc


def _gitlab_project_id(payload: dict[str, Any]) -> str:
    project = payload.get("project") or {}
    return str(project.get("id") or payload.get("project_id") or "")


def _ensure_protected_master(provenance: PluginReleaseProvenance) -> None:
    configured_project = settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID
    if not configured_project:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Plugin publication GitLab project is not configured",
        )
    if provenance.projectId != configured_project:
        raise HTTPException(status_code=403, detail="Release project is not configured")
    target_branch = settings.WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH
    allowed_refs = {target_branch, f"refs/heads/{target_branch}"}
    if provenance.ref not in allowed_refs:
        raise HTTPException(
            status_code=403,
            detail="Only the protected plugin publication branch may release",
        )


async def _read_package(package: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total_size = 0
    while chunk := await package.read(UPLOAD_CHUNK_SIZE_BYTES):
        total_size += len(chunk)
        if total_size > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="Plugin package is too large")
        chunks.append(chunk)
    if not chunks:
        raise HTTPException(status_code=422, detail="Plugin package is empty")
    return b"".join(chunks)
