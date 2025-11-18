# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/models/user.py
"""

import pytest
from datetime import datetime

from app.models.user import User
from app.core import security


class TestUserModel:
    """Test User model"""

    def test_create_user_model(self, test_db):
        """Test creating a User model instance"""
        user = User(
            user_name="modeltest",
            email="model@test.com",
            password_hash=security.get_password_hash("test123"),
            is_active=True
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.id is not None
        assert user.user_name == "modeltest"
        assert user.email == "model@test.com"
        assert user.is_active is True

    def test_user_model_default_values(self, test_db):
        """Test User model default values"""
        user = User(
            user_name="defaulttest",
            password_hash="hashed"
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        # is_active defaults to True
        assert user.is_active is True
        # Timestamps should be set
        assert user.created_at is not None
        assert user.updated_at is not None

    def test_user_model_unique_username(self, test_db, test_user):
        """Test username uniqueness constraint"""
        duplicate_user = User(
            user_name="testuser",  # Duplicate
            password_hash="hashed"
        )

        test_db.add(duplicate_user)

        with pytest.raises(Exception):  # SQLAlchemy IntegrityError
            test_db.commit()

    def test_user_model_git_info_json(self, test_db):
        """Test storing git_info as JSON"""
        git_info = [
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "encrypted_token",
                "git_id": "12345"
            }
        ]

        user = User(
            user_name="gittest",
            password_hash="hashed",
            git_info=git_info
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.git_info is not None
        assert len(user.git_info) == 1
        assert user.git_info[0]["type"] == "github"

    def test_user_model_nullable_fields(self, test_db):
        """Test nullable fields can be None"""
        user = User(
            user_name="nulltest",
            password_hash="hashed",
            email=None,
            git_info=None
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        assert user.email is None
        assert user.git_info is None

    def test_user_model_updated_at_changes(self, test_db):
        """Test updated_at timestamp changes on update"""
        user = User(
            user_name="updatetest",
            password_hash="hashed"
        )

        test_db.add(user)
        test_db.commit()
        test_db.refresh(user)

        original_updated_at = user.updated_at

        # Update user
        user.email = "updated@test.com"
        test_db.commit()
        test_db.refresh(user)

        # updated_at should change
        assert user.updated_at >= original_updated_at

    def test_user_model_password_hash_required(self, test_db):
        """Test password_hash is required"""
        user = User(
            user_name="nohash"
            # Missing password_hash
        )

        test_db.add(user)

        with pytest.raises(Exception):  # SQLAlchemy IntegrityError
            test_db.commit()
