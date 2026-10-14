# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated decision-model catalog and provider-independent execution."""

import json
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.decision import DecisionRequest
from app.services.decision_model_service import (
    MAX_DECISION_BYTES,
    DecisionError,
    decision_model_catalog,
    execute_decision,
)

router = APIRouter()


def _error_response(error: DecisionError, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=error.status,
        content={
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
                "requestId": request_id,
            }
        },
        headers={"Cache-Control": "no-store"},
    )


@router.get("/decisions")
def list_decision_models(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> JSONResponse:
    return JSONResponse(
        decision_model_catalog(db, current_user), headers={"Cache-Control": "no-store"}
    )


@router.post("/decisions")
async def create_decision(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> JSONResponse:
    request_id = f"decision_{uuid.uuid4().hex}"
    try:
        if (
            request.headers.get("content-type", "").split(";")[0].strip().lower()
            != "application/json"
        ):
            raise DecisionError(
                415, "invalid_content_type", "Content type must be application/json"
            )
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_DECISION_BYTES:
                raise DecisionError(
                    413, "request_too_large", "Decision request exceeds the limit"
                )
        try:
            decision = DecisionRequest.model_validate(json.loads(body))
        except (ValueError, TypeError):
            raise DecisionError(
                400, "invalid_request", "Invalid decision request"
            ) from None
        result = await execute_decision(db, current_user, decision, request_id)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except DecisionError as error:
        return _error_response(error, request_id)
