#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Database migration script to encrypt existing plain text git tokens
"""

import logging
import os
import sys
from typing import List

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shared.utils.crypto import encrypt_git_token, is_token_encrypted
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models.user import User

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def migrate_user_tokens(db: Session) -> int:
    """
    Migrate all users' git tokens from plain text to encrypted format

    Args:
        db: Database session

    Returns:
        Number of users updated
    """
    updated_count = 0

    # Get all users
    users = db.query(User).filter(User.is_active == True).all()
    logger.info(f"Found {len(users)} active users")

    for user in users:
        if not user.git_info:
            logger.info(f"User {user.user_name} has no git_info, skipping")
            continue

        modified = False
        git_info_list = user.git_info if isinstance(user.git_info, list) else []

        for git_item in git_info_list:
            git_token = git_item.get("git_token", "")
            if not git_token:
                continue

            # Check if token is already encrypted
            if is_token_encrypted(git_token):
                logger.info(f"User {user.user_name} token already encrypted, skipping")
                continue

            # Encrypt the token
            try:
                encrypted_token = encrypt_git_token(git_token)
                git_item["git_token"] = encrypted_token
                modified = True
                logger.info(
                    f"Encrypted token for user {user.user_name}, type: {git_item.get('type')}"
                )
            except Exception as e:
                logger.error(
                    f"Failed to encrypt token for user {user.user_name}: {str(e)}"
                )
                continue

        if modified:
            # Update user's git_info
            user.git_info = git_info_list
            db.add(user)
            updated_count += 1

    # Commit all changes
    if updated_count > 0:
        db.commit()
        logger.info(f"Successfully updated {updated_count} users")
    else:
        logger.info("No users need to be updated")

    return updated_count


def main():
    """Main migration function"""
    logger.info("Starting git token encryption migration...")
    logger.info(f"Database URL: {settings.DATABASE_URL}")

    # Create database engine
    # Convert async database URL to sync version for migration script
    db_url = settings.DATABASE_URL.replace("mysql+asyncmy://", "mysql+pymysql://")
    engine = create_engine(db_url, pool_pre_ping=True)

    # Create session
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = SessionLocal()

    try:
        updated_count = migrate_user_tokens(db)
        logger.info(f"Migration completed. Updated {updated_count} users.")
        return 0
    except Exception as e:
        logger.error(f"Migration failed: {str(e)}")
        db.rollback()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
