# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription Market API endpoints.

This module provides API endpoints for:
- Browsing market subscriptions (visibility=market)
- Renting market subscriptions
- Managing rental subscriptions
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.subscription import (
    MarketSubscriptionDetail,
    MarketSubscriptionsListResponse,
    RentalCountResponse,
    RentalSubscriptionResponse,
    RentalSubscriptionsListResponse,
    RentSubscriptionRequest,
)
from app.services.subscription import subscription_market_service

router = APIRouter()


@router.get("/subscriptions", response_model=MarketSubscriptionsListResponse)
def discover_market_subscriptions(
    sort_by: str = Query("rental_count", description="Sort by: rental_count or recent"),
    search: Optional[str] = Query(None, description="Search query"),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MarketSubscriptionsListResponse:
    """
    Discover market subscriptions.

    Browse subscriptions that have visibility=market. These subscriptions
    can be rented by other users.

    Sort options:
    - rental_count: Most rented first
    - recent: Most recently updated first
    """
    items, total = subscription_market_service.discover_market_subscriptions(
        db,
        user_id=current_user.id,
        sort_by=sort_by,
        search=search,
        skip=skip,
        limit=limit,
    )
    return MarketSubscriptionsListResponse(total=total, items=items)


@router.get("/subscriptions/{subscription_id}", response_model=MarketSubscriptionDetail)
def get_market_subscription_detail(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MarketSubscriptionDetail:
    """
    Get market subscription detail.

    Returns subscription details with sensitive information hidden
    (prompt_template, team_ref details, workspace_ref).
    """
    return subscription_market_service.get_market_subscription_detail(
        db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.post(
    "/subscriptions/{subscription_id}/rent",
    response_model=RentalSubscriptionResponse,
)
def rent_subscription(
    subscription_id: int,
    request: RentSubscriptionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> RentalSubscriptionResponse:
    """
    Rent a market subscription.

    Creates a new subscription that references the source subscription.
    The rental subscription only stores trigger configuration and optional
    model reference. Team, prompt, and workspace are read from the source
    subscription at execution time.

    Rental limitations:
    - Cannot modify prompt template
    - Cannot change agent (team)
    - Cannot change workspace
    - Can only configure trigger time and model
    """
    return subscription_market_service.rent_subscription(
        db,
        source_subscription_id=subscription_id,
        renter_user_id=current_user.id,
        request=request,
    )


@router.get("/users/me/rentals", response_model=RentalSubscriptionsListResponse)
def get_my_rentals(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> RentalSubscriptionsListResponse:
    """
    Get current user's rental subscriptions.

    Returns all subscriptions where is_rental=true for the current user.
    """
    items, total = subscription_market_service.get_user_rentals(
        db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
    )
    return RentalSubscriptionsListResponse(total=total, items=items)


@router.get(
    "/subscriptions/{subscription_id}/rental-count", response_model=RentalCountResponse
)
def get_rental_count(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> RentalCountResponse:
    """
    Get rental count for a subscription.

    Returns the number of times a market subscription has been rented.
    """
    return subscription_market_service.get_rental_count(
        db,
        subscription_id=subscription_id,
    )
