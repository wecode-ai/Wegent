# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.prompt_optimization import (
    ApplyPromptChangesRequest,
    ApplyPromptChangesResponse,
)
from app.services.prompt_optimization import apply_prompt_changes

router = APIRouter()


@router.post("/apply", response_model=ApplyPromptChangesResponse)
def apply_prompt_optimization_changes(
    request: ApplyPromptChangesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Apply prompt optimization changes to Ghost or TeamMember.

    Requires Developer+ permission on the target resources.
    """
    try:
        result = apply_prompt_changes(
            db=db, user=current_user, team_id=request.team_id, changes=request.changes
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
