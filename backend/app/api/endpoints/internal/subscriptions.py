# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints for Subscription management.

Provides internal API for chat_shell's CreateSubscriptionTool to create subscriptions.
These endpoints are intended for service-to-service communication, not user access.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
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
    x_wegent_subscription_context: Optional[str] = Header(
        default=None,
        alias="X-Wegent-Subscription-Context",
    ),
    x_service_name: Optional[str] = Header(default=None, alias="X-Service-Name"),
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

    if str(x_wegent_subscription_context).lower() in {"true", "1", "yes"}:
        logger.warning(
            "[internal] Rejected subscription creation in subscription context: "
            "name=%s, user_id=%d, team_id=%d",
            subscription_in.name,
            user_id,
            subscription_in.team_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="订阅任务中不允许创建订阅任务",
        )

    # Tool-based creation from chat-shell must never enable subscriptions directly.
    if str(x_service_name).lower() == "chat-shell":
        subscription_in.enabled = False

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
