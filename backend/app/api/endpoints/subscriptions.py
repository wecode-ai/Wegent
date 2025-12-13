# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription API routes for Smart Feed feature
"""
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subscription import SubscriptionRun
from app.models.user import User
from app.schemas.subscription import (
    FeedSummaryRequest,
    FeedSummaryResponse,
    MarkReadRequest,
    SubscriptionCreate,
    SubscriptionInDB,
    SubscriptionItemInDB,
    SubscriptionItemListResponse,
    SubscriptionListResponse,
    SubscriptionRunInDB,
    SubscriptionRunListResponse,
    SubscriptionUpdate,
    UnreadCountResponse,
    WebhookTriggerRequest,
    WebhookTriggerResponse,
)
from app.services.subscription import subscription_service

router = APIRouter()
logger = logging.getLogger(__name__)


# Subscription CRUD
@router.get("", response_model=SubscriptionListResponse)
def get_subscriptions(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    namespace: Optional[str] = Query(None, description="Filter by namespace"),
    scope: str = Query("all", description="Scope: personal, group, all"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get subscriptions for current user"""
    skip = (page - 1) * limit
    items, total = subscription_service.get_subscriptions(
        db=db,
        user_id=current_user.id,
        namespace=namespace,
        scope=scope,
        skip=skip,
        limit=limit,
    )
    return {"total": total, "items": items}


@router.post("", response_model=SubscriptionInDB)
def create_subscription(
    subscription_in: SubscriptionCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new subscription"""
    return subscription_service.create_subscription(
        db=db,
        obj_in=subscription_in,
        user_id=current_user.id,
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def get_unread_count(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get total unread count for all subscriptions"""
    return subscription_service.get_unread_count(db=db, user_id=current_user.id)


@router.get("/{subscription_id}", response_model=SubscriptionInDB)
def get_subscription(
    subscription_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get a subscription by ID"""
    subscription = subscription_service.get_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return subscription


@router.put("/{subscription_id}", response_model=SubscriptionInDB)
def update_subscription(
    subscription_id: int,
    subscription_in: SubscriptionUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update a subscription"""
    return subscription_service.update_subscription(
        db=db,
        subscription_id=subscription_id,
        obj_in=subscription_in,
        user_id=current_user.id,
    )


@router.delete("/{subscription_id}")
def delete_subscription(
    subscription_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a subscription"""
    subscription_service.delete_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )
    return {"message": "Subscription deleted successfully"}


@router.post("/{subscription_id}/enable", response_model=SubscriptionInDB)
def enable_subscription(
    subscription_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Enable a subscription"""
    return subscription_service.enable_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.post("/{subscription_id}/disable", response_model=SubscriptionInDB)
def disable_subscription(
    subscription_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Disable a subscription"""
    return subscription_service.disable_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.post("/{subscription_id}/run")
async def trigger_run(
    subscription_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Manually trigger a subscription run.

    This executes the subscription task asynchronously and saves the result
    to subscription_items for display in the feed page.
    """
    subscription = subscription_service.get_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")

    # Create a run record
    run = subscription_service.create_run(
        db=db,
        subscription_id=subscription_id,
    )

    logger.info(
        f"Subscription run triggered: subscription_id={subscription_id}, run_id={run.id}"
    )

    # Execute the subscription task in background
    background_tasks.add_task(
        _execute_subscription_task,
        subscription_id=subscription_id,
        run_id=run.id,
        user_id=current_user.id,
    )

    return {
        "message": "Run triggered successfully",
        "run_id": run.id,
        "subscription_id": subscription_id,
    }


async def _execute_subscription_task(
    subscription_id: int,
    run_id: int,
    user_id: int,
):
    """Background task to execute subscription."""
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        # Get subscription
        subscription = subscription_service.get_subscription(
            db=db,
            subscription_id=subscription_id,
            user_id=user_id,
        )
        if not subscription:
            logger.error(f"Subscription not found: {subscription_id}")
            return

        # Get run
        run = db.query(SubscriptionRun).filter(SubscriptionRun.id == run_id).first()
        if not run:
            logger.error(f"Run not found: {run_id}")
            return

        # Get user
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.error(f"User not found: {user_id}")
            return

        # Execute subscription
        result = await subscription_service.execute_subscription(
            db=db,
            subscription=subscription,
            run=run,
            user=user,
        )

        logger.info(f"Subscription execution completed: {result}")

    except Exception as e:
        logger.error(f"Failed to execute subscription task: {e}", exc_info=True)
    finally:
        db.close()


# Items endpoints
@router.get("/{subscription_id}/items", response_model=SubscriptionItemListResponse)
def get_items(
    subscription_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    is_read: Optional[bool] = Query(None, description="Filter by read status"),
    should_alert: Optional[bool] = Query(None, description="Filter by alert status"),
    search: Optional[str] = Query(None, description="Search in title/content"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get items for a subscription"""
    skip = (page - 1) * limit
    items, total = subscription_service.get_items(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
        is_read=is_read,
        should_alert=should_alert,
        search=search,
        skip=skip,
        limit=limit,
    )
    return {"total": total, "items": items}


@router.get("/{subscription_id}/items/{item_id}", response_model=SubscriptionItemInDB)
def get_item(
    subscription_id: int,
    item_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single item"""
    item = subscription_service.get_item(
        db=db,
        subscription_id=subscription_id,
        item_id=item_id,
        user_id=current_user.id,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.post(
    "/{subscription_id}/items/{item_id}/read", response_model=SubscriptionItemInDB
)
def mark_item_read(
    subscription_id: int,
    item_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Mark an item as read"""
    return subscription_service.mark_item_read(
        db=db,
        subscription_id=subscription_id,
        item_id=item_id,
        user_id=current_user.id,
    )


@router.post("/{subscription_id}/items/read-all")
def mark_all_read(
    subscription_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Mark all items as read"""
    count = subscription_service.mark_all_read(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )
    return {"message": f"Marked {count} items as read"}


# Runs endpoints
@router.get("/{subscription_id}/runs", response_model=SubscriptionRunListResponse)
def get_runs(
    subscription_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get run history for a subscription"""
    skip = (page - 1) * limit
    items, total = subscription_service.get_runs(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
    )
    return {"total": total, "items": items}


# Webhook endpoint (no auth required)
@router.post("/webhook/{subscription_id}", response_model=WebhookTriggerResponse)
def webhook_trigger(
    subscription_id: int,
    request: WebhookTriggerRequest,
    db: Session = Depends(get_db),
):
    """Webhook trigger endpoint for external systems"""
    subscription = subscription_service.validate_webhook(
        db=db,
        subscription_id=subscription_id,
        secret=request.secret,
    )

    if not subscription:
        raise HTTPException(status_code=403, detail="Invalid webhook request")

    # Create a run record
    run = subscription_service.create_run(
        db=db,
        subscription_id=subscription_id,
    )

    # TODO: Trigger actual task execution via executor_manager
    logger.info(
        f"Webhook triggered for subscription {subscription_id}, run_id={run.id}"
    )

    return WebhookTriggerResponse(
        success=True,
        message="Webhook triggered successfully",
        run_id=run.id,
    )
