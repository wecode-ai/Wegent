# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable idempotency for authenticated publication workflow mutations."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.plugin_publication import PluginPublicationIdempotency

logger = logging.getLogger(__name__)

ResponseT = TypeVar("ResponseT", bound=BaseModel)
_IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,200}$")


class PluginPublicationIdempotencyService:
    """Bind a caller key to one principal, operation, resource, and payload."""

    def execute(
        self,
        db: Session,
        *,
        principal_type: str,
        principal_id: int,
        operation: str,
        idempotency_key: str,
        resource_key: str,
        payload: Any,
        response_model: type[ResponseT],
        action: Callable[[], ResponseT],
    ) -> ResponseT:
        key = self._validate_key(idempotency_key)
        request_sha256 = self._request_sha256(resource_key, payload)
        binding, cached = self._claim(
            db,
            principal_type=principal_type,
            principal_id=principal_id,
            operation=operation,
            idempotency_key=key,
            resource_key=resource_key,
            request_sha256=request_sha256,
            response_model=response_model,
        )
        if cached is not None:
            return cached

        binding_id = binding.id
        db.commit()
        try:
            response = action()
        except Exception:
            db.rollback()
            self._mark_failed(db, binding_id)
            raise

        binding = (
            db.query(PluginPublicationIdempotency)
            .filter(PluginPublicationIdempotency.id == binding_id)
            .with_for_update()
            .one_or_none()
        )
        if binding is None:
            raise HTTPException(
                status_code=500,
                detail="Publication idempotency binding was lost",
            )
        binding.status = "completed"
        binding.response_json = response.model_dump(mode="json")
        db.commit()
        return response

    def _claim(
        self,
        db: Session,
        *,
        principal_type: str,
        principal_id: int,
        operation: str,
        idempotency_key: str,
        resource_key: str,
        request_sha256: str,
        response_model: type[ResponseT],
    ) -> tuple[PluginPublicationIdempotency, ResponseT | None]:
        binding = self._find(
            db,
            principal_type=principal_type,
            principal_id=principal_id,
            operation=operation,
            idempotency_key=idempotency_key,
        )
        if binding is not None:
            return self._reuse(
                binding,
                resource_key=resource_key,
                request_sha256=request_sha256,
                response_model=response_model,
            )

        binding = PluginPublicationIdempotency(
            principal_type=principal_type,
            principal_id=principal_id,
            operation=operation,
            idempotency_key=idempotency_key,
            resource_key=resource_key,
            request_sha256=request_sha256,
            status="processing",
            response_json={},
        )
        db.add(binding)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            concurrent = self._find(
                db,
                principal_type=principal_type,
                principal_id=principal_id,
                operation=operation,
                idempotency_key=idempotency_key,
            )
            if concurrent is None:
                raise
            return self._reuse(
                concurrent,
                resource_key=resource_key,
                request_sha256=request_sha256,
                response_model=response_model,
            )
        return binding, None

    def _find(
        self,
        db: Session,
        *,
        principal_type: str,
        principal_id: int,
        operation: str,
        idempotency_key: str,
    ) -> PluginPublicationIdempotency | None:
        return (
            db.query(PluginPublicationIdempotency)
            .filter(
                PluginPublicationIdempotency.principal_type == principal_type,
                PluginPublicationIdempotency.principal_id == principal_id,
                PluginPublicationIdempotency.operation == operation,
                PluginPublicationIdempotency.idempotency_key == idempotency_key,
            )
            .with_for_update()
            .first()
        )

    def _reuse(
        self,
        binding: PluginPublicationIdempotency,
        *,
        resource_key: str,
        request_sha256: str,
        response_model: type[ResponseT],
    ) -> tuple[PluginPublicationIdempotency, ResponseT | None]:
        if (
            binding.resource_key != resource_key
            or binding.request_sha256 != request_sha256
        ):
            raise HTTPException(
                status_code=409,
                detail="Idempotency-Key is already bound to another request",
            )
        if binding.status == "completed":
            return binding, response_model.model_validate(binding.response_json)
        if binding.status == "processing":
            raise HTTPException(
                status_code=409,
                detail="A request with this Idempotency-Key is still processing",
            )
        binding.status = "processing"
        binding.response_json = {}
        return binding, None

    def _mark_failed(self, db: Session, binding_id: int) -> None:
        try:
            binding = db.get(PluginPublicationIdempotency, binding_id)
            if binding is None:
                return
            binding.status = "failed"
            binding.response_json = {}
            db.commit()
        except Exception:
            db.rollback()
            logger.exception(
                "Failed to update plugin publication idempotency binding: id=%s",
                binding_id,
            )

    def _validate_key(self, value: str) -> str:
        normalized = value.strip()
        if not _IDEMPOTENCY_KEY_PATTERN.fullmatch(normalized):
            raise HTTPException(status_code=422, detail="Invalid Idempotency-Key")
        return normalized

    def _request_sha256(self, resource_key: str, payload: Any) -> str:
        if isinstance(payload, BaseModel):
            payload = payload.model_dump(mode="json")
        canonical = json.dumps(
            {"resourceKey": resource_key, "payload": payload},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()


plugin_publication_idempotency_service = PluginPublicationIdempotencyService()
