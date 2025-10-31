# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Union

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from sqlalchemy import select
from jose import jwt, JWTError
from passlib.context import CryptContext

from app.core.config import settings
from app.api.dependencies import get_db
from app.models.user import User
from app.schemas.user import TokenData

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# OAuth2 password mode
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_PREFIX}/auth/oauth2")

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """Get current authenticated user"""
    # Verify token
    token_data = verify_token(token)
    username = token_data.get("username")
    
    # Query user
    user = db.query(User).filter(User.user_name == username).first()
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

def create_access_token(data: Dict[str, Any], expires_delta: Optional[int] = None) -> str:
    """
    Create access token
    
    Args:
        data: Token data
        expires_delta: Expiration time (minutes)
        
    Returns:
        Access token
    """
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now() + timedelta(minutes=expires_delta)
    else:
        expire = datetime.now() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM
    )
    return encoded_jwt

def authenticate_user(db: Session, username: str, password: Optional[str] = None, **kwargs) -> Union[User, None]:
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
        raise HTTPException(
            status_code=400,
            detail="User not activated"
        )
        
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
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
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
    # Here we assume users with username 'admin' are administrators
    # Actual projects may require more complex permission management
    if current_user.user_name != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied. Admin access required."
        )
    return current_user