# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task token authentication for MCP Server.

This module provides task token generation and verification for MCP Server endpoints.
Task tokens are JWT tokens that contain task_id, subtask_id, and user_id information,
allowing MCP tools to authenticate requests and access user-specific resources.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)


class TaskTokenData(BaseModel):
    """Data contained in a task token."""

    task_id: int
    subtask_id: int
    user_id: int
    user_name: str
    exp: Optional[int] = None  # Expiration timestamp


@dataclass
class TaskTokenInfo:
    """Decoded task token information."""

    task_id: int
    subtask_id: int
    user_id: int
    user_name: str


def create_task_token(
    task_id: int,
    subtask_id: int,
    user_id: int,
    user_name: str,
    expires_delta_minutes: int = 1440,  # 24 hours
) -> str:
    """Create a task token for MCP Server authentication.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        user_id: User ID
        user_name: User name
        expires_delta_minutes: Token expiration time in minutes (default 24 hours)

    Returns:
        JWT token string
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=expires_delta_minutes)
    payload = {
        "task_id": task_id,
        "subtask_id": subtask_id,
        "user_id": user_id,
        "user_name": user_name,
        "exp": expire,
        "type": "task_token",
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return token


def verify_task_token(token: str) -> Optional[TaskTokenInfo]:
    """Verify a task token and extract its data.

    Args:
        token: JWT token string

    Returns:
        TaskTokenInfo if valid, None otherwise
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )

        # Verify it's a task token
        if payload.get("type") != "task_token":
            logger.warning("Invalid token type: expected task_token")
            return None

        return TaskTokenInfo(
            task_id=payload["task_id"],
            subtask_id=payload["subtask_id"],
            user_id=payload["user_id"],
            user_name=payload["user_name"],
        )
    except jwt.ExpiredSignatureError:
        logger.warning("Task token has expired")
        return None
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid task token: {e}")
        return None
    except KeyError as e:
        logger.warning(f"Missing required field in task token: {e}")
        return None


def get_user_from_task_token(token: str) -> Optional[int]:
    """Extract user_id from a task token.

    Args:
        token: JWT token string

    Returns:
        user_id if valid, None otherwise
    """
    token_info = verify_task_token(token)
    if token_info:
        return token_info.user_id
    return None


def extract_token_from_header(authorization: str) -> Optional[str]:
    """Extract token from Authorization header.

    Args:
        authorization: Authorization header value (e.g., "Bearer <token>")

    Returns:
        Token string if valid format, None otherwise
    """
    if not authorization:
        return None

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None

    return parts[1]
