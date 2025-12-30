# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unread message notification service for group chats.

This service handles hourly Dingtalk notifications for unread messages.
Reads from Redis and sends notifications.

Redis data structure for unread counts (managed by other service):
- Key: unread:{YYYYMMDD} (shared by all users, separated by day)
- Type: Hash
- Field: {uid}
- Value: JSON string {task_id: {hour: count}}
- TTL: 7 days

Example:
  Key: unread:20251230
  Hash:
    - 123 -> {"456": {"14": 5, "15": 3}, "789": {"14": 2}}
      (User 123 has 5 unread at 14:00, 3 at 15:00 in task 456, 2 at 14:00 in task 789)
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import orjson
from redis.asyncio import Redis
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.task import TaskResource
from app.models.user import User
from app.services.notification.dingtalk import DingtalkClient

logger = logging.getLogger(__name__)

# Redis key pattern
UNREAD_KEY_PREFIX = "unread:"


class UnreadNotificationService:
    """
    Service for handling unread message notifications.
    Only reads from Redis and sends Dingtalk notifications.
    """

    def __init__(self, redis_url: str):
        self.redis_url = redis_url

    async def _get_redis_client(self) -> Redis:
        """Get a Redis client."""
        return Redis.from_url(
            self.redis_url,
            encoding="utf-8",
            decode_responses=False,
        )

    def _get_unread_key(self, date: datetime) -> str:
        """Get the Redis key for unread counts on a specific date."""
        return f"{UNREAD_KEY_PREFIX}{date.strftime('%Y%m%d')}"

    async def get_hourly_unread(
        self, user_id: int, hour: int, date: Optional[datetime] = None
    ) -> Dict[int, int]:
        """
        Get unread message counts for a specific hour.

        Args:
            user_id: The user's ID
            hour: The hour (0-23)
            date: The date (default: today)

        Returns:
            Dict mapping task_id to unread count for that hour
        """
        client = await self._get_redis_client()
        try:
            if date is None:
                date = datetime.now()
            key = self._get_unread_key(date)

            raw_data = await client.hget(key, str(user_id))
            if not raw_data:
                return {}

            try:
                user_data = orjson.loads(raw_data)
            except Exception:
                return {}

            # user_data format: {task_id: {hour: count}}
            result = {}
            hour_str = str(hour)
            for task_id_str, hour_counts in user_data.items():
                if isinstance(hour_counts, dict) and hour_str in hour_counts:
                    count = hour_counts[hour_str]
                    if count > 0:
                        result[int(task_id_str)] = count
            return result
        finally:
            await client.aclose()

    async def get_daily_unread(
        self, user_id: int, date: Optional[datetime] = None
    ) -> Dict[int, int]:
        """
        Get total unread message counts for a day.

        Args:
            user_id: The user's ID
            date: The date (default: today)

        Returns:
            Dict mapping task_id to total unread count for the day
        """
        client = await self._get_redis_client()
        try:
            if date is None:
                date = datetime.now()
            key = self._get_unread_key(date)

            raw_data = await client.hget(key, str(user_id))
            if not raw_data:
                return {}

            try:
                user_data = orjson.loads(raw_data)
            except Exception:
                return {}

            # user_data format: {task_id: {hour: count}}
            result = {}
            for task_id_str, hour_counts in user_data.items():
                if isinstance(hour_counts, dict):
                    total = sum(hour_counts.values())
                    if total > 0:
                        result[int(task_id_str)] = total
            return result
        finally:
            await client.aclose()

    async def get_all_users_with_unread(
        self, date: Optional[datetime] = None
    ) -> List[int]:
        """
        Get all user IDs that have unread messages on a specific date.

        Args:
            date: The date (default: today)

        Returns:
            List of user IDs with unread messages
        """
        client = await self._get_redis_client()
        try:
            if date is None:
                date = datetime.now()
            key = self._get_unread_key(date)

            fields = await client.hkeys(key)
            return [int(f.decode() if isinstance(f, bytes) else f) for f in fields]
        finally:
            await client.aclose()

    def _get_task_titles(self, db: Session, task_ids: List[int]) -> Dict[int, str]:
        """
        Get task titles for a list of task IDs.

        Args:
            db: Database session
            task_ids: List of task IDs

        Returns:
            Dict mapping task_id to title
        """
        if not task_ids:
            return {}

        tasks = db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()

        result = {}
        for task in tasks:
            # Get title from task.json.spec.title or task.name
            title = task.json.get("spec", {}).get("title", "") or task.name
            result[task.id] = title or f"群聊 {task.id}"
        return result

    def _get_user_info(self, db: Session, user_id: int) -> Optional[Tuple[str, str]]:
        """
        Get user info (username, email) for a user ID.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Tuple of (username, email) or None if not found
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return None
        email = user.email or f"{user.user_name}@staff.weibo.com"
        return (user.user_name, email)

    async def send_hourly_dingtalk_notifications(self, db: Session) -> int:
        """
        Send Dingtalk notifications for the previous hour's unread messages.

        This should be called at the beginning of each hour (e.g., at 14:00
        to notify about messages from 13:00-13:59).

        Args:
            db: Database session

        Returns:
            Number of notifications sent
        """
        now = datetime.now()
        # Get the previous hour
        prev_hour = (now.hour - 1) % 24
        # If it's 0:00 now, we need to check yesterday's data for hour 23
        if now.hour == 0:
            check_date = now - timedelta(days=1)
        else:
            check_date = now

        logger.info(
            f"[UnreadNotification] Checking hourly unread for hour {prev_hour} on {check_date.strftime('%Y-%m-%d')}"
        )

        # Get all users with unread messages
        user_ids = await self.get_all_users_with_unread(check_date)
        if not user_ids:
            logger.info("[UnreadNotification] No users with unread messages")
            return 0

        notifications_sent = 0
        async with DingtalkClient() as dingtalk:
            for user_id in user_ids:
                try:
                    # Get user info
                    user_info = self._get_user_info(db, user_id)
                    if not user_info:
                        logger.warning(
                            f"[UnreadNotification] User {user_id} not found, skipping"
                        )
                        continue

                    username, email = user_info

                    # Get unread counts for the previous hour
                    hourly_unread = await self.get_hourly_unread(
                        user_id, prev_hour, check_date
                    )
                    if not hourly_unread:
                        continue

                    # Get task titles
                    task_titles = self._get_task_titles(db, list(hourly_unread.keys()))

                    # Build notification message
                    total_count = sum(hourly_unread.values())
                    group_names = [
                        task_titles.get(tid, f"群聊{tid}")
                        for tid in hourly_unread.keys()
                    ]

                    # Build Dingtalk markdown message
                    title = f"Wegent 新消息提醒"
                    group_list = "、".join(group_names[:5])
                    if len(group_names) > 5:
                        group_list += f" 等{len(group_names)}个群"

                    frontend_url = settings.FRONTEND_URL
                    content = f"""### Wegent 新消息提醒

您所在的 **{group_list}** 群里收到了 **{total_count}** 条消息

[点击查看详情]({frontend_url})"""

                    # Send notification
                    success = await dingtalk.send_markdown(
                        username=email,
                        title=title,
                        content=content,
                    )

                    if success:
                        notifications_sent += 1
                        logger.info(
                            f"[UnreadNotification] Sent hourly notification to {username}"
                        )
                except Exception as e:
                    logger.error(
                        f"[UnreadNotification] Error sending notification to user {user_id}: {e}"
                    )

        logger.info(
            f"[UnreadNotification] Hourly notification complete, sent {notifications_sent} notifications"
        )
        return notifications_sent


# Global service instance
_unread_notification_service: Optional[UnreadNotificationService] = None


def get_unread_notification_service() -> UnreadNotificationService:
    """Get the global unread notification service instance."""
    global _unread_notification_service
    if _unread_notification_service is None:
        _unread_notification_service = UnreadNotificationService(settings.REDIS_URL)
    return _unread_notification_service
