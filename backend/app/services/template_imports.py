# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Serialize each template write with its node-owned receipt."""

import hashlib
import json
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.template_import import (
    TEMPLATE_IMPORT_KIND,
    TemplateImportOperation,
)
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import require_cloud_project_role
from shared.telemetry.decorators import trace_sync

TemplateImportKind = Literal["agent", "group", "automation", "board"]
_OPERATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class TemplateImportRequest:
    operation_id: str
    step_key: str


def template_import_headers(
    operation_id: str | None = Header(default=None, alias="X-Template-Import-Id"),
    step_key: str | None = Header(default=None, alias="X-Template-Import-Step"),
) -> TemplateImportRequest | None:
    if operation_id is None and step_key is None:
        return None
    if (
        operation_id is None
        or not _OPERATION_ID.fullmatch(operation_id)
        or step_key is None
        or not step_key
        or len(step_key) > 200
    ):
        raise HTTPException(422, "Both valid template import headers are required")
    return TemplateImportRequest(operation_id, step_key)


TemplateImportDependency = Annotated[
    TemplateImportRequest | None, Depends(template_import_headers)
]


def _metadata(operation: TemplateImportOperation) -> dict[str, Any]:
    value = operation.metadata_json
    return deepcopy(value) if isinstance(value, dict) else {}


def _invalid_state() -> HTTPException:
    return HTTPException(409, "Template import state is invalid; start a new import")


def _receipts(operation: TemplateImportOperation) -> dict[str, Any]:
    value = _metadata(operation).get("receipts", {})
    if not isinstance(value, dict):
        raise _invalid_state()
    return value


def _manifest(operation: TemplateImportOperation) -> list[dict[str, Any]] | None:
    value = _metadata(operation).get("manifest")
    if not isinstance(value, list):
        return None
    if not all(isinstance(step, dict) for step in value):
        return None
    return [step for step in value if isinstance(step, dict)]


def _all_steps_completed(
    manifest: list[dict[str, Any]], receipts: dict[str, Any]
) -> bool:
    return bool(manifest) and all(
        isinstance(receipt := receipts.get(str(step.get("key"))), dict)
        and receipt.get("kind") == step.get("kind")
        for step in manifest
    )


@dataclass
class TemplateImportWrite:
    db: Session
    operation: TemplateImportOperation
    request: TemplateImportRequest
    kind: TemplateImportKind
    request_sha256: str
    resource_id: str | None

    def record(self, resource_id: object) -> None:
        """Commit this receipt with the caller's successful resource write."""
        metadata = _metadata(self.operation)
        receipts = metadata.get("receipts")
        if not isinstance(receipts, dict):
            receipts = {}
        receipts[self.request.step_key] = {
            "kind": self.kind,
            "requestSha256": self.request_sha256,
            "resourceId": str(resource_id),
            "completedAt": datetime.now(timezone.utc).isoformat(),
        }
        metadata["receipts"] = receipts
        manifest = _manifest(self.operation) or []
        complete = _all_steps_completed(manifest, receipts)
        self.operation.metadata_json = metadata
        self.operation.status = "completed" if complete else "pending"
        if complete:
            self.operation.completed_at = datetime.now(timezone.utc).replace(
                tzinfo=None
            )
        self.db.flush()


def _operation_for_step(
    db: Session,
    request: TemplateImportRequest,
    *,
    project_id: object,
    user_id: int,
    kind: TemplateImportKind,
) -> TemplateImportOperation:
    operation = (
        db.query(TemplateImportOperation)
        .filter(
            TemplateImportOperation.id == request.operation_id,
            TemplateImportOperation.created_by_user_id == user_id,
            TemplateImportOperation.cloud_project_id == str(project_id),
            TemplateImportOperation.kind == TEMPLATE_IMPORT_KIND,
        )
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if operation is None:
        raise HTTPException(404, "Template import not found")
    require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
    metadata = _metadata(operation)
    manifest = _manifest(operation)
    if (
        metadata.get("protocolVersion") != 1
        or manifest is None
        or not any(
            step.get("key") == request.step_key and step.get("kind") == kind
            for step in manifest
        )
    ):
        raise HTTPException(409, "Template import step does not match this request")
    return operation


def _request_digest(payload: BaseModel, kind: TemplateImportKind) -> str:
    values = payload.model_dump(
        mode="json", exclude={"version"} if kind == "board" else set()
    )
    return hashlib.sha256(
        json.dumps(
            values,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


@trace_sync(span_name="project.template_import.lock", tracer_name="backend.templates")
def lock_template_import(
    db: Session,
    request: TemplateImportRequest | None,
    *,
    project_id: object,
    user_id: int,
    kind: TemplateImportKind,
    payload: BaseModel,
) -> TemplateImportWrite | None:
    if request is None:
        return None
    operation = _operation_for_step(
        db,
        request,
        project_id=project_id,
        user_id=user_id,
        kind=kind,
    )
    digest = _request_digest(payload, kind)
    receipts = _receipts(operation)
    receipt = receipts.get(request.step_key)
    if request.step_key in receipts and not isinstance(receipt, dict):
        raise _invalid_state()
    # Board writes include a mutable project snapshot. A committed receipt
    # returns the current project without applying that snapshot again; a
    # different board intent must begin a distinct operation.
    if isinstance(receipt, dict) and (
        receipt.get("kind") != kind
        or (kind != "board" and receipt.get("requestSha256") != digest)
    ):
        raise HTTPException(
            409, "Template import step is already bound to another request"
        )
    return TemplateImportWrite(
        db,
        operation,
        request,
        kind,
        digest,
        (
            str(receipt["resourceId"])
            if isinstance(receipt, dict) and receipt.get("resourceId") is not None
            else None
        ),
    )
