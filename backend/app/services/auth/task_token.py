# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task token authentication service.

This module provides task token generation and verification for executor and MCP Server.
Task tokens are JWT tokens that contain task_id, subtask_id, and user_id information,
allowing executors and MCP tools to authenticate requests and access user-specific resources.

Usage:
    # Generate token for task execution
    from app.services.auth import create_task_token
    token = create_task_token(task_id=1, subtask_id=2, user_id=3, user_name="admin")

    # Verify token
    from app.services.auth import verify_task_token
    token_info = verify_task_token(token)
    if token_info:
        print(f"User: {token_info.user_name}")
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import settings

logger = logging.getLogger(__name__)


class RuntimeTaskIdentity(BaseModel):
    """Device-owned runtime task address; independent of a process or turn."""

    model_config = ConfigDict(extra="forbid", strict=True)

    device_id: str = Field(min_length=1, max_length=255)
    task_id: str = Field(min_length=1, max_length=255)


class TaskTokenData(BaseModel):
    """Data contained in a task token."""

    model_config = ConfigDict(strict=True)

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
    expire_at: Optional[int] = None
    runtime_task: Optional[RuntimeTaskIdentity] = None


def create_task_token(
    task_id: int,
    subtask_id: int,
    user_id: int,
    user_name: str,
    expires_delta_minutes: int = 1440,  # 24 hours
    *,
    runtime_task: Optional[RuntimeTaskIdentity] = None,
) -> str:
    """Create a task token for executor and MCP Server authentication.

    This token is used by:
    - Executor: To authenticate requests to backend APIs (skill downloads, attachments)
    - MCP Server: To authenticate tool requests and access user-specific resources

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
    if runtime_task is not None:
        if task_id != 0 or subtask_id != 0:
            raise ValueError("Runtime and CRD task identities cannot be combined")
        payload["runtime_task"] = runtime_task.model_dump()
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

        identity = TaskTokenData.model_validate(payload)
        runtime_task = None
        if "runtime_task" in payload:
            runtime_task = RuntimeTaskIdentity.model_validate(payload["runtime_task"])
            if payload["task_id"] != 0 or payload["subtask_id"] != 0:
                return None
        return TaskTokenInfo(
            task_id=identity.task_id,
            subtask_id=identity.subtask_id,
            user_id=identity.user_id,
            user_name=identity.user_name,
            expire_at=payload.get("exp"),
            runtime_task=runtime_task,
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
    except (ValidationError, TypeError, ValueError):
        logger.warning("Invalid task token identity")
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
