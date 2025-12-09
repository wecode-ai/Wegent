# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Tuple, Union

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.user import User
from app.schemas.user import TokenData
from app.services.user import user_service

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# OAuth2 password mode
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/oauth2")


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


def create_impersonation_token(
    target_user: User,
    admin_user: User,
    impersonation_request_id: int,
    session_expires_at: datetime,
) -> str:
    """
    Create an impersonation access token.

    Args:
        target_user: User being impersonated
        admin_user: Admin performing the impersonation
        impersonation_request_id: ID of the impersonation request
        session_expires_at: When the session expires

    Returns:
        JWT access token for impersonation
    """
    from datetime import timezone

    to_encode = {
        "sub": target_user.user_name,
        "user_id": target_user.id,
        "impersonator_id": admin_user.id,
        "impersonator_name": admin_user.user_name,
        "impersonation_request_id": impersonation_request_id,
        "is_impersonating": True,
        "exp": session_expires_at,
    }

    encoded_jwt = jwt.encode(
        to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM
    )
    return encoded_jwt


def verify_impersonation_token(token: str) -> Dict[str, Any]:
    """
    Verify an impersonation token and extract its data.

    Args:
        token: JWT token

    Returns:
        Token payload including impersonation details

    Raises:
        HTTPException: If token is invalid
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate impersonation credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        username: str = payload.get("sub")
        is_impersonating: bool = payload.get("is_impersonating", False)

        if username is None:
            raise credentials_exception

        return {
            "username": username,
            "user_id": payload.get("user_id"),
            "is_impersonating": is_impersonating,
            "impersonator_id": payload.get("impersonator_id"),
            "impersonator_name": payload.get("impersonator_name"),
            "impersonation_request_id": payload.get("impersonation_request_id"),
        }
    except JWTError:
        raise credentials_exception


def get_current_user_with_impersonation_info(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> Tuple[User, Dict[str, Any]]:
    """
    Get current user with impersonation information.

    Args:
        token: JWT token
        db: Database session

    Returns:
        Tuple of (user, impersonation_info)
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        username: str = payload.get("sub")

        if username is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

        user = user_service.get_user_by_name(db=db, user_name=username)
        if user is None or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
                headers={"WWW-Authenticate": "Bearer"},
            )

        impersonation_info = {
            "is_impersonating": payload.get("is_impersonating", False),
            "impersonator_id": payload.get("impersonator_id"),
            "impersonator_name": payload.get("impersonator_name"),
            "impersonation_request_id": payload.get("impersonation_request_id"),
        }

        return user, impersonation_info

    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_impersonation_info_from_request(request: Request) -> Optional[Dict[str, Any]]:
    """
    Extract impersonation info from request authorization header.

    Args:
        request: FastAPI Request object

    Returns:
        Impersonation info dict or None if not impersonating
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None

    try:
        token = auth_header.split(" ")[1]
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )

        if not payload.get("is_impersonating"):
            return None

        return {
            "is_impersonating": True,
            "impersonator_id": payload.get("impersonator_id"),
            "impersonator_name": payload.get("impersonator_name"),
            "impersonation_request_id": payload.get("impersonation_request_id"),
            "target_user_id": payload.get("user_id"),
        }
    except (JWTError, IndexError):
        return None
