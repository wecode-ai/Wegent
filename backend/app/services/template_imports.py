# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Serialize each template write with its receipt in the resource transaction."""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.template_import import TemplateImportOperation, TemplateImportReceipt
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


@dataclass
class TemplateImportWrite:
    db: Session
    operation: TemplateImportOperation
    request: TemplateImportRequest
    kind: TemplateImportKind
    request_sha256: str
    resource_id: str | None

    def record(self, resource_id: object) -> None:
        """The caller must commit this receipt with the successful resource write."""
        self.db.add(
            TemplateImportReceipt(
                operation_id=self.operation.id,
                step_key=self.request.step_key,
                kind=self.kind,
                request_sha256=self.request_sha256,
                resource_id=str(resource_id),
            )
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
            TemplateImportOperation.actor_user_id == user_id,
            TemplateImportOperation.project_id == str(project_id),
        )
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if operation is None:
        raise HTTPException(404, "Template import not found")
    require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
    manifest = operation.manifest
    if (
        operation.protocol_version != 1
        or not isinstance(manifest, list)
        or not any(
            isinstance(step, dict)
            and step.get("key") == request.step_key
            and step.get("kind") == kind
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
    receipt = (
        db.query(TemplateImportReceipt)
        .filter_by(
            operation_id=operation.id,
            step_key=request.step_key,
        )
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    # Board writes include a mutable project snapshot. A committed receipt
    # returns the current project without applying that snapshot again; a
    # different board intent must begin a distinct operation.
    if receipt is not None and (
        receipt.kind != kind or (kind != "board" and receipt.request_sha256 != digest)
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
        str(receipt.resource_id) if receipt is not None else None,
    )
