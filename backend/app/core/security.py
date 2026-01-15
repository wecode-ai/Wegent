# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Union

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from opentelemetry import trace
from passlib.context import CryptContext
from shared.telemetry.context import set_user_context
from shared.telemetry.context.attributes import SpanAttributes
from shared.telemetry.core import is_telemetry_enabled
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.models.user import User
from app.schemas.user import TokenData
from app.services.k_batch import apply_default_resources_sync
from app.services.readers.users import userReader
from app.services.user import user_service

logger = logging.getLogger(__name__)

# Create a tracer for authentication operations
_tracer = trace.get_tracer(__name__)

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# OAuth2 password mode
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/oauth2")
# OAuth2 scheme that allows optional authentication (returns None instead of raising)
oauth2_scheme_optional = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_PREFIX}/auth/oauth2", auto_error=False
)


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> User:
    """Get current authenticated user"""
    with _tracer.start_as_current_span("auth.get_current_user") as span:
        # Set auth method attributes
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_METHOD, "jwt")
            span.set_attribute(SpanAttributes.AUTH_TOKEN_TYPE, "bearer")
            span.set_attribute(SpanAttributes.AUTH_SOURCE, "authorization_header")

        try:
            # Verify token
            token_data = verify_token(token)
            username = token_data.get("username")

            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.USER_NAME, username)

            # Query user
            user = user_service.get_user_by_name(db=db, user_name=username)
            if user is None:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON, "user_not_found"
                    )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Could not validate credentials",
                    headers={"WWW-Authenticate": "Bearer"},
                )
            if not user.is_active:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON, "user_inactive"
                    )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="User not activated",
                    headers={"WWW-Authenticate": "Bearer"},
                )

            # Set user context for tracing
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
                span.set_attribute(SpanAttributes.USER_ID, str(user.id))
                set_user_context(user_id=str(user.id), user_name=user.user_name)

            return user
        except HTTPException:
            raise
        except Exception as e:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(SpanAttributes.AUTH_FAILURE_REASON, str(e)[:200])
                span.record_exception(e)
            raise


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify password

    Args:
        plain_password: Plain text password
        hashed_password: Hashed password

    Returns:
        Whether the password matches
    """
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """
    Generate password hash

    Args:
        password: Plain text password

    Returns:
        Password hash
    """
    return pwd_context.hash(password)


def create_access_token(
    data: Dict[str, Any], expires_delta: Optional[int] = None
) -> str:
    """
    Create access token

    Args:
        data: Token data
        expires_delta: Expiration time (minutes)

    Returns:
        Access token
    """
    from datetime import timezone

    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + timedelta(minutes=expires_delta)
    else:
        expire = datetime.now(timezone.utc) + timedelta(
            minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
        )
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(
        to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM
    )
    return encoded_jwt


def authenticate_user(
    db: Session, username: str, password: Optional[str] = None, **kwargs
) -> Union[User, None]:
    """
    Authenticate user with username and password

    Args:
        db: Database session
        username: Username
        password: Password
        **kwargs: Other authentication parameters

    Returns:
        User object if authentication is successful, None otherwise
    """
    with _tracer.start_as_current_span("auth.authenticate_user") as span:
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_METHOD, "password")
            span.set_attribute(SpanAttributes.AUTH_SOURCE, "login_form")
            if username:
                span.set_attribute(SpanAttributes.USER_NAME, username)

        if not username or not password:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON,
                    "missing_credentials",
                )
            return None

        user = db.scalar(select(User).where(User.user_name == username))
        if not user:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(SpanAttributes.AUTH_FAILURE_REASON, "user_not_found")
            return None

        if not user.is_active:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(SpanAttributes.AUTH_FAILURE_REASON, "user_inactive")
            raise HTTPException(status_code=400, detail="User not activated")

        if not verify_password(password, user.password_hash):
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, "invalid_password"
                )
            return None

        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
            span.set_attribute(SpanAttributes.USER_ID, str(user.id))
            set_user_context(user_id=str(user.id), user_name=user.user_name)

        return user


def verify_token(token: str) -> Dict[str, Any]:
    """
    Verify token

    Args:
        token: Authentication token

    Returns:
        Data contained in the token

    Raises:
        HTTPException: Exception thrown when token is invalid
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = TokenData(username=username)
        return {"username": token_data.username}
    except JWTError:
        raise credentials_exception


def get_username_from_request(request) -> str:
    """
    Extract username from Authorization header in request

    Args:
        request: FastAPI Request object

    Returns:
        Username or 'anonymous'/'internal-service' if not found/invalid
    """
    # Check for internal service requests first
    service_name = request.headers.get("X-Service-Name")
    if service_name:
        return f"[{service_name}]"

    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return "anonymous"

    try:
        token = auth_header.split(" ")[1]
        token_data = verify_token(token)
        return token_data.get("username", "anonymous")
    except Exception:
        return "anonymous"


def get_admin_user(current_user: User = Depends(get_current_user)) -> User:
    """
    Verify if current user is admin user

    Args:
        current_user: Currently logged in user

    Returns:
        Current user object

    Raises:
        HTTPException: If user is not admin
    """
    with _tracer.start_as_current_span("auth.get_admin_user") as span:
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.USER_ID, str(current_user.id))
            span.set_attribute(SpanAttributes.USER_NAME, current_user.user_name)
            span.set_attribute("auth.role_check", "admin")

        # Check user's role field to determine admin status
        if current_user.role != "admin":
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, "insufficient_permissions"
                )
                span.set_attribute("auth.user_role", current_user.role or "user")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permission denied. Admin access required.",
            )

        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
            span.set_attribute("auth.user_role", "admin")

        return current_user


def get_current_user_from_token(token: str, db: Session) -> Optional[User]:
    """
    Get current user from JWT token without raising exceptions.

    This function is useful for optional authentication scenarios where
    you want to check if a token is valid without failing the request.

    Args:
        token: JWT token string
        db: Database session

    Returns:
        User object if token is valid and user exists, None otherwise
    """
    with _tracer.start_as_current_span("auth.get_current_user_from_token") as span:
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_METHOD, "jwt")
            span.set_attribute(SpanAttributes.AUTH_TOKEN_TYPE, "bearer")

        try:
            payload = jwt.decode(
                token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
            )
            username: str = payload.get("sub")
            if username is None:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON, "missing_username_in_token"
                    )
                return None

            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.USER_NAME, username)

            user = user_service.get_user_by_name(db=db, user_name=username)
            if user:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
                    span.set_attribute(SpanAttributes.USER_ID, str(user.id))
                    set_user_context(user_id=str(user.id), user_name=user.user_name)
            else:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON, "user_not_found"
                    )
            return user
        except JWTError as e:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, f"jwt_error:{str(e)[:100]}"
                )
            return None
        except Exception as e:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, f"error:{str(e)[:100]}"
                )
            return None


def get_api_key_from_header(
    authorization: str = Header(default=""),
    x_api_key: str = Header(default="", alias="X-API-Key"),
    wegent_source: str = Header(default="", alias="wegent-source"),
) -> str:
    """
    Extract API key from Authorization header, X-API-Key header, or wegent-source header.

    Args:
        authorization: Authorization header value
        x_api_key: X-API-Key header value
        wegent_source: wegent-source header value (service key)

    Returns:
        API key string or empty string if not found
    """
    # Priority: X-API-Key > Authorization Bearer > wegent-source
    if x_api_key and x_api_key.startswith("wg-"):
        return x_api_key
    if authorization.startswith("Bearer wg-"):
        return authorization[7:]  # Remove "Bearer " prefix
    if wegent_source and wegent_source.startswith("wg-"):
        return wegent_source
    return ""


@dataclass
class AuthContext:
    """Authentication context containing user and optional service key info."""

    user: User
    api_key_name: Optional[str] = None  # API key name used for authentication


def get_auth_context(
    db: Session = Depends(get_db),
    api_key: str = Depends(get_api_key_from_header),
    wegent_username: Optional[str] = Header(default=None, alias="wegent-username"),
) -> AuthContext:
    """
    Flexible authentication: supports personal API key and service key.

    Authentication logic:
    - Personal key: returns the key owner directly, ignores wegent-username
    - Service key: requires username via wegent-username header OR api_key#username format

    Args:
        db: Database session
        api_key: API key string (from X-API-Key, Authorization, or wegent-source header)
                 For service keys, supports "api_key#username" format
        wegent_username: Username to impersonate (from wegent-username header, required for service keys)

    Returns:
        AuthContext containing authenticated User and optional api_key_name

    Raises:
        HTTPException: If no authentication method succeeds
    """
    with _tracer.start_as_current_span("auth.get_auth_context") as span:
        # Set initial auth attributes
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_METHOD, "api_key")
            span.set_attribute(SpanAttributes.AUTH_TOKEN_TYPE, "api_key")

        if not api_key:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, "api_key_missing"
                )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API key is required",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Parse api_key#username format
        actual_api_key = api_key
        username_from_key = None
        if "#" in api_key:
            parts = api_key.split("#", 1)
            actual_api_key = parts[0]
            username_from_key = parts[1] if len(parts) > 1 and parts[1] else None
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_SOURCE, "api_key_with_username")
        else:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_SOURCE, "api_key_header")

        key_hash = hashlib.sha256(actual_api_key.encode()).hexdigest()
        api_key_record = (
            db.query(APIKey)
            .filter(
                APIKey.key_hash == key_hash,
                APIKey.is_active == True,
            )
            .first()
        )

        if not api_key_record:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, "api_key_invalid"
                )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API key",
            )

        # Set API key info in span
        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_API_KEY_NAME, api_key_record.name)
            span.set_attribute(
                SpanAttributes.AUTH_API_KEY_TYPE, api_key_record.key_type
            )

        # Check expiration
        if api_key_record.expires_at < datetime.utcnow():
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON, "api_key_expired"
                )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API key has expired",
            )

        # Update last_used_at
        api_key_record.last_used_at = datetime.utcnow()
        db.commit()

        # Personal key: return the key owner directly
        if api_key_record.key_type == KEY_TYPE_PERSONAL:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_METHOD, "api_key_personal")

            user = userReader.get_by_id(db, api_key_record.user_id)
            if user and user.is_active:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
                    span.set_attribute(SpanAttributes.USER_ID, str(user.id))
                    span.set_attribute(SpanAttributes.USER_NAME, user.user_name)
                    set_user_context(user_id=str(user.id), user_name=user.user_name)
                return AuthContext(user=user, api_key_name=api_key_record.name)

            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                span.set_attribute(
                    SpanAttributes.AUTH_FAILURE_REASON,
                    "user_not_found" if not user else "user_inactive",
                )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
            )

        # Service key: require username via header or api_key#username format
        if api_key_record.key_type == KEY_TYPE_SERVICE:
            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_METHOD, "api_key_service")

            # Priority: username_from_key (api_key#username) > wegent_username header
            target_username = username_from_key or wegent_username
            if not target_username:
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON,
                        "username_required_for_service_key",
                    )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Username is required for service key authentication (use wegent-username header)",
                )

            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.USER_NAME, target_username)

            # Validate username format: only letters, numbers, underscores, hyphens
            if not re.match(r"^[a-zA-Z0-9_-]+$", target_username):
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                    span.set_attribute(
                        SpanAttributes.AUTH_FAILURE_REASON, "invalid_username_format"
                    )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Username can only contain letters, numbers, underscores, and hyphens",
                )

            # Try to find existing user
            user = userReader.get_by_name(db, target_username)

            if user:
                if not user.is_active:
                    if is_telemetry_enabled():
                        span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
                        span.set_attribute(
                            SpanAttributes.AUTH_FAILURE_REASON, "user_inactive"
                        )
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail=f"User '{target_username}' is inactive",
                    )
                if is_telemetry_enabled():
                    span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
                    span.set_attribute(SpanAttributes.USER_ID, str(user.id))
                    span.set_attribute(SpanAttributes.AUTH_USER_CREATED, False)
                    set_user_context(user_id=str(user.id), user_name=user.user_name)
                return AuthContext(user=user, api_key_name=api_key_record.name)

            # User not found, auto-create for service key authentication
            logger.info(
                f"Auto-creating user '{target_username}' via service key '{api_key_record.name}'"
            )

            if is_telemetry_enabled():
                span.add_event(
                    "user_auto_created",
                    {
                        "username": target_username,
                        "service_key": api_key_record.name,
                    },
                )

            # Create new user with minimal info
            # auth_source uses "api:{service_key_name}" to track which service key created this user
            new_user = User(
                user_name=target_username,
                email=f"{target_username}@api.auto",  # Placeholder email
                password_hash=get_password_hash(
                    str(uuid.uuid4())
                ),  # Random password for security
                git_info=[],
                is_active=True,
                preferences=json.dumps({}),
                auth_source=f"api:{api_key_record.name}",  # Track which service key created this user
            )
            db.add(new_user)
            db.commit()
            db.refresh(new_user)

            # Apply default resources synchronously for new API-created users
            try:
                apply_default_resources_sync(new_user.id)
                # Commit transaction after applying default resources to ensure
                # initialized resources are visible to subsequent queries
                db.commit()
            except Exception as e:
                logger.warning(
                    f"Failed to apply default resources for user {new_user.id}: {e}"
                )

            if is_telemetry_enabled():
                span.set_attribute(SpanAttributes.AUTH_RESULT, "success")
                span.set_attribute(SpanAttributes.USER_ID, str(new_user.id))
                span.set_attribute(SpanAttributes.AUTH_USER_CREATED, True)
                set_user_context(user_id=str(new_user.id), user_name=new_user.user_name)

            return AuthContext(user=new_user, api_key_name=api_key_record.name)

        if is_telemetry_enabled():
            span.set_attribute(SpanAttributes.AUTH_RESULT, "failure")
            span.set_attribute(SpanAttributes.AUTH_FAILURE_REASON, "unknown_key_type")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )


def get_current_user_flexible(
    auth_context: AuthContext = Depends(get_auth_context),
) -> User:
    """
    Get current user from auth context (for backward compatibility).

    Args:
        auth_context: Authentication context

    Returns:
        Authenticated User object
    """
    return auth_context.user
