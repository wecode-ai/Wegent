# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP access tokens: a simplified OAuth credential for MCP servers.

A business MCP server only needs to know *who* is calling. Reusing the task
token for that leaks the whole task scope for 24 hours, so Wegent mints a
dedicated token instead: short-lived, bound to an audience, and limited to the
scopes the caller asked for.

The three public endpoints in ``app/api/endpoints/mcp_token.py`` mirror a
minimal OAuth 2.0 deployment without the authorization-code ceremony:

- ``POST /api/external/mcp/token`` exchanges an existing Wegent credential
  (user session, API key, or task token) for an MCP token,
- ``POST /api/external/mcp/introspect`` tells a server whether a token is live,
- ``GET /api/external/mcp/userinfo`` resolves the user behind a token.

Usage:
    from app.services.auth import create_mcp_token, verify_mcp_token

    token = create_mcp_token(user_id=3, user_name="admin")
    info = verify_mcp_token(token, required_scope=MCP_SCOPE_USERINFO)
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

MCP_TOKEN_TYPE = "mcp_token"
MCP_TOKEN_AUDIENCE = "wegent-mcp"

MCP_SCOPE_USERINFO = "mcp:userinfo.read"
MCP_ALLOWED_SCOPES = frozenset({MCP_SCOPE_USERINFO})


class McpTokenError(Exception):
    """Base exception for MCP token errors."""


class McpTokenScopeError(McpTokenError):
    """Raised when a scope is unknown or empty."""


@dataclass(frozen=True)
class McpTokenInfo:
    """Validated content of an MCP token."""

    user_id: int
    user_name: str
    scopes: frozenset[str]
    audience: str
    token_id: Optional[str] = None
    issued_at: Optional[int] = None
    expire_at: Optional[int] = None
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None

    @property
    def scope(self) -> str:
        """Scopes rendered the way RFC 6749 spells them."""
        return " ".join(sorted(self.scopes))

    def has_scope(self, scope: str) -> bool:
        """Return whether this token carries ``scope``."""
        return scope in self.scopes


def parse_scopes(scope: str) -> frozenset[str]:
    """Split a space-delimited scope string and reject unknown scopes.

    Raises:
        McpTokenScopeError: if the scope string is empty or names a scope outside
            ``MCP_ALLOWED_SCOPES``. Unknown scopes fail closed rather than being
            silently dropped, so a caller never receives less than it asked for
            without noticing.
    """
    requested = frozenset(part for part in scope.split() if part)
    if not requested:
        raise McpTokenScopeError("At least one scope is required")
    unknown = requested - MCP_ALLOWED_SCOPES
    if unknown:
        raise McpTokenScopeError(
            f"Unsupported MCP scope(s): {' '.join(sorted(unknown))}"
        )
    return requested


def create_mcp_token(
    *,
    user_id: int,
    user_name: str,
    scopes: Optional[Iterable[str]] = None,
    task_id: Optional[int] = None,
    subtask_id: Optional[int] = None,
    expires_delta_minutes: Optional[int] = None,
) -> str:
    """Create a short-lived MCP token for one Wegent user.

    Args:
        user_id: Wegent user id the token stands for.
        user_name: Wegent user name; also the ``sub`` claim.
        scopes: Scopes to grant. Defaults to ``MCP_SCOPE_USERINFO``.
        task_id: Optional task the token was minted for.
        subtask_id: Optional subtask the token was minted for.
        expires_delta_minutes: Lifetime override; defaults to
            ``settings.MCP_TOKEN_EXPIRE_MINUTES``.

    Returns:
        Signed JWT string.

    Raises:
        McpTokenScopeError: if any requested scope is not granted by Wegent.
    """
    granted = (
        frozenset(scopes) if scopes is not None else frozenset({MCP_SCOPE_USERINFO})
    )
    if not granted:
        raise McpTokenScopeError("At least one scope is required")
    unknown = granted - MCP_ALLOWED_SCOPES
    if unknown:
        raise McpTokenScopeError(
            f"Unsupported MCP scope(s): {' '.join(sorted(unknown))}"
        )

    lifetime_minutes = (
        settings.MCP_TOKEN_EXPIRE_MINUTES
        if expires_delta_minutes is None
        else expires_delta_minutes
    )
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(minutes=lifetime_minutes)
    payload = {
        "type": MCP_TOKEN_TYPE,
        "sub": user_name,
        "user_id": user_id,
        "user_name": user_name,
        "aud": MCP_TOKEN_AUDIENCE,
        "scope": " ".join(sorted(granted)),
        "jti": uuid.uuid4().hex,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    if task_id is not None:
        payload["task_id"] = task_id
    if subtask_id is not None:
        payload["subtask_id"] = subtask_id

    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_mcp_token(
    token: str,
    *,
    required_scope: Optional[str] = None,
    audience: str = MCP_TOKEN_AUDIENCE,
) -> Optional[McpTokenInfo]:
    """Verify an MCP token and extract its data.

    Args:
        token: JWT token string.
        required_scope: When set, the token must carry this scope.
        audience: Expected ``aud`` claim.

    Returns:
        ``McpTokenInfo`` if the token is a live MCP token with the required
        scope, otherwise ``None``. Callers must treat ``None`` as unauthenticated.
    """
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            audience=audience,
        )

        if payload.get("type") != MCP_TOKEN_TYPE:
            logger.warning("Invalid token type: expected %s", MCP_TOKEN_TYPE)
            return None

        scopes = frozenset(str(payload.get("scope", "")).split())
        if required_scope is not None and required_scope not in scopes:
            logger.warning("MCP token is missing required scope %s", required_scope)
            return None

        return McpTokenInfo(
            user_id=payload["user_id"],
            user_name=payload["user_name"],
            scopes=scopes,
            audience=payload["aud"],
            token_id=payload.get("jti"),
            issued_at=payload.get("iat"),
            expire_at=payload.get("exp"),
            task_id=payload.get("task_id"),
            subtask_id=payload.get("subtask_id"),
        )
    except jwt.ExpiredSignatureError:
        logger.warning("MCP token has expired")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning("Invalid MCP token: %s", exc)
        return None
    except KeyError as exc:
        logger.warning("Missing required field in MCP token: %s", exc)
        return None
