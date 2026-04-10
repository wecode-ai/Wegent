# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Subscription MCP tools for managing scheduled tasks.

This module provides MCP tools for subscription management:
- preview_subscription: Preview subscription configuration before creating
- create_subscription: Create a subscription task after preview

These tools are registered with the subscription MCP server and allow
AI agents to create scheduled/periodic tasks via MCP protocol.
"""

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Literal, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionTaskType,
    SubscriptionTriggerType,
)
from app.services.subscription import subscription_service

logger = logging.getLogger(__name__)

# Preview storage key prefix
PREVIEW_KEY_PREFIX = "subscription:preview:"
PREVIEW_TTL_SECONDS = 86400  # 24 hours


async def _send_subscription_preview_block(
    task_id: int,
    subtask_id: int,
    preview_data: dict,
) -> None:
    """Send subscription preview block to frontend via WebSocket.

    Creates a new independent block (type: subscription_preview) using
    session_manager.add_block() and emit_block_created, similar to video/image blocks.

    Args:
        task_id: Task ID for WebSocket room targeting
        subtask_id: Subtask ID for context
        preview_data: The preview data to send to frontend
    """
    logger.info(
        f"[SubscriptionMCP] _send_subscription_preview_block called: task_id={task_id}, subtask_id={subtask_id}"
    )
    try:
        from app.services.chat.storage.session import session_manager
        from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
        from shared.models.blocks import BlockStatus

        # Create independent block (not attached to tool block)
        block = {
            "id": preview_data.get("preview_id", f"sub_{uuid.uuid4().hex[:8]}"),
            "type": "subscription_preview",
            "status": BlockStatus.PENDING.value,
            "preview_id": preview_data.get("preview_id"),
            "execution_id": preview_data.get("execution_id"),
            "task_id": preview_data.get("task_id"),
            "subtask_id": preview_data.get("subtask_id"),
            "config": preview_data.get("config"),
            "created_at": preview_data.get("created_at"),
            "timestamp": int(datetime.now().timestamp() * 1000),
        }
        logger.info(f"[SubscriptionMCP] Created block: {block}")

        # Add block to session manager (persists to Redis)
        await session_manager.add_block(subtask_id, block)
        logger.info(f"[SubscriptionMCP] Added block to session_manager")

        # Send WebSocket event to notify frontend
        ws_emitter = get_webpage_ws_emitter()
        if ws_emitter:
            await ws_emitter.emit_block_created(
                task_id=task_id,
                subtask_id=subtask_id,
                block=block,
            )
            logger.info(
                f"[SubscriptionMCP] Sent subscription_preview block via WebSocket: task_id={task_id}, "
                f"subtask_id={subtask_id}, preview_id={preview_data.get('preview_id')}"
            )
        else:
            logger.warning(
                "[SubscriptionMCP] WebSocket emitter not available, block persisted but not notified"
            )
    except Exception as e:
        logger.error(
            f"[SubscriptionMCP] Failed to send block: {e}",
            exc_info=True,
        )


def _get_task_info(db: SessionLocal, task_id: int) -> Optional[dict]:
    """Get task and team info from database.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        Dict with team_id (int), team_namespace, model_name, model_namespace or None
    """
    try:
        from app.models.kind import Kind
        from app.models.task import TaskResource

        task = db.query(TaskResource).filter(TaskResource.id == task_id).first()
        if not task:
            return None

        # Get team reference from task
        team_name = task.json.get("spec", {}).get("teamRef", {}).get("name")
        team_namespace = (
            task.json.get("spec", {}).get("teamRef", {}).get("namespace", "default")
        )

        # Get team Kind to retrieve actual team_id (integer)
        team_id = None
        model_name = None
        model_namespace = "default"
        if team_name:
            team = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Team",
                    Kind.name == team_name,
                    Kind.namespace == team_namespace,
                )
                .first()
            )
            if team:
                team_id = team.id  # Get the integer ID
                model_ref = team.json.get("spec", {}).get("modelRef", {})
                model_name = model_ref.get("name")
                model_namespace = model_ref.get("namespace", "default")

        return {
            "team_id": team_id,
            "team_namespace": team_namespace,
            "model_name": model_name,
            "model_namespace": model_namespace,
        }
    except Exception as e:
        logger.warning(f"[SubscriptionMCP] Failed to get task info: {e}")
        return None


def _store_preview_data(preview_id: str, data: dict) -> bool:
    """Store preview data in Redis with TTL.

    Args:
        preview_id: The preview ID
        data: Preview data dict

    Returns:
        True if stored successfully
    """
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        key = f"{PREVIEW_KEY_PREFIX}{preview_id}"
        client.setex(key, PREVIEW_TTL_SECONDS, json.dumps(data))
        logger.debug(f"[SubscriptionMCP] Stored preview {preview_id}")
        return True
    except Exception as e:
        logger.error(f"[SubscriptionMCP] Failed to store preview: {e}")
        return False


def _get_preview_data(preview_id: str) -> Optional[dict]:
    """Retrieve preview data from Redis.

    Args:
        preview_id: The preview ID

    Returns:
        Preview data dict if found, None otherwise
    """
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        key = f"{PREVIEW_KEY_PREFIX}{preview_id}"
        data = client.get(key)
        if data:
            return json.loads(data)
        return None
    except Exception as e:
        logger.error(f"[SubscriptionMCP] Failed to get preview: {e}")
        return None


def _clear_preview_data(preview_id: str) -> None:
    """Clear preview data from Redis.

    Args:
        preview_id: The preview ID to clear
    """
    try:
        import redis

        from app.core.config import settings

        client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        key = f"{PREVIEW_KEY_PREFIX}{preview_id}"
        client.delete(key)
        logger.debug(f"[SubscriptionMCP] Cleared preview {preview_id}")
    except Exception as e:
        logger.error(f"[SubscriptionMCP] Failed to clear preview: {e}")


def _validate_trigger_config(
    trigger_type: str,
    cron_expression: Optional[str],
    interval_value: Optional[int],
    interval_unit: Optional[str],
    execute_at: Optional[str],
) -> Optional[str]:
    """Validate trigger configuration based on trigger type.

    Returns:
        Error message string if validation fails, None if valid
    """
    if trigger_type == "cron":
        if not cron_expression:
            return "cron_expression is required for cron trigger type"
        parts = cron_expression.split()
        if len(parts) != 5:
            return f"Invalid cron expression: expected 5 parts, got {len(parts)}"

    elif trigger_type == "interval":
        if interval_value is None:
            return "interval_value is required for interval trigger type"
        if not interval_unit:
            return "interval_unit is required for interval trigger type"
        if interval_value <= 0:
            return "interval_value must be positive"

    elif trigger_type == "one_time":
        if not execute_at:
            return "execute_at is required for one_time trigger type"
        try:
            datetime.fromisoformat(execute_at.replace("Z", "+00:00"))
        except ValueError as e:
            return f"Invalid execute_at format: {e}"

    return None


def _build_trigger_config(
    trigger_type: str,
    timezone: str,
    cron_expression: Optional[str] = None,
    interval_value: Optional[int] = None,
    interval_unit: Optional[str] = None,
    execute_at: Optional[str] = None,
) -> dict[str, Any]:
    """Build trigger configuration dict based on trigger type."""
    if trigger_type == "cron":
        return {
            "expression": cron_expression,
            "timezone": timezone,
        }
    elif trigger_type == "interval":
        return {
            "value": interval_value,
            "unit": interval_unit,
        }
    elif trigger_type == "one_time":
        return {
            "execute_at": execute_at,
            "timezone": timezone,
        }
    return {}


def _format_trigger_description(
    trigger_type: str, trigger_config: dict[str, Any]
) -> str:
    """Format a human-readable trigger description."""
    if trigger_type == "cron":
        expr = trigger_config.get("expression", "")
        tz = trigger_config.get("timezone", "UTC")
        return f"Cron表达式: `{expr}` (时区: {tz})"
    elif trigger_type == "interval":
        value = trigger_config.get("value", 0)
        unit = trigger_config.get("unit", "")
        unit_zh = {"minutes": "分钟", "hours": "小时", "days": "天"}.get(unit, unit)
        return f"每 {value} {unit_zh}执行"
    elif trigger_type == "one_time":
        execute_at = trigger_config.get("execute_at", "")
        tz = trigger_config.get("timezone", "UTC")
        return f"一次性执行于 {execute_at} (时区: {tz})"
    return ""


def _generate_unique_name(display_name: str) -> str:
    """Generate a unique subscription name based on display name."""
    suffix = uuid.uuid4().hex[:8]
    base_name = (
        display_name.lower()
        .replace(" ", "-")
        .replace("_", "-")
        .encode("ascii", "ignore")
        .decode()
    )
    base_name = "".join(c for c in base_name if c.isalnum() or c == "-")
    base_name = base_name[:50] if base_name else "subscription"
    return f"sub-{base_name}-{suffix}"


def _format_preview_table(
    display_name: str,
    description: Optional[str],
    trigger_type: str,
    trigger_config: dict[str, Any],
    prompt_template: str,
    preserve_history: bool,
    history_message_count: int,
    retry_count: int,
    timeout_seconds: int,
    expires_at: Optional[str] = None,
) -> str:
    """Format a markdown preview table."""
    trigger_desc = _format_trigger_description(trigger_type, trigger_config)

    prompt_display = prompt_template
    if len(prompt_display) > 100:
        prompt_display = prompt_display[:97] + "..."
    prompt_display = prompt_display.replace("|", "\\|")

    expiration_desc = "无"
    if expires_at:
        expiration_desc = expires_at.replace("T", " ")

    lines = [
        "### 订阅任务预览",
        "",
        "| 配置项 | 值 |",
        "|--------|-----|",
        f"| **任务名称** | {display_name} |",
        f"| **触发方式** | {trigger_desc} |",
        f"| **保留历史** | {'是' if preserve_history else '否'} ({history_message_count} 条) |",
        f"| **重试次数** | {retry_count} |",
        f"| **超时时间** | {timeout_seconds} 秒 |",
        f"| **过期时间** | {expiration_desc} |",
    ]

    if description:
        desc_display = description.replace("|", "\\|")
        lines.append(f"| **描述** | {desc_display} |")

    lines.extend(
        [
            f"| **执行提示** | {prompt_display} |",
            "",
            "请确认以上配置是否正确？",
            "- 回复 **「执行」** 或 **「确认」** 创建任务",
            "- 回复 **「取消」** 放弃创建",
            "- 或告诉我需要修改的内容",
        ]
    )

    return "\n".join(lines)


@mcp_tool(
    name="preview_subscription",
    description=(
        "Preview a subscription plan WITHOUT creating it. "
        "Use this tool FIRST when user wants to schedule recurring/periodic tasks. "
        "The frontend will display an interactive preview card with Confirm/Cancel buttons.\n\n"
        "Workflow:\n"
        "1. User: 'remind me every morning' / '每天早上9点提醒我喝水'\n"
        "2. AI: Call preview_subscription tool to generate preview\n"
        "3. System: Displays interactive preview card with Confirm/Cancel buttons\n"
        "4. User confirmation (either one):\n"
        "   - Clicks 'Confirm' button: Frontend creates automatically, AI does NOTHING more\n"
        "   - Sends '确认' message: AI must call create_subscription to create the subscription\n\n"
        "CRITICAL: After calling preview_subscription, wait for user confirmation. NEVER auto-create."
    ),
    server="subscription",
    exclude_params=["token_info"],
    param_descriptions={
        "display_name": "Display name for the subscription task",
        "description": "Optional description of the subscription task",
        "trigger_type": "Trigger type: cron, interval, or one_time",
        "cron_expression": "Cron expression (e.g., '0 9 * * *' for daily at 9am)",
        "interval_value": "Interval value (for interval trigger)",
        "interval_unit": "Interval unit: minutes, hours, or days",
        "execute_at": "Execution time in ISO format (for one_time trigger)",
        "prompt_template": "Prompt template for execution with variable support",
        "preserve_history": "Whether to preserve conversation history",
        "history_message_count": "Number of history messages to preserve (0-50)",
        "retry_count": "Retry count on failure (0-3)",
        "timeout_seconds": "Execution timeout in seconds (60-3600)",
        "expiration_type": "Expiration type: fixed_date or duration_days",
        "expiration_fixed_date": "Fixed expiration date in ISO format",
        "expiration_duration_days": "Days until expiration (1-3650)",
    },
)
async def preview_subscription(
    token_info: TaskTokenInfo,
    display_name: str,
    trigger_type: Literal["cron", "interval", "one_time"],
    prompt_template: str,
    description: Optional[str] = None,
    cron_expression: Optional[str] = None,
    interval_value: Optional[int] = None,
    interval_unit: Optional[Literal["minutes", "hours", "days"]] = None,
    execute_at: Optional[str] = None,
    preserve_history: bool = False,
    history_message_count: int = 10,
    retry_count: int = 1,
    timeout_seconds: int = 600,
    expiration_type: Optional[Literal["fixed_date", "duration_days"]] = None,
    expiration_fixed_date: Optional[str] = None,
    expiration_duration_days: Optional[int] = None,
) -> dict:
    """Generate subscription preview without creating it.

    Args:
        token_info: Task token info (auto-injected from MCP context)
        display_name: Display name for the subscription
        trigger_type: Trigger type (cron, interval, one_time)
        prompt_template: Prompt template for execution
        description: Optional description
        cron_expression: Cron expression (for cron type)
        interval_value: Interval value (for interval type)
        interval_unit: Interval unit (for interval type)
        execute_at: Execution time (for one_time type)
        preserve_history: Whether to preserve history
        history_message_count: Number of history messages to preserve
        retry_count: Retry count on failure
        timeout_seconds: Execution timeout
        expiration_type: Expiration type
        expiration_fixed_date: Fixed expiration date
        expiration_duration_days: Days until expiration

    Returns:
        Dict with __silent_exit__ marker and preview info.
        The preview is rendered as a block in the frontend.
    """
    # Get task info from database
    db = SessionLocal()
    task_info = None
    try:
        task_info = _get_task_info(db, token_info.task_id)
    except Exception as e:
        logger.warning(f"[MCP:Subscription] Could not get task info: {e}")
    finally:
        db.close()

    team_id = task_info.get("team_id") if task_info else None
    team_namespace = (
        task_info.get("team_namespace", "default") if task_info else "default"
    )
    model_name = task_info.get("model_name") if task_info else None
    model_namespace = (
        task_info.get("model_namespace", "default") if task_info else "default"
    )

    logger.info(
        f"[MCP:Subscription] preview_subscription called by user {token_info.user_id}, "
        f"task {token_info.task_id}, team {team_id}"
    )

    # Validate trigger configuration
    validation_error = _validate_trigger_config(
        trigger_type=trigger_type,
        cron_expression=cron_expression,
        interval_value=interval_value,
        interval_unit=interval_unit,
        execute_at=execute_at,
    )
    if validation_error:
        return json.dumps(
            {"success": False, "error": validation_error}, ensure_ascii=False
        )

    # Validate and calculate expiration
    expires_at = None
    if expiration_type:
        if expiration_type == "fixed_date":
            if not expiration_fixed_date:
                return json.dumps(
                    {
                        "success": False,
                        "error": "expiration_fixed_date is required when expiration_type='fixed_date'",
                    },
                    ensure_ascii=False,
                )
            try:
                datetime.fromisoformat(expiration_fixed_date.replace("Z", "+00:00"))
                expires_at = expiration_fixed_date
            except ValueError as e:
                return json.dumps(
                    {
                        "success": False,
                        "error": f"Invalid expiration_fixed_date format: {e}",
                    },
                    ensure_ascii=False,
                )
        elif expiration_type == "duration_days":
            if expiration_duration_days is None:
                return json.dumps(
                    {
                        "success": False,
                        "error": "expiration_duration_days is required when expiration_type='duration_days'",
                    },
                    ensure_ascii=False,
                )
            calculated = datetime.now() + timedelta(days=expiration_duration_days)
            expires_at = calculated.isoformat()

    # Generate IDs
    preview_id = f"preview_{uuid.uuid4().hex[:8]}"
    execution_id = f"exec_{uuid.uuid4().hex[:12]}"

    # Default timezone
    timezone = "Asia/Shanghai"

    # Build trigger config
    trigger_config = _build_trigger_config(
        trigger_type=trigger_type,
        timezone=timezone,
        cron_expression=cron_expression,
        interval_value=interval_value,
        interval_unit=interval_unit,
        execute_at=execute_at,
    )

    # Store preview data
    preview_data = {
        "preview_id": preview_id,
        "execution_id": execution_id,
        "display_name": display_name,
        "description": description,
        "trigger_type": trigger_type,
        "trigger_config": trigger_config,
        "prompt_template": prompt_template,
        "preserve_history": preserve_history,
        "history_message_count": history_message_count,
        "retry_count": retry_count,
        "timeout_seconds": timeout_seconds,
        "expires_at": expires_at,
        "user_id": token_info.user_id,
        "team_id": team_id,
        "team_namespace": team_namespace,
        "timezone": timezone,
        "model_name": model_name,
        "model_namespace": model_namespace,
    }

    if not _store_preview_data(preview_id, preview_data):
        return {
            "success": False,
            "error": "Failed to store preview data",
        }

    # Find the tool_use_id from session_manager for WebSocket notification
    tool_use_id = None
    try:
        from app.services.chat.storage.session import session_manager

        blocks = await session_manager.get_blocks(token_info.subtask_id)
        for block in reversed(blocks):
            tool_name = block.get("tool_name", "")
            if block.get("type") == "tool" and "preview_subscription" in tool_name:
                tool_use_id = block.get("tool_use_id")
                break
    except Exception as e:
        logger.warning(f"[MCP:Subscription] Could not find tool_use_id: {e}")

    # Prepare block data for frontend
    block_data = {
        "type": "subscription_preview",
        "preview_id": preview_id,
        "execution_id": execution_id,
        "task_id": token_info.task_id,
        "subtask_id": token_info.subtask_id,
        "tool_use_id": tool_use_id,
        "config": {
            "display_name": display_name,
            "description": description,
            "trigger_type": trigger_type,
            "trigger_display": _format_trigger_description(
                trigger_type, trigger_config
            ),
            "prompt_preview": (
                prompt_template[:200] + "..."
                if len(prompt_template) > 200
                else prompt_template
            ),
            "preserve_history": preserve_history,
            "history_message_count": history_message_count,
            "retry_count": retry_count,
            "timeout_seconds": timeout_seconds,
            "expires_at": expires_at,
        },
        "created_at": datetime.now().isoformat(),
        "status": "pending",
    }

    # Send independent subscription_preview block to frontend via WebSocket
    # This creates a new block (not attached to tool block) similar to video/image blocks
    await _send_subscription_preview_block(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        preview_data=block_data,
    )

    logger.info(
        f"[MCP:Subscription] Generated preview {preview_id} with block rendering"
    )

    # Generate preview table
    preview_table = _format_preview_table(
        display_name=display_name,
        description=description,
        trigger_type=trigger_type,
        trigger_config=trigger_config,
        prompt_template=prompt_template,
        preserve_history=preserve_history,
        history_message_count=history_message_count,
        retry_count=retry_count,
        timeout_seconds=timeout_seconds,
        expires_at=expires_at,
    )

    logger.info(f"[MCP:Subscription] Generated preview {preview_id}")

    # Return preview data that will appear in tool_output
    # The frontend will detect this and render the subscription preview block
    return {
        "__silent_exit__": True,
        "reason": "subscription_preview block displayed; waiting for user confirmation",
        "preview_id": preview_id,
        "execution_id": execution_id,
        "task_id": token_info.task_id,
        "subtask_id": token_info.subtask_id,
        "type": "subscription_preview",
        "config": block_data["config"],
        "created_at": block_data["created_at"],
        "status": "pending",
    }


@mcp_tool(
    name="create_subscription",
    description=(
        "Create a subscription task AFTER user has confirmed via message. "
        "This tool should ONLY be called when user sends a confirmation message (e.g., '确认', '创建') after preview.\n\n"
        "Workflow:\n"
        "1. User: 'remind me every morning'\n"
        "2. AI: Call preview_subscription tool to generate preview\n"
        "3. System: Displays interactive preview card with Confirm/Cancel buttons\n"
        "4. User confirmation (either one):\n"
        "   - Clicks 'Confirm' button in UI: Frontend creates automatically, AI does NOTHING\n"
        "   - Sends '确认' message: AI must call create_subscription to create the subscription\n\n"
        "CRITICAL: NEVER auto-call create_subscription after preview. Wait for explicit user confirmation message."
    ),
    server="subscription",
    exclude_params=["token_info"],
    param_descriptions={
        "display_name": "Display name for the subscription task",
        "trigger_type": "Trigger type: cron, interval, or one_time",
        "prompt_template": "Prompt template for execution",
        "preview_id": "Preview ID from preview_subscription tool (REQUIRED)",
        "description": "Optional description of the subscription task",
        "cron_expression": "Cron expression (for cron trigger)",
        "interval_value": "Interval value (for interval trigger)",
        "interval_unit": "Interval unit: minutes, hours, or days",
        "execute_at": "Execution time in ISO format (for one_time trigger)",
        "preserve_history": "Whether to preserve conversation history",
        "history_message_count": "Number of history messages to preserve (0-50)",
        "retry_count": "Retry count on failure (0-3)",
        "timeout_seconds": "Execution timeout in seconds (60-3600)",
    },
)
def create_subscription(
    token_info: TaskTokenInfo,
    display_name: str,
    trigger_type: Literal["cron", "interval", "one_time"],
    prompt_template: str,
    preview_id: str,
    description: Optional[str] = None,
    cron_expression: Optional[str] = None,
    interval_value: Optional[int] = None,
    interval_unit: Optional[Literal["minutes", "hours", "days"]] = None,
    execute_at: Optional[str] = None,
    preserve_history: bool = False,
    history_message_count: int = 10,
    retry_count: int = 1,
    timeout_seconds: int = 600,
) -> str:
    """Create a subscription task using preview configuration.

    Args:
        token_info: Task token info (auto-injected from MCP context)
        display_name: Display name for the subscription
        trigger_type: Trigger type
        prompt_template: Prompt template for execution
        preview_id: Preview ID from preview_subscription tool (REQUIRED)
        description: Optional description
        cron_expression: Cron expression (for cron type)
        interval_value: Interval value (for interval type)
        interval_unit: Interval unit (for interval type)
        execute_at: Execution time (for one_time type)
        preserve_history: Whether to preserve history
        history_message_count: Number of history messages to preserve
        retry_count: Retry count on failure
        timeout_seconds: Execution timeout

    Returns:
        JSON string with creation result
    """
    logger.info(
        f"[MCP:Subscription] create_subscription called by user {token_info.user_id}, "
        f"preview_id={preview_id}"
    )

    # Load preview data
    preview_data = _get_preview_data(preview_id)
    if not preview_data:
        return json.dumps(
            {
                "success": False,
                "error": "预览已过期或无效，请重新调用 preview_subscription 工具进行预览。",
            },
            ensure_ascii=False,
        )

    # Use preview configuration
    display_name = preview_data.get("display_name", display_name)
    description = preview_data.get("description", description)
    trigger_type = preview_data.get("trigger_type", trigger_type)
    trigger_config = preview_data.get("trigger_config", {})
    prompt_template = preview_data.get("prompt_template", prompt_template)
    preserve_history = preview_data.get("preserve_history", preserve_history)
    history_message_count = preview_data.get(
        "history_message_count", history_message_count
    )
    retry_count = preview_data.get("retry_count", retry_count)
    timeout_seconds = preview_data.get("timeout_seconds", timeout_seconds)
    expires_at = preview_data.get("expires_at")
    team_id = preview_data.get("team_id")
    team_namespace = preview_data.get("team_namespace", "default")
    model_name = preview_data.get("model_name")
    model_namespace = preview_data.get("model_namespace", "default")

    # Validate team_id exists
    if not team_id:
        return json.dumps(
            {
                "success": False,
                "error": "无法获取团队信息，请重试。",
            },
            ensure_ascii=False,
        )

    # Clear preview after using it
    _clear_preview_data(preview_id)
    logger.info(f"[MCP:Subscription] Using preview {preview_id} to create subscription")

    # Generate unique subscription name
    subscription_name = _generate_unique_name(display_name)

    # Build model_ref
    model_ref = None
    if model_name:
        model_ref = {
            "name": model_name,
            "namespace": model_namespace,
        }

    # Create subscription via service
    db = SessionLocal()
    try:
        # Parse expires_at from ISO string to datetime if provided
        expires_at_datetime = None
        if expires_at:
            try:
                expires_at_datetime = datetime.fromisoformat(
                    expires_at.replace("Z", "+00:00")
                )
            except (ValueError, AttributeError):
                logger.warning(
                    f"[MCP:Subscription] Invalid expires_at format: {expires_at}"
                )

        subscription_data = SubscriptionCreate(
            name=subscription_name,
            namespace=team_namespace,
            display_name=display_name,
            description=description,
            task_type=SubscriptionTaskType.COLLECTION,
            trigger_type=SubscriptionTriggerType(trigger_type),
            trigger_config=trigger_config,
            team_id=team_id,
            prompt_template=prompt_template,
            preserve_history=preserve_history,
            history_message_count=history_message_count,
            retry_count=retry_count,
            timeout_seconds=timeout_seconds,
            enabled=True,
            model_ref=model_ref,
            expires_at=expires_at_datetime,
        )

        result = subscription_service.create_subscription(
            db, subscription_in=subscription_data, user_id=token_info.user_id
        )

        # Format success response
        next_time_str = None
        if result.next_execution_time:
            if isinstance(result.next_execution_time, str):
                next_time_str = result.next_execution_time
            else:
                next_time_str = result.next_execution_time.isoformat()

        trigger_summary = _format_trigger_description(trigger_type, trigger_config)

        if next_time_str:
            message = (
                f"订阅任务创建成功！将于 {next_time_str.replace('T', ' ')} 首次执行。"
            )
        else:
            message = "订阅任务创建成功！"

        return json.dumps(
            {
                "success": True,
                "subscription": {
                    "id": result.id,
                    "name": result.name,
                    "display_name": result.display_name,
                    "trigger_type": trigger_type,
                    "trigger_summary": trigger_summary,
                    "next_execution_time": next_time_str,
                    "preserve_history": preserve_history,
                    "enabled": True,
                },
                "message": message,
                "management_url": f"/subscriptions/{result.id}",
            },
            ensure_ascii=False,
        )

    except Exception as e:
        logger.error(
            f"[MCP:Subscription] Failed to create subscription: {e}", exc_info=True
        )
        return json.dumps(
            {
                "success": False,
                "error": f"Failed to create subscription: {str(e)}",
            },
            ensure_ascii=False,
        )
    finally:
        db.close()
