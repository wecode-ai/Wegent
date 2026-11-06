# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read-only subscription MCP tools."""

import json
import logging
from typing import Literal, Optional

from fastapi import HTTPException

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.mcp_server.tools.subscription_common import serialize_subscription
from app.schemas.subscription import SubscriptionTriggerType
from app.services.subscription import subscription_service

logger = logging.getLogger(__name__)


@mcp_tool(
    name="list_subscriptions",
    description=(
        "List the current user's active subscriptions with their real-time state. "
        "Use this whenever the user asks what subscriptions exist, whether a "
        "subscription still exists or is enabled, or before advising about an "
        "existing subscription. Results exclude rental subscriptions. Never infer "
        "current subscription state from an earlier create_subscription response."
    ),
    server="subscription",
    exclude_params=["token_info"],
    param_descriptions={
        "enabled": "Optional filter for enabled or disabled subscriptions",
        "trigger_type": "Optional trigger type filter: cron, interval, one_time, or event",
        "offset": "Pagination offset (default: 0)",
        "limit": "Maximum number of subscriptions to return (1-100, default: 20)",
    },
)
def list_subscriptions(
    token_info: TaskTokenInfo,
    enabled: Optional[bool] = None,
    trigger_type: Optional[Literal["cron", "interval", "one_time", "event"]] = None,
    offset: int = 0,
    limit: int = 20,
) -> str:
    """List active non-rental subscriptions owned by the current user.

    Args:
        token_info: Task token info (auto-injected from MCP context)
        enabled: Optional enabled-state filter
        trigger_type: Optional trigger type filter
        offset: Pagination offset
        limit: Maximum number of items to return

    Returns:
        JSON string with the current subscription state and pagination metadata
    """
    if offset < 0:
        return json.dumps(
            {"success": False, "error": "offset must be greater than or equal to 0"},
            ensure_ascii=False,
        )
    if limit < 1 or limit > 100:
        return json.dumps(
            {"success": False, "error": "limit must be between 1 and 100"},
            ensure_ascii=False,
        )

    trigger_filter = None
    if trigger_type is not None:
        try:
            trigger_filter = SubscriptionTriggerType(trigger_type)
        except ValueError:
            return json.dumps(
                {
                    "success": False,
                    "error": f"Invalid trigger_type: {trigger_type}",
                },
                ensure_ascii=False,
            )

    logger.info(
        f"[MCP:Subscription] list_subscriptions called by user {token_info.user_id}, "
        f"enabled={enabled}, trigger_type={trigger_type}, offset={offset}, limit={limit}"
    )

    db = SessionLocal()
    try:
        items, total, invalid_schedule_count = subscription_service.list_subscriptions(
            db,
            user_id=token_info.user_id,
            skip=offset,
            limit=limit,
            enabled=enabled,
            trigger_type=trigger_filter,
        )
        serialized_items = [serialize_subscription(item) for item in items]
        return json.dumps(
            {
                "success": True,
                "total": total,
                "offset": offset,
                "limit": limit,
                "returned": len(serialized_items),
                "invalid_schedule_count": invalid_schedule_count,
                "items": serialized_items,
            },
            ensure_ascii=False,
            default=str,
        )
    except Exception as e:
        logger.error(
            f"[MCP:Subscription] Failed to list subscriptions: {e}", exc_info=True
        )
        return json.dumps(
            {
                "success": False,
                "error": f"Failed to list subscriptions: {str(e)}",
            },
            ensure_ascii=False,
        )
    finally:
        db.close()


@mcp_tool(
    name="get_subscription",
    description=(
        "Get one subscription by ID with its current real-time state, including "
        "enabled, next execution time, last execution result, and execution counts. "
        "Use this to verify a subscription after creation or before answering "
        "whether it will run. Deleted or inaccessible subscriptions are not found. "
        "This tool cannot enable, disable, or delete a subscription."
    ),
    server="subscription",
    exclude_params=["token_info"],
    param_descriptions={
        "subscription_id": "Subscription ID to retrieve",
    },
)
def get_subscription(
    token_info: TaskTokenInfo,
    subscription_id: int,
) -> str:
    """Get the current state of one subscription owned by the current user.

    Args:
        token_info: Task token info (auto-injected from MCP context)
        subscription_id: Subscription ID to retrieve

    Returns:
        JSON string with the subscription's current state
    """
    logger.info(
        f"[MCP:Subscription] get_subscription called by user {token_info.user_id}, "
        f"subscription_id={subscription_id}"
    )

    db = SessionLocal()
    try:
        subscription = subscription_service.get_subscription(
            db,
            subscription_id=subscription_id,
            user_id=token_info.user_id,
        )
        return json.dumps(
            {
                "success": True,
                "subscription": serialize_subscription(
                    subscription, include_details=True
                ),
            },
            ensure_ascii=False,
            default=str,
        )
    except HTTPException as e:
        if e.status_code == 404:
            return json.dumps(
                {
                    "success": False,
                    "error": (
                        "Subscription not found, deleted, or not accessible "
                        "to the current user"
                    ),
                },
                ensure_ascii=False,
            )
        logger.error(
            f"[MCP:Subscription] Failed to get subscription: {e.detail}",
            exc_info=True,
        )
        return json.dumps(
            {
                "success": False,
                "error": f"Failed to get subscription: {e.detail}",
            },
            ensure_ascii=False,
        )
    except Exception as e:
        logger.error(
            f"[MCP:Subscription] Failed to get subscription: {e}", exc_info=True
        )
        return json.dumps(
            {
                "success": False,
                "error": f"Failed to get subscription: {str(e)}",
            },
            ensure_ascii=False,
        )
    finally:
        db.close()
