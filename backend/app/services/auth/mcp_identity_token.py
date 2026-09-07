# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP identity token authentication service.

These tokens are signed for outbound business MCP servers that opt in with
``inject_wegent_token`` in their Ghost ``mcpServers`` configuration. The
business server verifies the token by calling ``GET /mcp-identity/userinfo`` with
it as a bearer token.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

# Token type for Wegent identity tokens minted for outbound MCP server calls.
MCP_IDENTITY_TOKEN_TYPE = "mcp_identity"


@dataclass
class McpIdentityTokenInfo:
    """Decoded MCP identity token information."""

    user_id: int
    user_name: str
    server_name: str


def create_mcp_identity_token(
    *,
    user_id: int,
    user_name: str,
    server_name: str,
) -> str:
    """Create an MCP identity token for a business MCP server call.

    Args:
        user_id: User the token identifies
        user_name: User name for convenience in logs and debugging
        server_name: MCP server the token is scoped to

    Returns:
        Signed JWT token string
    """
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(
        minutes=settings.MCP_IDENTITY_TOKEN_EXPIRE_MINUTES
    )
    payload = {
        "type": MCP_IDENTITY_TOKEN_TYPE,
        "user_id": user_id,
        "user_name": user_name,
        "server_name": server_name,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_mcp_identity_token(token: str) -> Optional[McpIdentityTokenInfo]:
    """Verify an MCP identity token and extract its data.

    Args:
        token: JWT token string

    Returns:
        McpIdentityTokenInfo if valid, None otherwise
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        if payload.get("type") != MCP_IDENTITY_TOKEN_TYPE:
            logger.warning("Invalid token type: expected mcp_identity")
            return None
        return McpIdentityTokenInfo(
            user_id=payload["user_id"],
            user_name=payload["user_name"],
            server_name=payload["server_name"],
        )
    except jwt.ExpiredSignatureError:
        logger.warning("MCP identity token has expired")
        return None
    except jwt.InvalidTokenError as exc:
        logger.warning(f"Invalid MCP identity token: {exc}")
        return None
    except KeyError as exc:
        logger.warning(f"Missing required field in MCP identity token: {exc}")
        return None
