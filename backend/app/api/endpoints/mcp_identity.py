# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public endpoint that resolves the Wegent user behind an MCP identity token."""

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.user import User
from app.services.auth import (
    MCP_IDENTITY_RUNTIME_TYPE,
    extract_token_from_header,
    verify_skill_identity_token,
)

router = APIRouter(prefix="/mcp-identity", tags=["mcp-identity"])


class McpIdentityUserInfo(BaseModel):
    """Basic current user info resolvable from a Wegent MCP identity token."""

    id: int
    user_name: str
    email: Optional[str] = None


@router.get("/me", response_model=McpIdentityUserInfo)
def read_mcp_identity_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> McpIdentityUserInfo:
    """Return the Wegent user bound to an injected MCP identity token.

    Business MCP servers receive this token in the ``Authorization`` header
    of inbound calls when their Ghost ``mcpServers`` entry enables
    ``inject_wegent_token``. Only tokens minted for MCP calls are accepted.
    The response carries basic user information and never exposes git
    credentials.
    """
    token = extract_token_from_header(authorization or "")
    token_info = verify_skill_identity_token(token or "")
    if token_info is None or token_info.runtime_type != MCP_IDENTITY_RUNTIME_TYPE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Wegent MCP identity token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = (
        db.query(User)
        .filter(User.id == token_info.user_id, User.is_active.is_(True))
        .first()
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    return McpIdentityUserInfo(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
    )
