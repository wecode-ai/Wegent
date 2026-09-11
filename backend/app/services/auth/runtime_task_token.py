"""Issue existing TaskTokens for a task on an authenticated native runtime."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.auth.task_token import RuntimeTaskIdentity, create_task_token
from app.services.plugin_account_connections import PluginAccountAuthError


class RuntimeTaskTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    task_id: str = Field(min_length=1, max_length=255)


def issue_runtime_task_token(
    db: Session, *, user_id: int, device_id: str, data: Any
) -> dict:
    """User and device must come from the registered native socket, never data."""
    request = RuntimeTaskTokenRequest.model_validate(data)
    user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
    if user is None:
        raise PluginAccountAuthError("plugin_task_token_user_unavailable", 403)
    token = create_task_token(
        task_id=0,
        subtask_id=0,
        user_id=user.id,
        user_name=user.user_name,
        runtime_task=RuntimeTaskIdentity(device_id=device_id, task_id=request.task_id),
    )
    return {"success": True, "auth_token": token, "expires_in": 86400}
