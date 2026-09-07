# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill identity token authentication service."""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class SkillIdentityTokenInfo:
    """Decoded skill identity token information."""

    user_id: int
    user_name: str
    runtime_type: str
    runtime_name: str


def create_skill_identity_token(
    *,
    user_id: int,
    user_name: str,
    runtime_type: str,
    runtime_name: str,
) -> str:
    """Create a skill identity token for skill HTTP requests."""
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(
        minutes=settings.SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES
    )
    payload = {
        "type": "skill_identity",
        "user_id": user_id,
        "user_name": user_name,
        "runtime_type": runtime_type,
        "runtime_name": runtime_name,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_skill_identity_token(token: str) -> Optional[SkillIdentityTokenInfo]:
    """Verify a skill identity token and extract its data."""
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if payload.get("type") != "skill_identity":
            logger.warning("Invalid token type: expected skill_identity")
            return None
        return SkillIdentityTokenInfo(
            user_id=payload["user_id"],
            user_name=payload["user_name"],
            runtime_type=payload["runtime_type"],
            runtime_name=payload["runtime_name"],
        )
    except jwt.ExpiredSignatureError:
        logger.warning("Skill identity token has expired")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning(f"Invalid skill identity token: {exc}")
        return None
    except KeyError as exc:
        logger.warning(f"Missing required field in skill identity token: {exc}")
        return None
