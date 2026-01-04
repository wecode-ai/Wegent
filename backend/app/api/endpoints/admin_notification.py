# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Admin endpoints for notification debugging and manual triggering.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import get_admin_user
from app.models.user import User

router = APIRouter()


@router.post("/trigger-hourly")
async def trigger_hourly_notification(
    hour: Optional[int] = Query(
        None, ge=0, le=23, description="Hour to check (0-23), defaults to previous hour"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Manually trigger hourly Dingtalk notification (admin only).

    This is for debugging purposes. By default checks the previous hour.
    """
    from app.services.notification.unread_notification import (
        get_unread_notification_service,
    )

    if not settings.HOURLY_DINGTALK_NOTIFICATION_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hourly Dingtalk notification is disabled. Set HOURLY_DINGTALK_NOTIFICATION_ENABLED=True in config.",
        )

    notification_service = get_unread_notification_service()
    now = datetime.now()

    # Determine which hour to check
    if hour is not None:
        check_hour = hour
        # If checking hour 23 and current hour is 0-22, use yesterday's date
        if hour == 23 and now.hour < 23:
            check_date = now - timedelta(days=1)
        else:
            check_date = now
    else:
        # Default: previous hour
        check_hour = (now.hour - 1) % 24
        if now.hour == 0:
            check_date = now - timedelta(days=1)
        else:
            check_date = now

    # Get all users with unread messages
    user_ids = await notification_service.get_all_users_with_unread(check_date)

    # Send notifications
    count = await notification_service.send_hourly_dingtalk_notifications(db)

    return {
        "message": f"Hourly notification triggered for hour {check_hour}",
        "date": check_date.strftime("%Y-%m-%d"),
        "hour": check_hour,
        "users_with_unread": len(user_ids),
        "notifications_sent": count,
    }


@router.post("/trigger-daily")
async def trigger_daily_notification(
    hour: Optional[int] = Query(
        None,
        ge=0,
        le=23,
        description="Simulate trigger hour (9 or 18), affects hours_back calculation",
    ),
    task_id: Optional[int] = Query(
        None, description="Specific group chat task ID to send summary for"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Manually trigger daily group chat summary email (admin only).

    This is for debugging purposes. Sends summary of group chat activity.

    - hour=9: Simulates morning run, looks back 15 hours (previous 18:00 to 9:00)
    - hour=18: Simulates evening run, looks back 9 hours (9:00 to 18:00)
    - hour=None: Uses default 12 hours
    - task_id: If specified, only send summary for this specific group chat
    """
    from app.services.notification.group_chat_summary import (
        get_group_chat_summary_service,
    )

    if not settings.DAILY_EMAIL_SUMMARY_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Daily email summary is disabled. Set DAILY_EMAIL_SUMMARY_ENABLED=True in config.",
        )

    summary_service = get_group_chat_summary_service()
    today = datetime.now()

    # Calculate hours_back based on simulated hour
    if hour is not None:
        morning_hour = settings.MORNING_SUMMARY_HOUR  # default 9
        evening_hour = settings.DAILY_SUMMARY_HOUR  # default 18
        if hour == morning_hour:
            hours_back = 15  # 18:00 yesterday to 9:00 today
        elif hour == evening_hour:
            hours_back = 9  # 9:00 to 18:00 today
        else:
            # For other hours, calculate based on proximity
            hours_back = 12  # default
    else:
        hours_back = 12  # default

    # Send group chat summary email
    count = await summary_service.send_daily_summary(
        db, hours_back=hours_back, task_id=task_id
    )

    return {
        "message": "Daily group chat summary triggered",
        "date": today.strftime("%Y-%m-%d"),
        "simulated_hour": hour,
        "hours_back": hours_back,
        "task_id": task_id,
        "emails_sent": count,
    }
