# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Union

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import security
from app.models.user import User


def authenticate_user(db: Session, username: str, password: str) -> Union[User, None]:
    """Public authentication logic"""
    user = db.scalar(select(User).where(User.user_name == username))
    if not user:
        return None
    if not user.is_active:
        raise HTTPException(status_code=400, detail="User not activated")
    if not security.verify_password(password, user.password_hash):
        return None
    return user
