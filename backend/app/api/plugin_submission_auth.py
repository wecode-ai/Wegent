"""Authenticate personal plugin submissions against their live Task execution."""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.auth.task_token import TaskTokenInfo, verify_task_token
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.stores.tasks import subtask_store, task_store

ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES = (
    SubtaskStatus.PENDING,
    SubtaskStatus.RUNNING,
    SubtaskStatus.PENDING_CONFIRMATION,
)


@dataclass(frozen=True)
class PluginSubmissionAuth:
    user: User
    task_token: TaskTokenInfo | None = None


def _task_token_from_authorization(authorization: str) -> TaskTokenInfo | None:
    token = security.extract_authorization_token(authorization)
    if not token:
        return None
    try:
        # Unverified claims only select the parser; verify_task_token authenticates it.
        if jwt.get_unverified_claims(token).get("type") != "task_token":
            return None
    except JWTError:
        return None
    return verify_task_token(token)


def _get_plugin_submission_auth(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> PluginSubmissionAuth:
    """Restrict task-token submission access to its live Task execution."""
    if request.headers.get("X-API-Key", "").strip():
        return PluginSubmissionAuth(user=current_user)

    token_info = _task_token_from_authorization(
        request.headers.get("Authorization", "")
    )
    if token_info is None:
        return PluginSubmissionAuth(user=current_user)

    task = task_store.get_by_id_for_update(
        db,
        task_id=token_info.task_id,
        owner_user_id=current_user.id,
    )
    subtask = subtask_store.get_basic_by_id_for_update(
        db,
        subtask_id=token_info.subtask_id,
        owner_user_id=current_user.id,
    )
    if (
        task is None
        or task.kind != "Task"
        or task.is_active not in TaskResource.is_active_query()
        or subtask is None
        or subtask.task_id != token_info.task_id
        or subtask.user_id != current_user.id
        or subtask.status not in ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Task token is no longer active",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return PluginSubmissionAuth(user=current_user, task_token=token_info)


def _ensure_submission_matches_task_token(
    db: Session,
    *,
    auth: PluginSubmissionAuth,
    submission_id: int,
) -> None:
    if auth.task_token is None:
        return
    plugin_marketplace_service.ensure_submission_task_binding(
        db,
        user_id=auth.user.id,
        submission_id=submission_id,
        task_id=auth.task_token.task_id,
        subtask_id=auth.task_token.subtask_id,
    )
