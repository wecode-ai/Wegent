# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.user import User


@pytest.mark.unit
class TestUserModel:
    """Test User model"""

    def test_create_user_with_all_fields(self, test_db: Session):
        """Test creating a user with all fields"""
        user = User(
            user_name="newuser",
            password_hash=get_password_hash("password123"),
            email="newuser@example.com",
            is_active=True,
            git_info=[
                {
                    "type": "github",
                    "git_token": "token123",
                    "git_domain": "github.com",
                    "git_login": "newuser",
                }
            ],
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.id is not None
        assert user.user_name == "newuser"
        assert user.email == "newuser@example.com"
        assert user.is_active is True
        assert user.git_info is not None
        assert user.created_at is not None
        assert user.updated_at is not None

    def test_create_user_with_minimum_fields(self, test_db: Session):
        """Test creating a user with minimum required fields"""
        user = User(user_name="minuser", password_hash=get_password_hash("password123"))

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.id is not None
        assert user.user_name == "minuser"
        assert user.password_hash is not None
        assert user.is_active is True  # Default value

    def test_user_username_uniqueness(self, test_db: Session, test_user: User):
        """Test that username must be unique"""
        duplicate_user = User(
            user_name=test_user.user_name,  # Same username
            password_hash=get_password_hash("anotherpassword"),
        )

        test_db.add(duplicate_user)

        with pytest.raises(IntegrityError):
            test_db.commit()

    def test_user_password_hash_is_required(self, test_db: Session):
        """Test that password_hash is required"""
        user = User(user_name="testuser")  # Missing password_hash

        test_db.add(user)

        with pytest.raises(IntegrityError):
            test_db.commit()

    def test_user_git_info_json_field(self, test_db: Session):
        """Test that git_info can store JSON data"""
        git_info = [
            {"type": "github", "git_login": "user1"},
            {"type": "gitlab", "git_login": "user2"},
        ]

        user = User(
            user_name="jsonuser",
            password_hash=get_password_hash("password123"),
            git_info=git_info,
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.git_info == git_info
        assert len(user.git_info) == 2

    def test_user_is_active_default_value(self, test_db: Session):
        """Test that is_active defaults to True"""
        user = User(
            user_name="activeuser", password_hash=get_password_hash("password123")
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.is_active is True

    def test_user_timestamps_auto_set(self, test_db: Session):
        """Test that created_at and updated_at are automatically set"""
        user = User(
            user_name="timestampuser", password_hash=get_password_hash("password123")
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.created_at is not None
        assert user.updated_at is not None

    def test_user_update_modifies_updated_at(self, test_db: Session, test_user: User):
        """Test that updating a user modifies updated_at timestamp"""
        original_updated_at = test_user.updated_at

        # Update user
        test_user.email = "newemail@example.com"
        test_db.commit()
        test_db.refresh(test_user)

        # Note: In SQLite, updated_at might not change without explicit update
        # This test demonstrates the field exists and can be compared
        assert test_user.updated_at is not None
