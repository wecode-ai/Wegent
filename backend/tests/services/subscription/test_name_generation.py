# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription name generation."""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.subscription.service import (
    generate_unique_subscription_name,
    subscription_service,
)


class TestGenerateUniqueSubscriptionName:
    """Test cases for generate_unique_subscription_name function."""

    def test_generates_name_with_correct_format(self, test_db: Session):
        """Test that generated name follows the expected format."""
        name = generate_unique_subscription_name(test_db, user_id=1)

        # Should start with 'sub-'
        assert name.startswith("sub-")
        # Should have 8 random characters after 'sub-'
        suffix = name[4:]
        assert len(suffix) == 8
        # Should only contain lowercase letters and digits
        assert suffix.isalnum()
        assert suffix.islower() or suffix.isdigit()

    def test_generates_unique_names(self, test_db: Session):
        """Test that multiple calls generate different names."""
        names = set()
        for _ in range(10):
            name = generate_unique_subscription_name(test_db, user_id=1)
            names.add(name)

        # All names should be unique
        assert len(names) == 10

    def test_avoids_existing_names(self, test_db: Session):
        """Test that generated name doesn't collide with existing subscriptions."""
        # Create an existing subscription
        existing_name = "sub-abc12345"
        existing = Kind(
            user_id=1,
            kind="Subscription",
            name=existing_name,
            namespace="default",
            json={"spec": {}, "metadata": {"name": existing_name}},
            is_active=True,
        )
        test_db.add(existing)
        test_db.commit()

        # Generate a new name - should be different
        name = generate_unique_subscription_name(test_db, user_id=1)
        assert name != existing_name

    def test_different_users_can_have_same_name_pattern(self, test_db: Session):
        """Test that name uniqueness is per-user."""
        name1 = generate_unique_subscription_name(test_db, user_id=1)
        name2 = generate_unique_subscription_name(test_db, user_id=2)

        # Same user should get different names
        name3 = generate_unique_subscription_name(test_db, user_id=1)
        assert name1 != name3

    def test_retries_on_collision(self, test_db: Session, monkeypatch):
        """Test that function retries when collision occurs."""
        # First, create a subscription with a known name
        existing_name = "sub-aaaaaaaa"
        existing = Kind(
            user_id=1,
            kind="Subscription",
            name=existing_name,
            namespace="default",
            json={"spec": {}, "metadata": {"name": existing_name}},
            is_active=True,
        )
        test_db.add(existing)
        test_db.commit()

        # Mock secrets.choice to always return 'a' to force collision
        call_count = 0

        def mock_choice(alphabet):
            nonlocal call_count
            call_count += 1
            return "a"

        monkeypatch.setattr(
            "app.services.subscription.service.secrets.choice", mock_choice
        )

        # Should retry and eventually fail after max_retries
        with pytest.raises(
            RuntimeError, match="Failed to generate unique subscription name"
        ):
            generate_unique_subscription_name(test_db, user_id=1)

        # Should have attempted max_retries times (default is 3)
        # Each name generation calls choice 8 times (for 8 characters)
        # So 3 retries × 8 characters = 24 calls
        assert call_count == 24


class TestCreateSubscriptionAutoName:
    """Test cases for auto-name generation in create_subscription."""

    def test_auto_generates_name_when_not_provided(self, test_db: Session, test_user):
        """Test that name is auto-generated when not provided."""
        from app.schemas.subscription import (
            SubscriptionCreate,
            SubscriptionExecutionTarget,
        )

        # Create a team first
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace="default",
            json={"spec": {}, "metadata": {"name": "test-team"}},
            is_active=True,
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)

        subscription_in = SubscriptionCreate(
            name=None,  # Not provided
            namespace="default",
            display_name="Test Subscription",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={"expression": "0 0 * * *"},
            execution_target=SubscriptionExecutionTarget(type="managed"),
            prompt_template="Test prompt template",
        )

        result = subscription_service.create_subscription(
            test_db, subscription_in=subscription_in, user_id=test_user.id
        )

        # Name should be auto-generated
        assert result.name is not None
        assert result.name.startswith("sub-")

    def test_uses_provided_name_when_given(self, test_db: Session, test_user):
        """Test that user-provided name is used when given."""
        from app.schemas.subscription import (
            SubscriptionCreate,
            SubscriptionExecutionTarget,
        )

        # Create a team first
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace="default",
            json={"spec": {}, "metadata": {"name": "test-team"}},
            is_active=True,
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)

        subscription_in = SubscriptionCreate(
            name="my-custom-name",
            namespace="default",
            display_name="Test Subscription",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={"expression": "0 0 * * *"},
            execution_target=SubscriptionExecutionTarget(type="managed"),
            prompt_template="Test prompt template",
        )

        result = subscription_service.create_subscription(
            test_db, subscription_in=subscription_in, user_id=test_user.id
        )

        assert result.name == "my-custom-name"

    def test_rejects_duplicate_user_provided_name(self, test_db: Session, test_user):
        """Test that duplicate user-provided names are rejected."""
        from fastapi import HTTPException

        from app.schemas.subscription import (
            SubscriptionCreate,
            SubscriptionExecutionTarget,
        )

        # Create a team first
        team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace="default",
            json={"spec": {}, "metadata": {"name": "test-team"}},
            is_active=True,
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)

        # Create first subscription
        subscription_in = SubscriptionCreate(
            name="duplicate-name",
            namespace="default",
            display_name="First Subscription",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={"expression": "0 0 * * *"},
            execution_target=SubscriptionExecutionTarget(type="managed"),
            prompt_template="Test prompt template",
        )

        subscription_service.create_subscription(
            test_db, subscription_in=subscription_in, user_id=test_user.id
        )

        # Try to create second with same name
        subscription_in2 = SubscriptionCreate(
            name="duplicate-name",
            namespace="default",
            display_name="Second Subscription",
            team_id=team.id,
            trigger_type="cron",
            trigger_config={"expression": "0 0 * * *"},
            execution_target=SubscriptionExecutionTarget(type="managed"),
            prompt_template="Test prompt template",
        )

        with pytest.raises(HTTPException) as exc_info:
            subscription_service.create_subscription(
                test_db, subscription_in=subscription_in2, user_id=test_user.id
            )

        assert "already exists" in str(exc_info.value.detail)
