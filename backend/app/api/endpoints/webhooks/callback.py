# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic callback endpoint for external systems to resume WAITING subtasks.
Uses subtask_id and token-based authentication for direct matching.
"""

import hashlib
import hmac
import json
import logging
import secrets
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.services.async_resume_service import async_resume_service

logger = logging.getLogger(__name__)

router = APIRouter()


class CallbackPayload(BaseModel):
    """Payload schema for generic callback."""

    event_type: str
    status: str
    message: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


def generate_callback_token(subtask_id: int) -> str:
    """
    Generate a secure callback token for a subtask.
    This should be stored with the subtask when entering WAITING state.
    """
    # Use HMAC with SECRET key and subtask_id to generate deterministic token
    SECRET_key = settings.SECRET_KEY.encode("utf-8")
    message = f"callback:{subtask_id}".encode("utf-8")
    return hmac.new(SECRET_key, message, hashlib.sha256).hexdigest()[:32]


def verify_callback_token(subtask_id: int, token: str) -> bool:
    """Verify that the callback token is valid for the given subtask_id."""
    expected_token = generate_callback_token(subtask_id)
    return secrets.compare_digest(token, expected_token)


@router.post("/callback/{subtask_id}/{token}")
async def generic_callback(
    subtask_id: int,
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Generic callback endpoint for external systems to resume WAITING subtasks.

    This endpoint allows any external system to resume a waiting subtask by
    providing the subtask_id and a valid token.

    Args:
        subtask_id: The ID of the subtask to resume
        token: Security token for authentication
        request: The HTTP request containing the callback payload

    Returns:
        Status of the resume operation
    """
    # Verify token
    if not verify_callback_token(subtask_id, token):
        logger.warning(f"Invalid callback token for subtask {subtask_id}")
        raise HTTPException(status_code=401, detail="Invalid token")

    # Read and parse body
    body = await request.body()
    try:
        if body:
            payload = json.loads(body)
        else:
            payload = {}
    except json.JSONDecodeError:
        logger.error("Failed to parse callback payload")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    logger.info(f"Received callback for subtask {subtask_id}")

    # Try to resume the specific subtask
    result = await async_resume_service.resume_subtask_by_id(
        db=db,
        subtask_id=subtask_id,
        webhook_payload=payload,
        source="callback",
    )

    if not result.get("success"):
        error_msg = result.get("error", "Unknown error")
        logger.warning(f"Failed to resume subtask {subtask_id}: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)

    return {
        "status": "processed",
        "subtask_id": subtask_id,
        "resumed": result.get("resumed", False),
    }


@router.get("/callback/token/{subtask_id}")
async def get_callback_url(
    subtask_id: int,
    db: Session = Depends(get_db),
):
    """
    Get the callback URL for a subtask.

    This is a utility endpoint to generate callback URLs for external systems.
    Should only be accessible to authorized users.
    """
    token = generate_callback_token(subtask_id)

    # Build callback URL
    # Note: In production, this should use the actual public URL
    base_url = settings.FRONTEND_URL.rstrip("/")
    callback_url = f"{base_url}/api/webhooks/callback/{subtask_id}/{token}"

    return {
        "subtask_id": subtask_id,
        "token": token,
        "callback_url": callback_url,
    }
