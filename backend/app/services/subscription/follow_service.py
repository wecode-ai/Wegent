# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription follow service for managing follow relationships.

This module provides the SubscriptionFollowService class for managing
follow relationships between users and subscriptions.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import and_, desc, func
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.subscription_follow import (
    FollowType,
    InvitationStatus,
    SubscriptionFollow,
    SubscriptionShareNamespace,
)
from app.models.user import User
from app.schemas.subscription import (
    DiscoverSubscriptionResponse,
    DiscoverSubscriptionsListResponse,
    FollowingSubscriptionResponse,
    FollowingSubscriptionsListResponse,
)
from app.schemas.subscription import FollowType as SchemaFollowType
from app.schemas.subscription import InvitationStatus as SchemaInvitationStatus
from app.schemas.subscription import (
    Subscription,
    SubscriptionFollowerResponse,
    SubscriptionFollowersListResponse,
    SubscriptionInDB,
    SubscriptionInvitationResponse,
    SubscriptionInvitationsListResponse,
    SubscriptionTriggerType,
    SubscriptionVisibility,
)
from app.services.subscription.helpers import extract_trigger_config

logger = logging.getLogger(__name__)


class SubscriptionFollowService:
    """Service class for subscription follow operations."""

    def follow_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> dict:
        """
        Follow a public subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription to follow
            user_id: ID of the user following

        Returns:
            Success message

        Raises:
            HTTPException: If subscription not found, not public, or already following
        """
        # Get subscription and verify it's public
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        # Check if user owns the subscription
        if subscription.user_id == user_id:
            raise HTTPException(
                status_code=400, detail="Cannot follow your own subscription"
            )

        # Check visibility
        subscription_crd = Subscription.model_validate(subscription.json)
        visibility = getattr(
            subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
        )

        if visibility != SubscriptionVisibility.PUBLIC:
            raise HTTPException(
                status_code=403,
                detail="Cannot follow a private subscription. Request an invitation instead.",
            )

        # Check if already following
        existing = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400, detail="Already following this subscription"
            )

        # Create follow record
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        follow = SubscriptionFollow(
            subscription_id=subscription_id,
            follower_user_id=user_id,
            follow_type=FollowType.DIRECT.value,
            invited_by_user_id=0,  # No inviter for direct follows
            invitation_status=InvitationStatus.ACCEPTED.value,  # Direct follows are auto-accepted
            invited_at=now,  # Use current time as default
            responded_at=now,  # Use current time as default
            created_at=now,
            updated_at=now,
        )
        db.add(follow)
        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {user_id} followed subscription {subscription_id}"
        )

        return {"message": "Successfully followed subscription"}

    def unfollow_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> dict:
        """
        Unfollow a subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription to unfollow
            user_id: ID of the user unfollowing

        Returns:
            Success message

        Raises:
            HTTPException: If not following the subscription
        """
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
            )
            .first()
        )

        if not follow:
            raise HTTPException(
                status_code=404, detail="Not following this subscription"
            )

        db.delete(follow)
        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {user_id} unfollowed subscription {subscription_id}"
        )

        return {"message": "Successfully unfollowed subscription"}

    def get_followers(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
    ) -> SubscriptionFollowersListResponse:
        """
        Get followers of a subscription.

        Only the subscription owner can view the full follower list.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            user_id: ID of the requesting user (must be owner)
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            List of followers with pagination

        Raises:
            HTTPException: If not owner or subscription not found
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can view followers"
            )

        # Query followers
        query = db.query(SubscriptionFollow).filter(
            SubscriptionFollow.subscription_id == subscription_id,
            SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
        )

        total = query.count()
        follows = (
            query.order_by(desc(SubscriptionFollow.created_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        # Get user info for each follower
        items = []
        for follow in follows:
            user = db.query(User).filter(User.id == follow.follower_user_id).first()
            if user:
                items.append(
                    SubscriptionFollowerResponse(
                        user_id=user.id,
                        username=user.user_name,
                        follow_type=SchemaFollowType(follow.follow_type),
                        followed_at=follow.created_at,
                    )
                )

        return SubscriptionFollowersListResponse(total=total, items=items)

    def get_followers_count(
        self,
        db: Session,
        *,
        subscription_id: int,
    ) -> int:
        """
        Get the number of followers for a subscription.

        This is public information for public subscriptions.

        Args:
            db: Database session
            subscription_id: ID of the subscription

        Returns:
            Number of followers
        """
        return (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .count()
        )

    def get_following_subscriptions(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
    ) -> FollowingSubscriptionsListResponse:
        """
        Get subscriptions that a user follows.

        Args:
            db: Database session
            user_id: ID of the user
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            List of followed subscriptions with pagination
        """
        query = db.query(SubscriptionFollow).filter(
            SubscriptionFollow.follower_user_id == user_id,
            SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
        )

        total = query.count()
        follows = (
            query.order_by(desc(SubscriptionFollow.created_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        items = []
        for follow in follows:
            subscription = (
                db.query(Kind)
                .filter(
                    Kind.id == follow.subscription_id,
                    Kind.kind == "Subscription",
                    Kind.is_active == True,
                )
                .first()
            )
            if subscription:
                subscription_in_db = self._convert_to_subscription_in_db(
                    db, subscription, user_id
                )
                items.append(
                    FollowingSubscriptionResponse(
                        subscription=subscription_in_db,
                        follow_type=SchemaFollowType(follow.follow_type),
                        followed_at=follow.created_at,
                    )
                )

        return FollowingSubscriptionsListResponse(total=total, items=items)

    def is_following(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> bool:
        """
        Check if a user is following a subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            user_id: ID of the user

        Returns:
            True if following, False otherwise
        """
        return (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .first()
            is not None
        )

    def invite_user(
        self,
        db: Session,
        *,
        subscription_id: int,
        owner_user_id: int,
        target_user_id: Optional[int] = None,
        target_email: Optional[str] = None,
    ) -> dict:
        """
        Invite a user to follow a private subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            owner_user_id: ID of the subscription owner
            target_user_id: ID of the user to invite (optional)
            target_email: Email of the user to invite (optional)

        Returns:
            Success message

        Raises:
            HTTPException: If not owner, user not found, or already invited
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != owner_user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can send invitations"
            )

        # Find target user
        target_user = None
        if target_user_id:
            target_user = db.query(User).filter(User.id == target_user_id).first()
        elif target_email:
            target_user = db.query(User).filter(User.email == target_email).first()

        if not target_user:
            raise HTTPException(status_code=404, detail="User not found")

        if target_user.id == owner_user_id:
            raise HTTPException(status_code=400, detail="Cannot invite yourself")

        # Check if already invited or following
        existing = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == target_user.id,
            )
            .first()
        )

        if existing:
            if existing.invitation_status == InvitationStatus.ACCEPTED.value:
                raise HTTPException(
                    status_code=400,
                    detail="User is already following this subscription",
                )
            elif existing.invitation_status == InvitationStatus.PENDING.value:
                raise HTTPException(
                    status_code=400, detail="User already has a pending invitation"
                )
            # If rejected, update to pending again
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            existing.invitation_status = InvitationStatus.PENDING.value
            existing.invited_at = now
            existing.responded_at = (
                now  # Reset to current time (will be updated when user responds)
            )
            existing.updated_at = now
            db.commit()
        else:
            # Create invitation
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            follow = SubscriptionFollow(
                subscription_id=subscription_id,
                follower_user_id=target_user.id,
                follow_type=FollowType.INVITED.value,
                invited_by_user_id=owner_user_id,
                invitation_status=InvitationStatus.PENDING.value,
                invited_at=now,
                responded_at=now,  # Default value, will be updated when user responds
                created_at=now,
                updated_at=now,
            )
            db.add(follow)
            db.commit()

        logger.info(
            f"[SubscriptionFollow] User {owner_user_id} invited user {target_user.id} to subscription {subscription_id}"
        )

        return {"message": "Invitation sent successfully"}

    def invite_namespace(
        self,
        db: Session,
        *,
        subscription_id: int,
        owner_user_id: int,
        namespace_id: int,
    ) -> dict:
        """
        Invite all members of a namespace to follow a subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            owner_user_id: ID of the subscription owner
            namespace_id: ID of the namespace to invite

        Returns:
            Success message with count of invitations sent

        Raises:
            HTTPException: If not owner or namespace not found
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != owner_user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can send invitations"
            )

        # Verify namespace exists
        namespace = db.query(Namespace).filter(Namespace.id == namespace_id).first()
        if not namespace:
            raise HTTPException(status_code=404, detail="Namespace not found")

        # Record namespace share
        existing_share = (
            db.query(SubscriptionShareNamespace)
            .filter(
                SubscriptionShareNamespace.subscription_id == subscription_id,
                SubscriptionShareNamespace.namespace_id == namespace_id,
            )
            .first()
        )

        if not existing_share:
            share = SubscriptionShareNamespace(
                subscription_id=subscription_id,
                namespace_id=namespace_id,
                shared_by_user_id=owner_user_id,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(share)

        # Get namespace members
        members = (
            db.query(NamespaceMember)
            .filter(NamespaceMember.namespace_id == namespace_id)
            .all()
        )

        invited_count = 0
        for member in members:
            if member.user_id == owner_user_id:
                continue

            # Check if already has follow record
            existing = (
                db.query(SubscriptionFollow)
                .filter(
                    SubscriptionFollow.subscription_id == subscription_id,
                    SubscriptionFollow.follower_user_id == member.user_id,
                )
                .first()
            )

            if not existing:
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                follow = SubscriptionFollow(
                    subscription_id=subscription_id,
                    follower_user_id=member.user_id,
                    follow_type=FollowType.INVITED.value,
                    invited_by_user_id=owner_user_id,
                    invitation_status=InvitationStatus.PENDING.value,
                    invited_at=now,
                    responded_at=now,  # Default value, will be updated when user responds
                    created_at=now,
                    updated_at=now,
                )
                db.add(follow)
                invited_count += 1

        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {owner_user_id} invited namespace {namespace_id} ({invited_count} users) to subscription {subscription_id}"
        )

        return {"message": f"Invited {invited_count} users from namespace"}

    def revoke_invitation(
        self,
        db: Session,
        *,
        subscription_id: int,
        owner_user_id: int,
        target_user_id: int,
    ) -> dict:
        """
        Revoke a user's invitation or follow relationship.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            owner_user_id: ID of the subscription owner
            target_user_id: ID of the user whose invitation to revoke

        Returns:
            Success message

        Raises:
            HTTPException: If not owner or follow not found
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != owner_user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can revoke invitations"
            )

        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == target_user_id,
            )
            .first()
        )

        if not follow:
            raise HTTPException(status_code=404, detail="Invitation not found")

        db.delete(follow)
        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {owner_user_id} revoked invitation for user {target_user_id} on subscription {subscription_id}"
        )

        return {"message": "Invitation revoked successfully"}

    def revoke_namespace_invitation(
        self,
        db: Session,
        *,
        subscription_id: int,
        owner_user_id: int,
        namespace_id: int,
    ) -> dict:
        """
        Revoke namespace share and all related invitations.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            owner_user_id: ID of the subscription owner
            namespace_id: ID of the namespace

        Returns:
            Success message

        Raises:
            HTTPException: If not owner or share not found
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != owner_user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can revoke namespace sharing"
            )

        # Delete namespace share record
        share = (
            db.query(SubscriptionShareNamespace)
            .filter(
                SubscriptionShareNamespace.subscription_id == subscription_id,
                SubscriptionShareNamespace.namespace_id == namespace_id,
            )
            .first()
        )

        if share:
            db.delete(share)

        # Get namespace members and delete their pending invitations
        members = (
            db.query(NamespaceMember)
            .filter(NamespaceMember.namespace_id == namespace_id)
            .all()
        )

        for member in members:
            follow = (
                db.query(SubscriptionFollow)
                .filter(
                    SubscriptionFollow.subscription_id == subscription_id,
                    SubscriptionFollow.follower_user_id == member.user_id,
                    SubscriptionFollow.follow_type == FollowType.INVITED.value,
                    SubscriptionFollow.invitation_status
                    == InvitationStatus.PENDING.value,
                )
                .first()
            )
            if follow:
                db.delete(follow)

        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {owner_user_id} revoked namespace {namespace_id} sharing for subscription {subscription_id}"
        )

        return {"message": "Namespace sharing revoked successfully"}

    def get_invitations_sent(
        self,
        db: Session,
        *,
        subscription_id: int,
        owner_user_id: int,
        skip: int = 0,
        limit: int = 50,
    ) -> SubscriptionInvitationsListResponse:
        """
        Get invitations sent for a subscription.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            owner_user_id: ID of the subscription owner
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            List of invitations

        Raises:
            HTTPException: If not owner or subscription not found
        """
        # Verify ownership
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        if subscription.user_id != owner_user_id:
            raise HTTPException(
                status_code=403, detail="Only the owner can view invitations"
            )

        query = db.query(SubscriptionFollow).filter(
            SubscriptionFollow.subscription_id == subscription_id,
            SubscriptionFollow.follow_type == FollowType.INVITED.value,
        )

        total = query.count()
        follows = (
            query.order_by(desc(SubscriptionFollow.created_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        subscription_crd = Subscription.model_validate(subscription.json)
        owner = db.query(User).filter(User.id == subscription.user_id).first()

        items = []
        for follow in follows:
            inviter = (
                db.query(User).filter(User.id == follow.invited_by_user_id).first()
            )
            items.append(
                SubscriptionInvitationResponse(
                    id=follow.id,
                    subscription_id=subscription_id,
                    subscription_name=subscription.name,
                    subscription_display_name=subscription_crd.spec.displayName,
                    invited_by_user_id=follow.invited_by_user_id or owner_user_id,
                    invited_by_username=inviter.user_name if inviter else "",
                    invitation_status=SchemaInvitationStatus(follow.invitation_status),
                    invited_at=follow.invited_at or follow.created_at,
                    owner_username=owner.user_name if owner else "",
                )
            )

        return SubscriptionInvitationsListResponse(total=total, items=items)

    def get_pending_invitations(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
    ) -> SubscriptionInvitationsListResponse:
        """
        Get pending invitations for a user.

        Args:
            db: Database session
            user_id: ID of the user
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            List of pending invitations
        """
        query = db.query(SubscriptionFollow).filter(
            SubscriptionFollow.follower_user_id == user_id,
            SubscriptionFollow.follow_type == FollowType.INVITED.value,
            SubscriptionFollow.invitation_status == InvitationStatus.PENDING.value,
        )

        total = query.count()
        follows = (
            query.order_by(desc(SubscriptionFollow.invited_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        items = []
        for follow in follows:
            subscription = (
                db.query(Kind)
                .filter(
                    Kind.id == follow.subscription_id,
                    Kind.kind == "Subscription",
                    Kind.is_active == True,
                )
                .first()
            )
            if not subscription:
                continue

            subscription_crd = Subscription.model_validate(subscription.json)
            owner = db.query(User).filter(User.id == subscription.user_id).first()
            inviter = (
                db.query(User).filter(User.id == follow.invited_by_user_id).first()
            )

            items.append(
                SubscriptionInvitationResponse(
                    id=follow.id,
                    subscription_id=follow.subscription_id,
                    subscription_name=subscription.name,
                    subscription_display_name=subscription_crd.spec.displayName,
                    invited_by_user_id=follow.invited_by_user_id or 0,
                    invited_by_username=inviter.user_name if inviter else "",
                    invitation_status=SchemaInvitationStatus(follow.invitation_status),
                    invited_at=follow.invited_at or follow.created_at,
                    owner_username=owner.user_name if owner else "",
                )
            )

        return SubscriptionInvitationsListResponse(total=total, items=items)

    def accept_invitation(
        self,
        db: Session,
        *,
        invitation_id: int,
        user_id: int,
    ) -> dict:
        """
        Accept a subscription invitation.

        Args:
            db: Database session
            invitation_id: ID of the invitation (follow record)
            user_id: ID of the user accepting

        Returns:
            Success message

        Raises:
            HTTPException: If invitation not found or not for this user
        """
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.id == invitation_id,
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.follow_type == FollowType.INVITED.value,
                SubscriptionFollow.invitation_status == InvitationStatus.PENDING.value,
            )
            .first()
        )

        if not follow:
            raise HTTPException(
                status_code=404,
                detail="Invitation not found or already responded",
            )

        follow.invitation_status = InvitationStatus.ACCEPTED.value
        follow.responded_at = datetime.now(timezone.utc).replace(tzinfo=None)
        follow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {user_id} accepted invitation {invitation_id}"
        )

        return {"message": "Invitation accepted"}

    def reject_invitation(
        self,
        db: Session,
        *,
        invitation_id: int,
        user_id: int,
    ) -> dict:
        """
        Reject a subscription invitation.

        Args:
            db: Database session
            invitation_id: ID of the invitation (follow record)
            user_id: ID of the user rejecting

        Returns:
            Success message

        Raises:
            HTTPException: If invitation not found or not for this user
        """
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.id == invitation_id,
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.follow_type == FollowType.INVITED.value,
                SubscriptionFollow.invitation_status == InvitationStatus.PENDING.value,
            )
            .first()
        )

        if not follow:
            raise HTTPException(
                status_code=404,
                detail="Invitation not found or already responded",
            )

        follow.invitation_status = InvitationStatus.REJECTED.value
        follow.responded_at = datetime.now(timezone.utc).replace(tzinfo=None)
        follow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

        logger.info(
            f"[SubscriptionFollow] User {user_id} rejected invitation {invitation_id}"
        )

        return {"message": "Invitation rejected"}

    def discover_subscriptions(
        self,
        db: Session,
        *,
        user_id: int,
        sort_by: str = "popularity",
        search: Optional[str] = None,
        skip: int = 0,
        limit: int = 50,
    ) -> DiscoverSubscriptionsListResponse:
        """
        Discover public subscriptions.

        Args:
            db: Database session
            user_id: ID of the requesting user
            sort_by: Sort method ('popularity' or 'recent')
            search: Search query
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            List of public subscriptions
        """
        # Get all public subscriptions
        subscriptions = (
            db.query(Kind)
            .filter(
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .all()
        )

        # Filter to public only
        public_subscriptions = []
        for sub in subscriptions:
            sub_crd = Subscription.model_validate(sub.json)
            visibility = getattr(
                sub_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
            )
            if visibility == SubscriptionVisibility.PUBLIC:
                # Apply search filter
                if search:
                    search_lower = search.lower()
                    if search_lower not in sub_crd.spec.displayName.lower() and (
                        not sub_crd.spec.description
                        or search_lower not in sub_crd.spec.description.lower()
                    ):
                        continue
                public_subscriptions.append(sub)

        # Get follower counts
        subscription_data = []
        for sub in public_subscriptions:
            followers_count = self.get_followers_count(db, subscription_id=sub.id)
            is_following_sub = self.is_following(
                db, subscription_id=sub.id, user_id=user_id
            )
            owner = db.query(User).filter(User.id == sub.user_id).first()
            sub_crd = Subscription.model_validate(sub.json)

            subscription_data.append(
                {
                    "subscription": sub,
                    "crd": sub_crd,
                    "followers_count": followers_count,
                    "is_following": is_following_sub,
                    "owner_username": owner.user_name if owner else "",
                }
            )

        # Sort
        if sort_by == "popularity":
            subscription_data.sort(key=lambda x: x["followers_count"], reverse=True)
        else:  # recent
            subscription_data.sort(
                key=lambda x: x["subscription"].updated_at, reverse=True
            )

        # Paginate
        total = len(subscription_data)
        paginated = subscription_data[skip : skip + limit]

        items = []
        for data in paginated:
            sub = data["subscription"]
            sub_crd = data["crd"]
            items.append(
                DiscoverSubscriptionResponse(
                    id=sub.id,
                    name=sub.name,
                    display_name=sub_crd.spec.displayName,
                    description=sub_crd.spec.description,
                    task_type=sub_crd.spec.taskType,
                    owner_user_id=sub.user_id,
                    owner_username=data["owner_username"],
                    followers_count=data["followers_count"],
                    is_following=data["is_following"],
                    created_at=sub.created_at,
                    updated_at=sub.updated_at,
                )
            )

        return DiscoverSubscriptionsListResponse(total=total, items=items)

    def handle_visibility_change(
        self,
        db: Session,
        *,
        subscription_id: int,
        old_visibility: SubscriptionVisibility,
        new_visibility: SubscriptionVisibility,
    ) -> None:
        """
        Handle visibility change side effects.

        When changing from public to private, remove all direct follows.

        Args:
            db: Database session
            subscription_id: ID of the subscription
            old_visibility: Previous visibility
            new_visibility: New visibility
        """
        if (
            old_visibility == SubscriptionVisibility.PUBLIC
            and new_visibility == SubscriptionVisibility.PRIVATE
        ):
            # Remove all direct follows
            db.query(SubscriptionFollow).filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follow_type == FollowType.DIRECT.value,
            ).delete()
            db.commit()

            logger.info(
                f"[SubscriptionFollow] Removed direct follows for subscription {subscription_id} due to visibility change to private"
            )

    def get_followed_subscription_ids(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> List[int]:
        """
        Get IDs of subscriptions a user follows.

        Args:
            db: Database session
            user_id: ID of the user

        Returns:
            List of subscription IDs
        """
        follows = (
            db.query(SubscriptionFollow.subscription_id)
            .filter(
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .all()
        )
        return [f[0] for f in follows]

    def _convert_to_subscription_in_db(
        self, db: Session, subscription: Kind, current_user_id: Optional[int] = None
    ) -> SubscriptionInDB:
        """Convert Kind to SubscriptionInDB with follow info."""
        subscription_crd = Subscription.model_validate(subscription.json)
        internal = subscription.json.get("_internal", {})

        # Build webhook URL
        webhook_url = None
        webhook_token = internal.get("webhook_token")
        if webhook_token:
            webhook_url = f"/api/subscriptions/webhook/{webhook_token}"

        # Extract model_ref from CRD
        model_ref = None
        if subscription_crd.spec.modelRef:
            model_ref = {
                "name": subscription_crd.spec.modelRef.name,
                "namespace": subscription_crd.spec.modelRef.namespace,
            }

        # Parse next_execution_time
        next_execution_time = None
        if internal.get("next_execution_time"):
            try:
                next_execution_time = datetime.fromisoformat(
                    internal["next_execution_time"]
                )
            except (ValueError, TypeError):
                pass

        # Parse last_execution_time
        last_execution_time = None
        if internal.get("last_execution_time"):
            try:
                last_execution_time = datetime.fromisoformat(
                    internal["last_execution_time"]
                )
            except (ValueError, TypeError):
                pass

        # Get follow info
        followers_count = self.get_followers_count(db, subscription_id=subscription.id)
        is_following_sub = False
        if current_user_id:
            is_following_sub = self.is_following(
                db, subscription_id=subscription.id, user_id=current_user_id
            )

        # Get owner username
        owner = db.query(User).filter(User.id == subscription.user_id).first()
        owner_username = owner.user_name if owner else None

        # Get visibility with default
        visibility = getattr(
            subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
        )

        return SubscriptionInDB(
            id=subscription.id,
            user_id=subscription.user_id,
            name=subscription.name,
            namespace=subscription.namespace,
            display_name=subscription_crd.spec.displayName,
            description=subscription_crd.spec.description,
            task_type=subscription_crd.spec.taskType,
            visibility=visibility,
            trigger_type=SubscriptionTriggerType(internal.get("trigger_type", "cron")),
            trigger_config=extract_trigger_config(subscription_crd.spec.trigger),
            team_id=internal.get("team_id", 0),
            workspace_id=internal.get("workspace_id", 0),
            model_ref=model_ref,
            force_override_bot_model=subscription_crd.spec.forceOverrideBotModel,
            prompt_template=subscription_crd.spec.promptTemplate,
            retry_count=subscription_crd.spec.retryCount,
            timeout_seconds=subscription_crd.spec.timeoutSeconds,
            enabled=internal.get("enabled", True),
            preserve_history=subscription_crd.spec.preserveHistory,
            history_message_count=subscription_crd.spec.historyMessageCount,
            bound_task_id=internal.get("bound_task_id", 0),
            webhook_url=webhook_url,
            webhook_secret=internal.get("webhook_secret"),
            last_execution_time=last_execution_time,
            last_execution_status=internal.get("last_execution_status"),
            next_execution_time=next_execution_time,
            execution_count=internal.get("execution_count", 0),
            success_count=internal.get("success_count", 0),
            failure_count=internal.get("failure_count", 0),
            followers_count=followers_count,
            is_following=is_following_sub,
            owner_username=owner_username,
            created_at=subscription.created_at,
            updated_at=subscription.updated_at,
        )


# Singleton instance
subscription_follow_service = SubscriptionFollowService()
