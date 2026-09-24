# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit Issue dispatch endpoints."""

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.security import get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.issue_dispatch import (
    DispatchTargetType,
    IssueDispatchCandidateListResponse,
    IssueDispatchCandidateView,
    IssueDispatchCreate,
    IssueDispatchDecisionCreate,
    IssueDispatchListResponse,
    IssueDispatchRoundCreate,
    IssueDispatchRoundView,
    IssueDispatchTaskActionCreate,
    IssueDispatchView,
)
from app.services.auth.task_token import verify_task_token
from app.services.issue_dispatch import issue_dispatch_service

router = APIRouter()


def _dispatch_manager_actor(
    request: Request,
    *,
    dispatch_id: str,
) -> tuple[str | None, str | None]:
    """Resolve the manager identity from the authenticated Runtime Task."""

    token = security.extract_authorization_token(
        request.headers.get("Authorization", "")
    )
    token_info = verify_task_token(token) if token else None
    if token_info is None or token_info.dispatch_id != dispatch_id:
        return None, None
    return token_info.manager_agent_id, token_info.dispatch_role


@router.post(
    "/loop-items/{issue_id}/dispatches",
    response_model=IssueDispatchView,
    status_code=status.HTTP_201_CREATED,
)
async def create_issue_dispatch(
    issue_id: str,
    values: IssueDispatchCreate,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    dispatch, created = issue_dispatch_service.create(
        db, issue_id=issue_id, user_id=current_user.id, values=values
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    issue_dispatch_service.activate(db, dispatch)
    return issue_dispatch_service.view(db, dispatch)


@router.get(
    "/loop-items/{issue_id}/dispatches",
    response_model=IssueDispatchListResponse,
)
def list_issue_dispatches(
    issue_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchListResponse:
    return IssueDispatchListResponse(
        items=[
            issue_dispatch_service.view(db, dispatch)
            for dispatch in issue_dispatch_service.list(
                db, issue_id=issue_id, user_id=current_user.id
            )
        ]
    )


@router.get(
    "/loop-items/{issue_id}/dispatch-candidates",
    response_model=IssueDispatchCandidateListResponse,
)
def list_issue_dispatch_candidates(
    issue_id: str,
    target_type: DispatchTargetType | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchCandidateListResponse:
    return IssueDispatchCandidateListResponse(
        items=[
            IssueDispatchCandidateView.model_validate(value)
            for value in issue_dispatch_service.candidates(
                db,
                issue_id=issue_id,
                user_id=current_user.id,
                target_type=target_type,
            )
        ]
    )


@router.get(
    "/issue-dispatches/{dispatch_id}",
    response_model=IssueDispatchView,
)
def get_issue_dispatch(
    dispatch_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    return issue_dispatch_service.view(
        db,
        issue_dispatch_service.get(
            db, dispatch_id=dispatch_id, user_id=current_user.id
        ),
    )


@router.post(
    "/issue-dispatches/{dispatch_id}/rounds",
    response_model=IssueDispatchRoundView,
    status_code=status.HTTP_201_CREATED,
)
async def create_issue_dispatch_round(
    dispatch_id: str,
    values: IssueDispatchRoundCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchRoundView:
    actor_agent_id, actor_dispatch_role = _dispatch_manager_actor(
        request, dispatch_id=dispatch_id
    )
    round_record = issue_dispatch_service.create_round(
        db,
        dispatch_id=dispatch_id,
        user_id=current_user.id,
        values=values,
        actor_agent_id=actor_agent_id,
        actor_dispatch_role=actor_dispatch_role,
    )
    dispatch = issue_dispatch_service.active(db, str(round_record.loop_item_id))
    if dispatch is not None:
        issue_dispatch_service.activate(db, dispatch)
    return issue_dispatch_service.round_view(db, round_record)


@router.post(
    "/issue-dispatches/{dispatch_id}/decisions",
    response_model=IssueDispatchView,
)
def decide_issue_dispatch(
    dispatch_id: str,
    values: IssueDispatchDecisionCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    actor_agent_id, actor_dispatch_role = _dispatch_manager_actor(
        request, dispatch_id=dispatch_id
    )
    dispatch = issue_dispatch_service.decide(
        db,
        dispatch_id=dispatch_id,
        user_id=current_user.id,
        values=values,
        actor_agent_id=actor_agent_id,
        actor_dispatch_role=actor_dispatch_role,
    )
    return issue_dispatch_service.view(db, dispatch)


@router.post(
    "/issue-dispatches/{dispatch_id}/cancel",
    response_model=IssueDispatchView,
)
def cancel_issue_dispatch(
    dispatch_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    dispatch = issue_dispatch_service.cancel(
        db, dispatch_id=dispatch_id, user_id=current_user.id
    )
    return issue_dispatch_service.view(db, dispatch)


@router.post(
    "/issue-dispatch-tasks/{task_id}/cancel",
    response_model=IssueDispatchView,
)
def cancel_issue_dispatch_task(
    task_id: str,
    values: IssueDispatchTaskActionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    issue_dispatch_service.cancel_task(
        db,
        task_id=task_id,
        user_id=current_user.id,
        reason=values.reason,
    )
    return issue_dispatch_service.view(
        db,
        issue_dispatch_service.dispatch_for_task(
            db, task_id=task_id, user_id=current_user.id
        ),
    )


@router.post(
    "/issue-dispatches/{dispatch_id}/retry",
    response_model=IssueDispatchView,
)
def retry_issue_dispatch(
    dispatch_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    dispatch = issue_dispatch_service.retry(
        db, dispatch_id=dispatch_id, user_id=current_user.id
    )
    issue_dispatch_service.activate(db, dispatch)
    return issue_dispatch_service.view(db, dispatch)


@router.post(
    "/issue-dispatches/{dispatch_id}/return-for-rework",
    response_model=IssueDispatchView,
)
def return_issue_dispatch_for_rework(
    dispatch_id: str,
    values: IssueDispatchTaskActionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> IssueDispatchView:
    return issue_dispatch_service.view(
        db,
        issue_dispatch_service.return_dispatch_for_rework(
            db,
            dispatch_id=dispatch_id,
            user_id=current_user.id,
            reason=values.reason,
        ),
    )
