# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenClaw token usage monitoring service.

This module provides functionality to monitor OpenClaw token usage
and send daily reports and threshold alerts.
"""

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

import httpx
from redis.asyncio import Redis

from app.core.config import settings
from wecode.service.dingtalk_webhook import DingTalkWebhookSender

logger = logging.getLogger(__name__)

# Redis key prefixes
REDIS_KEY_PREFIX = "openclaw_token_monitor:"
REDIS_LAST_REPORT_KEY = f"{REDIS_KEY_PREFIX}last_report_date"
REDIS_ALERTED_USERS_KEY_PREFIX = f"{REDIS_KEY_PREFIX}alerted_users:"

# Beijing timezone
BEIJING_TZ = timezone(timedelta(hours=8))


async def fetch_token_usage(
    start_ms: int, end_ms: int, limit: int = 100
) -> Dict[str, Any]:
    """
    Call OpenClaw stats API to get user token usage.

    Args:
        start_ms: Start timestamp in milliseconds since epoch
        end_ms: End timestamp in milliseconds since epoch
        limit: Max number of users to return

    Returns:
        API response dictionary with usage data
    """
    url = f"{settings.OPENCLAW_STATS_BASE_URL}/v1/stats/openclaw/usertokenuse"

    params = {
        "start": start_ms,
        "end": end_ms,
        "limit": limit,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            logger.debug(
                f"[openclaw-token] Fetched token usage: {len(data.get('result', []))} users"
            )
            return data
    except httpx.HTTPStatusError as e:
        logger.warning(f"[openclaw-token] HTTP error fetching token usage: {e}")
        raise
    except httpx.RequestError as e:
        logger.warning(f"[openclaw-token] Request error fetching token usage: {e}")
        raise
    except Exception as e:
        logger.warning(f"[openclaw-token] Unexpected error fetching token usage: {e}")
        raise


def _date_to_beijing_datetime(
    d: date, hour: int = 0, minute: int = 0, second: int = 0
) -> datetime:
    """Convert a date to Beijing timezone datetime."""
    return datetime(d.year, d.month, d.day, hour, minute, second, tzinfo=BEIJING_TZ)


def _datetime_to_ms(dt: datetime) -> int:
    """Convert datetime to milliseconds since epoch."""
    return int(dt.timestamp() * 1000)


async def get_daily_token_usage(target_date: date) -> Dict[str, Any]:
    """
    Get token usage for a specific date (00:00:00 to 23:59:59.999 Beijing time).

    Args:
        target_date: The date to query

    Returns:
        API response dictionary with usage data
    """
    start_dt = _date_to_beijing_datetime(target_date, 0, 0, 0)
    end_dt = _date_to_beijing_datetime(target_date, 23, 59, 59)
    # Add 999 milliseconds for inclusive end
    end_ms = _datetime_to_ms(end_dt) + 999

    start_ms = _datetime_to_ms(start_dt)

    return await fetch_token_usage(start_ms, end_ms, limit=1000)


async def get_today_token_usage() -> Dict[str, Any]:
    """
    Get today's token usage from 00:00:00 to now (Beijing time).

    Returns:
        API response dictionary with usage data
    """
    now = datetime.now(BEIJING_TZ)
    today = now.date()

    start_dt = _date_to_beijing_datetime(today, 0, 0, 0)
    start_ms = _datetime_to_ms(start_dt)
    end_ms = _datetime_to_ms(now)

    return await fetch_token_usage(start_ms, end_ms, limit=1000)


def format_number(num: int) -> str:
    """Format number with thousands separator."""
    return f"{num:,}"


def format_percentage(part: int, total: int) -> str:
    """Calculate and format percentage."""
    if total == 0:
        return "0.0%"
    return f"{(part / total) * 100:.1f}%"


async def send_daily_report(
    usage_data: Dict[str, Any],
    target_date: date,
    webhook: DingTalkWebhookSender,
) -> bool:
    """
    Format and send daily Top10 report to DingTalk.

    Args:
        usage_data: API response with token usage data
        target_date: The date of the report
        webhook: DingTalk webhook sender instance

    Returns:
        True if message was sent successfully
    """
    results = usage_data.get("result", [])
    total_summary_tokens = usage_data.get("total_summary_tokens", 0)
    top_n = settings.OPENCLAW_TOP_N_USERS

    # Sort by token usage descending
    sorted_results = sorted(
        results, key=lambda x: x.get("summary_tokens", 0), reverse=True
    )
    top_users = sorted_results[:top_n]

    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")
    date_str = target_date.strftime("%Y-%m-%d")

    sections = []
    sections.append(f"### 📊 OpenClaw Token Usage Daily Report ({date_str})")
    sections.append("")
    sections.append("**Summary**")
    sections.append(f"- Total Users: {len(results)}")
    sections.append(f"- Total Tokens: {format_number(total_summary_tokens)}")
    sections.append("")

    if top_users:
        sections.append(f"**Top {len(top_users)} Users**")
        sections.append("| Rank | User | Tokens | % of Total |")
        sections.append("|------|------|--------|------------|")

        for rank, user_data in enumerate(top_users, 1):
            user = user_data.get("user", "unknown")
            tokens = user_data.get("summary_tokens", 0)
            pct = format_percentage(tokens, total_summary_tokens)
            sections.append(f"| {rank} | {user} | {format_number(tokens)} | {pct} |")
    else:
        sections.append("**Top Users**")
        sections.append("_No usage data available_")

    sections.append("")
    sections.append(f"*Report generated at: {now}*")

    content = "\n".join(sections)
    return await webhook.send_markdown(
        title=f"【告警】OpenClaw Token 日报 ({date_str})",
        content=content,
    )


async def send_threshold_alert(
    user: str,
    tokens: int,
    threshold: int,
    rank: int,
    webhook: DingTalkWebhookSender,
) -> bool:
    """
    Send threshold exceeded alert for a specific user.

    Args:
        user: Username
        tokens: Current token usage
        threshold: Token threshold
        rank: User's current rank
        webhook: DingTalk webhook sender instance

    Returns:
        True if message was sent successfully
    """
    exceeded = tokens - threshold
    exceeded_pct = (exceeded / threshold) * 100

    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")

    sections = []
    sections.append("### ⚠️ OpenClaw Token Threshold Alert")
    sections.append("")
    sections.append("**User Exceeded Daily Limit**")
    sections.append(f"- User: `{user}`")
    sections.append(f"- Today's Usage: {format_number(tokens)} tokens")
    sections.append(f"- Threshold: {format_number(threshold)} tokens")
    sections.append(
        f"- Exceeded By: {format_number(exceeded)} tokens ({exceeded_pct:.1f}%)"
    )
    sections.append("")
    sections.append(f"**Current Rank: #{rank}**")
    sections.append("")
    sections.append(f"*Alert time: {now}*")

    content = "\n".join(sections)
    return await webhook.send_markdown(
        title=f"【告警】OpenClaw Token 阈值告警 - {user}",
        content=content,
    )


async def send_threshold_alert_batch(
    users: List[Dict[str, Any]],
    threshold: int,
    webhook: DingTalkWebhookSender,
) -> bool:
    """
    Send a batch threshold alert for multiple users exceeding the threshold.

    Args:
        users: List of user data dicts with 'user', 'tokens', 'rank' keys
        threshold: Token threshold
        webhook: DingTalk webhook sender instance

    Returns:
        True if message was sent successfully
    """
    if not users:
        return False

    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")

    sections = []
    sections.append(f"### ⚠️ 【告警】OpenClaw Token 阈值告警")
    sections.append("")
    sections.append(f"**以下用户超过日阈值 ({format_number(threshold)} tokens):**")
    sections.append("")

    # Build markdown table
    sections.append("| Rank | User | Usage | Exceeded |")
    sections.append("|------|------|-------|----------|")

    for user_data in users:
        user = user_data.get("user", "unknown")
        tokens = user_data.get("tokens", 0)
        rank = user_data.get("rank", 0)
        exceeded = tokens - threshold

        sections.append(
            f"| {rank} | {user} | {format_number(tokens)} | {format_number(exceeded)} |"
        )

    sections.append("")
    sections.append(f"*共 {len(users)} 个用户超过阈值*")
    sections.append(f"*Alert time: {now}*")

    content = "\n".join(sections)
    return await webhook.send_markdown(
        title=f"【告警】OpenClaw Token 阈值告警 - {len(users)} 个用户",
        content=content,
    )


async def get_last_report_date(redis_client: Redis) -> Optional[date]:
    """Get the last report date from Redis."""
    try:
        data = await redis_client.get(REDIS_LAST_REPORT_KEY)
        if data:
            return date.fromisoformat(data)
    except Exception as e:
        logger.warning(f"[openclaw-token] Error reading last report date: {e}")
    return None


async def set_last_report_date(redis_client: Redis, report_date: date) -> None:
    """Set the last report date in Redis."""
    try:
        await redis_client.set(REDIS_LAST_REPORT_KEY, report_date.isoformat())
    except Exception as e:
        logger.warning(f"[openclaw-token] Error saving last report date: {e}")


async def get_alerted_users(redis_client: Redis, target_date: date) -> Set[str]:
    """Get set of users already alerted today."""
    key = f"{REDIS_ALERTED_USERS_KEY_PREFIX}{target_date.isoformat()}"
    try:
        data = await redis_client.smembers(key)
        if data:
            return set(data)
    except Exception as e:
        logger.warning(f"[openclaw-token] Error reading alerted users: {e}")
    return set()


async def add_alerted_user(redis_client: Redis, target_date: date, user: str) -> None:
    """Add a user to the alerted set for today."""
    key = f"{REDIS_ALERTED_USERS_KEY_PREFIX}{target_date.isoformat()}"
    try:
        await redis_client.sadd(key, user)
        # Set expiry to 2 days to auto-cleanup old data
        await redis_client.expire(key, 172800)
    except Exception as e:
        logger.warning(f"[openclaw-token] Error adding alerted user: {e}")


async def check_and_send_daily_report(
    redis_client: Redis,
    webhook: DingTalkWebhookSender,
) -> bool:
    """
    Check if daily report should be sent and send if needed.

    Sends report for the previous day at 9 AM.

    Args:
        redis_client: Redis client
        webhook: DingTalk webhook sender

    Returns:
        True if report was sent
    """
    now = datetime.now(BEIJING_TZ)
    today = now.date()

    # Report for yesterday
    yesterday = today - timedelta(days=1)

    # Check if we already sent report for yesterday
    last_report = await get_last_report_date(redis_client)
    if last_report == yesterday:
        logger.debug(f"[openclaw-token] Daily report for {yesterday} already sent")
        return False

    try:
        usage_data = await get_daily_token_usage(yesterday)

        success = await send_daily_report(usage_data, yesterday, webhook)
        if success:
            await set_last_report_date(redis_client, yesterday)
            logger.info(f"[openclaw-token] Daily report sent for {yesterday}")
            return True
        else:
            logger.error(
                f"[openclaw-token] Failed to send daily report for {yesterday}"
            )
            return False

    except Exception as e:
        logger.error(f"[openclaw-token] Error generating daily report: {e}")
        return False


async def check_threshold_alerts(
    redis_client: Redis,
    webhook: DingTalkWebhookSender,
) -> bool:
    """
    Check for users exceeding threshold and send batch alert.

    Collects all users exceeding threshold and sends a single
    batch message instead of individual alerts for each user.

    Args:
        redis_client: Redis client
        webhook: DingTalk webhook sender

    Returns:
        True if alert was sent successfully
    """
    threshold = settings.OPENCLAW_TOKEN_DAILY_THRESHOLD
    now = datetime.now(BEIJING_TZ)
    today = now.date()

    try:
        usage_data = await get_today_token_usage()
        results = usage_data.get("result", [])

        if not results:
            logger.debug("[openclaw-token] No usage data for threshold check")
            return False

        # Sort by token usage for ranking
        sorted_results = sorted(
            results, key=lambda x: x.get("summary_tokens", 0), reverse=True
        )

        # Build rank lookup
        rank_lookup = {}
        for rank, user_data in enumerate(sorted_results, 1):
            user = user_data.get("user", "unknown")
            rank_lookup[user] = rank

        # Get already alerted users
        alerted_users = await get_alerted_users(redis_client, today)

        # Collect all users exceeding threshold that haven't been alerted
        exceeded_users = []
        for user_data in results:
            user = user_data.get("user", "unknown")
            tokens = user_data.get("summary_tokens", 0)

            # Skip if already alerted today
            if user in alerted_users:
                continue

            # Check threshold
            if tokens >= threshold:
                rank = rank_lookup.get(user, 0)
                exceeded_users.append({
                    "user": user,
                    "tokens": tokens,
                    "rank": rank,
                })

        # If there are exceeded users, send a single batch alert
        if exceeded_users:
            # Sort by rank for consistent presentation
            exceeded_users.sort(key=lambda x: x["rank"])

            success = await send_threshold_alert_batch(
                exceeded_users, threshold, webhook
            )
            if success:
                # Add all notified users to alerted set
                for user_data in exceeded_users:
                    await add_alerted_user(redis_client, today, user_data["user"])
                logger.info(
                    f"[openclaw-token] Batch threshold alert sent for "
                    f"{len(exceeded_users)} users (threshold: {format_number(threshold)} tokens)"
                )
                return True
            else:
                logger.error(
                    f"[openclaw-token] Failed to send batch threshold alert "
                    f"for {len(exceeded_users)} users"
                )
                return False

        return False

    except Exception as e:
        logger.error(f"[openclaw-token] Error checking threshold alerts: {e}")
        return False
