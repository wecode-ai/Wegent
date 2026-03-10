# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoint for retrieving WeCode Model API keys (wegent-model-key).

Provides an endpoint for the frontend to get the current user's API key
from the external API key management service.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core import security
from app.models.user import User
from wecode.service.wecode_apikey_client import get_or_create_apikey_async

logger = logging.getLogger(__name__)

router = APIRouter()


class ModelKeyResponse(BaseModel):
    api_key: str


@router.post("/wegent-model-key", response_model=ModelKeyResponse)
async def get_wegent_model_key(
    current_user: User = Depends(security.get_current_user),
) -> ModelKeyResponse:
    """
    Get or create a wegent-model-key for the current authenticated user.

    The key is retrieved from the external API key management service.
    If no key exists for the user, a new one is created automatically.
    """
    username = current_user.user_name
    if not username:
        raise HTTPException(status_code=400, detail="User name is empty")

    try:
        api_key = await get_or_create_apikey_async(username)
        return ModelKeyResponse(api_key=api_key)
    except Exception as e:
        logger.error(
            f"Failed to get/create wegent-model-key for user {username}: {str(e)}"
        )
        raise HTTPException(
            status_code=502,
            detail="Failed to retrieve API key from external service",
        )
