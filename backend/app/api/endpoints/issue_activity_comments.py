# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""HTTP access to the same Issue comments displayed by the workbench."""

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.issue_activity_comment import (
    IssueActivityCommentCreate,
    IssueActivityCommentResponse,
)
from app.services.project_chat.issue_comments import (
    add_issue_comment,
    list_issue_comments,
)

router = APIRouter()
COMMENT_PATH = "/cloud-projects/{project_id}/loop-items/{item_id}/activity-comments"


@router.get(COMMENT_PATH, response_model=list[IssueActivityCommentResponse])
def list_activity_comments(
    project_id: str,
    item_id: str,
    after_sequence: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> list[dict[str, Any]]:
    return list_issue_comments(
        db,
        user_id=current_user.id,
        project_id=project_id,
        item_id=item_id,
        after_sequence=after_sequence,
        limit=limit,
    )


@router.post(COMMENT_PATH, response_model=IssueActivityCommentResponse)
def add_activity_comment(
    project_id: str,
    item_id: str,
    values: IssueActivityCommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> dict[str, Any]:
    return add_issue_comment(
        db,
        user_id=current_user.id,
        user_name=current_user.user_name,
        project_id=project_id,
        item_id=item_id,
        body=values.body,
        mentions=values.mentions,
    )
