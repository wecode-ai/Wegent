# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for Subscription follow and visibility features.

This module provides REST API endpoints for:
- Following/unfollowing public subscriptions
- Managing invitations for private subscriptions
- Discovering public subscriptions
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.subscription import (
    DiscoverSubscriptionsListResponse,
    FollowingSubscriptionsListResponse,
    InviteNamespaceRequest,
    InviteUserRequest,
    SubscriptionFollowersListResponse,
    SubscriptionInvitationsListResponse,
)
from app.services.subscription.follow_service import subscription_follow_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ========== Follow/Unfollow Endpoints ==========


@router.post("/{subscription_id}/follow", status_code=status.HTTP_200_OK)
def follow_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Follow a public subscription.

    Users can follow public subscriptions to see their execution results
    in their Feed timeline.
    """
    return subscription_follow_service.follow_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.delete("/{subscription_id}/follow", status_code=status.HTTP_200_OK)
def unfollow_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Unfollow a subscription.

    After unfollowing, the subscription's execution results will no longer
    appear in the user's Feed timeline.
    """
    return subscription_follow_service.unfollow_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.get(
    "/{subscription_id}/followers", response_model=SubscriptionFollowersListResponse
)
def get_followers(
    subscription_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get followers of a subscription.

    Only the subscription owner can view the full follower list.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.get_followers(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
    )


@router.get("/{subscription_id}/followers/count")
def get_followers_count(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get the number of followers for a subscription.

    This is public information for public subscriptions.
    """
    count = subscription_follow_service.get_followers_count(
        db=db,
        subscription_id=subscription_id,
    )
    return {"count": count}


# ========== Invitation Endpoints ==========


@router.post("/{subscription_id}/invite", status_code=status.HTTP_200_OK)
def invite_user(
    subscription_id: int,
    request: InviteUserRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Invite a user to follow a private subscription.

    Only the subscription owner can send invitations.
    Provide either user_id or email to identify the target user.
    """
    return subscription_follow_service.invite_user(
        db=db,
        subscription_id=subscription_id,
        owner_user_id=current_user.id,
        target_user_id=request.user_id,
        target_email=request.email,
    )


@router.post("/{subscription_id}/invite-namespace", status_code=status.HTTP_200_OK)
def invite_namespace(
    subscription_id: int,
    request: InviteNamespaceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Invite all members of a namespace (group) to follow a subscription.

    Only the subscription owner can send invitations.
    All members of the namespace will receive an invitation.
    """
    return subscription_follow_service.invite_namespace(
        db=db,
        subscription_id=subscription_id,
        owner_user_id=current_user.id,
        namespace_id=request.namespace_id,
    )


@router.delete("/{subscription_id}/invite/{user_id}", status_code=status.HTTP_200_OK)
def revoke_user_invitation(
    subscription_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Revoke a user's invitation or follow relationship.

    Only the subscription owner can revoke invitations.
    """
    return subscription_follow_service.revoke_invitation(
        db=db,
        subscription_id=subscription_id,
        owner_user_id=current_user.id,
        target_user_id=user_id,
    )


@router.delete(
    "/{subscription_id}/invite-namespace/{namespace_id}", status_code=status.HTTP_200_OK
)
def revoke_namespace_invitation(
    subscription_id: int,
    namespace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Revoke namespace share and all related pending invitations.

    Only the subscription owner can revoke namespace sharing.
    """
    return subscription_follow_service.revoke_namespace_invitation(
        db=db,
        subscription_id=subscription_id,
        owner_user_id=current_user.id,
        namespace_id=namespace_id,
    )


@router.get(
    "/{subscription_id}/invitations", response_model=SubscriptionInvitationsListResponse
)
def get_invitations_sent(
    subscription_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get invitations sent for a subscription.

    Only the subscription owner can view the invitation list.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.get_invitations_sent(
        db=db,
        subscription_id=subscription_id,
        owner_user_id=current_user.id,
        skip=skip,
        limit=limit,
    )


# ========== User-centric Endpoints ==========
# Note: These are defined under /api/users/me/... but routed here for organization


user_router = APIRouter()


@user_router.get(
    "/following-subscriptions", response_model=FollowingSubscriptionsListResponse
)
def get_following_subscriptions(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get subscriptions that the current user follows.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.get_following_subscriptions(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
    )


@user_router.get(
    "/subscription-invitations", response_model=SubscriptionInvitationsListResponse
)
def get_pending_invitations(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get pending subscription invitations for the current user.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.get_pending_invitations(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
    )


# ========== Invitation Response Endpoints ==========


invitation_router = APIRouter()


@invitation_router.post("/{invitation_id}/accept", status_code=status.HTTP_200_OK)
def accept_invitation(
    invitation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Accept a subscription invitation.
    """
    return subscription_follow_service.accept_invitation(
        db=db,
        invitation_id=invitation_id,
        user_id=current_user.id,
    )


@invitation_router.post("/{invitation_id}/reject", status_code=status.HTTP_200_OK)
def reject_invitation(
    invitation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Reject a subscription invitation.
    """
    return subscription_follow_service.reject_invitation(
        db=db,
        invitation_id=invitation_id,
        user_id=current_user.id,
    )


# ========== Discover Endpoint ==========


discover_router = APIRouter()


@discover_router.get("/discover", response_model=DiscoverSubscriptionsListResponse)
def discover_subscriptions(
    sort_by: str = Query("popularity", description="Sort by: 'popularity' or 'recent'"),
    search: Optional[str] = Query(None, description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Discover public subscriptions.

    Returns a list of public subscriptions that can be followed.
    Can be sorted by popularity (follower count) or recency.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.discover_subscriptions(
        db=db,
        user_id=current_user.id,
        sort_by=sort_by,
        search=search,
        skip=skip,
        limit=limit,
    )
