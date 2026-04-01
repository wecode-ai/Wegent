# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public API for skill identity verification."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core import security
from app.services.auth import verify_skill_identity_token

router = APIRouter(prefix="/skill-identity", tags=["skill-identity"])


class SkillIdentityVerifyRequest(BaseModel):
    """Request schema for skill identity verification."""

    token: str = Field(description="Skill identity JWT")
    user_name: str = Field(description="Claimed user name")


@router.post("/verify")
def verify_skill_identity(
    request: SkillIdentityVerifyRequest,
    _: security.AuthContext = Depends(security.get_auth_context),
) -> dict:
    """Verify that a skill identity token belongs to the claimed user."""
    if not request.user_name:
        return {"matched": False, "reason": "missing_user_name"}

    token_info = verify_skill_identity_token(request.token)
    if token_info is None:
        return {"matched": False, "reason": "invalid_token"}

    if token_info.user_name != request.user_name:
        return {"matched": False, "reason": "user_mismatch"}

    return {"matched": True}
