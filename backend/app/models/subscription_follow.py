# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Database models for Subscription follow relationships and sharing.

These models support the subscription visibility and follow feature:
- SubscriptionFollow: Track user-subscription follow relationships
- SubscriptionShareNamespace: Track namespace-level subscription sharing
"""
from datetime import datetime
from enum import Enum

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
)

from app.db.base import Base


class FollowType(str, Enum):
    """Follow type enumeration."""

    DIRECT = "direct"  # User directly followed a public subscription
    INVITED = "invited"  # User was invited to follow a private subscription


class InvitationStatus(str, Enum):
    """Invitation status enumeration."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class SubscriptionFollow(Base):
    """
    Subscription follow relationship table.

    Tracks which users follow which subscriptions, supporting both direct follows
    (for public subscriptions) and invitation-based follows (for private subscriptions).
    """

    __tablename__ = "subscription_follows"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # The subscription being followed
    subscription_id = Column(Integer, nullable=False, index=True)

    # The user following the subscription
    follower_user_id = Column(Integer, nullable=False, index=True)

    # Follow type: 'direct' for public subscriptions, 'invited' for private
    follow_type = Column(String(20), nullable=False, default=FollowType.DIRECT.value)

    # Invitation fields (only used when follow_type='invited')
    # For direct follows, invited_by_user_id should be 0
    invited_by_user_id = Column(Integer, nullable=False, default=0)
    invitation_status = Column(
        String(20), nullable=False, default=InvitationStatus.PENDING.value
    )  # pending, accepted, rejected
    # For direct follows, invited_at and responded_at use created_at as default
    invited_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    responded_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        # Index for querying followers of a subscription
        Index("ix_sub_follow_subscription", "subscription_id"),
        # Index for querying subscriptions a user follows
        Index("ix_sub_follow_follower", "follower_user_id"),
        # Unique constraint: a user can only follow a subscription once
        Index(
            "ix_sub_follow_unique", "subscription_id", "follower_user_id", unique=True
        ),
        # Index for pending invitations for a user
        Index(
            "ix_sub_follow_pending_invitations",
            "follower_user_id",
            "invitation_status",
        ),
    )


class SubscriptionShareNamespace(Base):
    """
    Subscription share to namespace table.

    Tracks subscriptions shared to entire namespaces (groups), allowing all
    members of the namespace to receive invitations.
    """

    __tablename__ = "subscription_share_namespaces"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # The subscription being shared
    subscription_id = Column(Integer, nullable=False, index=True)

    # The namespace (group) receiving the share
    namespace_id = Column(Integer, nullable=False, index=True)

    # Who shared the subscription
    shared_by_user_id = Column(Integer, nullable=False)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        # Unique constraint: a subscription can only be shared to a namespace once
        Index("ix_sub_share_ns_unique", "subscription_id", "namespace_id", unique=True),
    )
