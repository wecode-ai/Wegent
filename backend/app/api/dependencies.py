# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Generator, Optional

from fastapi import Depends, Header, HTTPException, Path, status
from sqlalchemy.orm import Session

from app.db.session import SessionLocal


def _set_telemetry_task_context(task_id: int, subtask_id: int = None) -> None:
    """
    Helper function to set task context for telemetry.

    This is used when task_id is not from path parameters but created dynamically.
    All telemetry checks are handled internally.

    Args:
        task_id: Task ID
        subtask_id: Optional subtask ID
    """
    try:
        from app.core.config import settings

        if settings.OTEL_ENABLED:
            from shared.telemetry.context import set_task_context
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                set_task_context(task_id=task_id, subtask_id=subtask_id)
    except Exception:
        pass


def get_db() -> Generator[Session, None, None]:
    """
    Database session dependency
    Creates a new session for each request and automatically closes it after the request ends
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def with_task_telemetry(task_id: int = Path(...)) -> int:
    """
    Dependency that sets task context for OpenTelemetry tracing.

    This dependency extracts task_id from path parameters and sets it
    in the telemetry context. It handles all OTEL checks internally,
    so business code doesn't need to know about telemetry.

    Usage:
        @router.get("/{task_id}")
        def get_task(task_id: int = Depends(with_task_telemetry)):
            # task_id is available and telemetry context is set
            ...

    Args:
        task_id: Task ID from path parameter

    Returns:
        The task_id (pass-through for use in the route)
    """
    try:
        from app.core.config import settings

        if settings.OTEL_ENABLED:
            from shared.telemetry.context import set_task_context
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                set_task_context(task_id=task_id)
    except Exception:
        # Don't let telemetry errors affect business logic
        pass
    return task_id


def with_task_subtask_telemetry(
    task_id: int = Path(...), subtask_id: Optional[int] = None
) -> tuple:
    """
    Dependency that sets task and subtask context for OpenTelemetry tracing.

    Similar to with_task_telemetry but also handles subtask_id.

    Args:
        task_id: Task ID from path parameter
        subtask_id: Optional subtask ID

    Returns:
        Tuple of (task_id, subtask_id)
    """
    try:
        from app.core.config import settings

        if settings.OTEL_ENABLED:
            from shared.telemetry.context import set_task_context
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                set_task_context(task_id=task_id, subtask_id=subtask_id)
    except Exception:
        pass
    return task_id, subtask_id


def verify_internal_jwt(
    authorization: str = Header(default=""), db: Session = Depends(get_db)
) -> None:
    """
    Verify JWT token for internal API endpoints.

    This dependency ensures that all internal API endpoints (used by chat_shell)
    are protected with JWT authentication. It verifies:
    1. Authorization header is present and starts with "Bearer "
    2. JWT token is valid and not expired
    3. User exists in database and is active

    This is the recommended authentication method for service-to-service communication,
    as it provides full user context for audit trails and access control.

    Args:
        authorization: Authorization header value
        db: Database session

    Raises:
        HTTPException: 401 if authentication fails

    Usage:
        @router.get("/internal/endpoint", dependencies=[Depends(verify_internal_jwt)])
        async def internal_endpoint():
            ...
    """
    from app.core import security

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization[7:].strip()

    # Verify JWT token and get user
    user = security.get_current_user_from_token(token, db)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
