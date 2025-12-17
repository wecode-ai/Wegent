# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Union

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.api_key import APIKey
from app.models.user import User
from app.schemas.user import TokenData
from app.services.user import user_service

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
    # Verify token
    token_data = verify_token(token)
    username = token_data.get("username")

    # Query user
    user = user_service.get_user_by_name(db=db, user_name=username)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not activated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


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
    if not username or not password:
        return None

    user = db.scalar(select(User).where(User.user_name == username))
    if not user:
        return None

    if not user.is_active:
        raise HTTPException(status_code=400, detail="User not activated")

    if not verify_password(password, user.password_hash):
        return None

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
        Username or 'anonymous'/'invalid_token' if not found/invalid
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return "anonymous"

    try:
        token = auth_header.split(" ")[1]
        token_data = verify_token(token)
        return token_data.get("username", "anonymous")
    except Exception:
        return "invalid_token"


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
    # Check user's role field to determine admin status
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied. Admin access required.",
        )
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
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        username: str = payload.get("sub")
        if username is None:
            return None

        user = user_service.get_user_by_name(db=db, user_name=username)
        return user
    except JWTError:
        return None
    except Exception:
        return None


def get_api_key_from_header(
    authorization: str = Header(default=""),
    x_api_key: str = Header(default="", alias="X-API-Key"),
) -> str:
    """
    Extract API key from Authorization header or X-API-Key header.

    Args:
        authorization: Authorization header value
        x_api_key: X-API-Key header value

    Returns:
        API key string or empty string if not found
    """
    # Priority: X-API-Key > Authorization Bearer
    if x_api_key and x_api_key.startswith("wg-"):
        return x_api_key
    if authorization.startswith("Bearer wg-"):
        return authorization[7:]  # Remove "Bearer " prefix
    return ""


def get_current_user_from_api_key(
    db: Session = Depends(get_db),
    api_key: str = Depends(get_api_key_from_header),
) -> Optional[User]:
    """
    Authenticate user via API key.

    Args:
        db: Database session
        api_key: API key string

    Returns:
        User object if API key is valid, None otherwise
    """
    if not api_key:
        return None

    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    api_key_record = (
        db.query(APIKey)
        .filter(
            APIKey.key_hash == key_hash,
            APIKey.is_active == True,
        )
        .first()
    )

    if not api_key_record:
        return None

    # Check expiration
    if api_key_record.expires_at < datetime.utcnow():
        return None

    # Update last_used_at
    api_key_record.last_used_at = datetime.utcnow()
    db.commit()

    return db.query(User).filter(User.id == api_key_record.user_id).first()


def get_current_user_flexible(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db),
    api_key: str = Depends(get_api_key_from_header),
) -> User:
    """
    Flexible authentication: supports both JWT token and API key.

    This function tries JWT authentication first, then falls back to API key.
    Use this for endpoints that need to support both authentication methods.

    Args:
        token: Optional JWT token
        db: Database session
        api_key: API key string

    Returns:
        Authenticated User object

    Raises:
        HTTPException: If neither authentication method succeeds
    """
    # Try JWT first
    if token:
        try:
            user = get_current_user_from_token(token, db)
            if user and user.is_active:
                return user
        except Exception:
            pass

    # Try API key
    user = get_current_user_from_api_key(db, api_key)
    if user and user.is_active:
        return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
