# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for admin user operations."""

from sqlalchemy.orm import Session

from app.core.yaml_init import DEFAULT_ADMIN_Password_HASH
from app.models.user import User


def is_admin_password_default(db: Session) -> bool:
    """
    Check if the admin user's password is still the default value.

    Queries the admin user from the database and compares the password hash
    with the known default admin password hash.

    Args:
        db: Database session

    Returns:
        True if the admin password is still the default, False if changed
        or if the admin user does not exist.
    """
    admin_user = db.query(User).filter(User.user_name == "admin").first()
    if not admin_user:
        return False
    return admin_user.password_hash == DEFAULT_ADMIN_Password_HASH
