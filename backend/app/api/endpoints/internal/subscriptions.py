# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints for Subscription management.

Provides internal API for chat_shell's CreateSubscriptionTool to create subscriptions.
These endpoints are intended for service-to-service communication, not user access.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionInDB,
)
from app.services.subscription import subscription_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/subscriptions", tags=["internal-subscriptions"])


@router.post("", response_model=SubscriptionInDB, status_code=status.HTTP_201_CREATED)
def create_subscription_internal(
    subscription_in: SubscriptionCreate,
    user_id: int,
    db: Session = Depends(get_db),
):
    """
    Create a new Subscription configuration (internal API).

    This is an internal API for chat_shell's CreateSubscriptionTool.
    It creates a subscription on behalf of the specified user.

    Args:
        subscription_in: Subscription creation data
        user_id: User ID to create the subscription for
        db: Database session

    Returns:
        SubscriptionInDB with created subscription data
    """
    logger.info(
        f"[internal] Creating subscription: name={subscription_in.name}, "
        f"user_id={user_id}, team_id={subscription_in.team_id}"
    )

    try:
        result = subscription_service.create_subscription(
            db=db,
            subscription_in=subscription_in,
            user_id=user_id,
        )
        logger.info(
            f"[internal] Subscription created: id={result.id}, name={result.name}"
        )
        return result
    except Exception as e:
        logger.error(f"[internal] Failed to create subscription: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create subscription: {str(e)}",
        )
