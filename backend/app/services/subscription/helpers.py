# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Helper functions for Subscription service.

This module contains utility functions for:
- Building Subscription CRD structures
- Trigger configuration handling
- Next execution time calculation
- Prompt template resolution
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.subscription import (
    CronTriggerConfig,
    EventTriggerConfig,
    GitPushEventConfig,
    IntervalTriggerConfig,
    OneTimeTriggerConfig,
    Subscription,
    SubscriptionCreate,
    SubscriptionEventType,
    SubscriptionMetadata,
    SubscriptionSpec,
    SubscriptionStatus,
    SubscriptionTeamRef,
    SubscriptionTriggerConfig,
    SubscriptionTriggerType,
    SubscriptionWorkspaceRef,
)

logger = logging.getLogger(__name__)


# Supported prompt template variables
TEMPLATE_VARIABLES = {
    "date": lambda: datetime.now().strftime("%Y-%m-%d"),
    "time": lambda: datetime.now().strftime("%H:%M:%S"),
    "datetime": lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "timestamp": lambda: str(int(datetime.now().timestamp())),
}


def resolve_prompt_template(
    template: str,
    subscription_name: str,
    extra_variables: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Resolve prompt template with variables.

    Supported variables:
    - {{date}}: Current date (YYYY-MM-DD)
    - {{time}}: Current time (HH:MM:SS)
    - {{datetime}}: Current datetime (YYYY-MM-DD HH:MM:SS)
    - {{timestamp}}: Unix timestamp
    - {{subscription_name}}: Subscription display name
    - Custom variables from extra_variables dict

    Args:
        template: The prompt template string
        subscription_name: The subscription's display name
        extra_variables: Optional dict of additional variables

    Returns:
        Resolved prompt string
    """
    result = template

    # Replace standard variables
    for var_name, var_func in TEMPLATE_VARIABLES.items():
        pattern = "{{" + var_name + "}}"
        if pattern in result:
            result = result.replace(pattern, var_func())

    # Replace subscription_name
    result = result.replace("{{subscription_name}}", subscription_name)

    # Replace extra variables (like webhook_data)
    if extra_variables:
        for var_name, var_value in extra_variables.items():
            pattern = "{{" + var_name + "}}"
            if pattern in result:
                if isinstance(var_value, (dict, list)):
                    result = result.replace(
                        pattern, json.dumps(var_value, ensure_ascii=False)
                    )
                else:
                    result = result.replace(pattern, str(var_value))

    return result


def build_subscription_crd(
    subscription_in: SubscriptionCreate,
    team: Kind,
    workspace: Optional[TaskResource],
    webhook_token: Optional[str],
) -> Subscription:
    """
    Build Subscription CRD JSON structure.

    Args:
        subscription_in: Subscription creation data
        team: The Team (Kind) resource
        workspace: Optional Workspace (TaskResource)
        webhook_token: Optional webhook token for event triggers

    Returns:
        Subscription CRD object
    """
    from app.schemas.kind import ModelRef

    # Build trigger config
    trigger = build_trigger_config(
        subscription_in.trigger_type, subscription_in.trigger_config
    )

    # Build modelRef from model_ref dict if provided
    model_ref = None
    if subscription_in.model_ref:
        model_ref = ModelRef(
            name=subscription_in.model_ref.get("name", ""),
            namespace=subscription_in.model_ref.get("namespace", "default"),
        )

    spec = SubscriptionSpec(
        displayName=subscription_in.display_name,
        taskType=subscription_in.task_type,
        trigger=trigger,
        teamRef=SubscriptionTeamRef(name=team.name, namespace=team.namespace),
        workspaceRef=(
            SubscriptionWorkspaceRef(name=workspace.name, namespace=workspace.namespace)
            if workspace
            else None
        ),
        modelRef=model_ref,
        forceOverrideBotModel=subscription_in.force_override_bot_model,
        promptTemplate=subscription_in.prompt_template,
        retryCount=subscription_in.retry_count,
        timeoutSeconds=subscription_in.timeout_seconds,
        enabled=subscription_in.enabled,
        description=subscription_in.description,
        # History preservation settings
        preserveHistory=subscription_in.preserve_history,
        historyMessageCount=subscription_in.history_message_count,
    )

    status = SubscriptionStatus()
    if webhook_token:
        status.webhookUrl = f"/api/subscriptions/webhook/{webhook_token}"

    return Subscription(
        metadata=SubscriptionMetadata(
            name=subscription_in.name,
            namespace=subscription_in.namespace,
            displayName=subscription_in.display_name,
        ),
        spec=spec,
        status=status,
    )


def build_trigger_config(
    trigger_type: SubscriptionTriggerType,
    trigger_config: Dict[str, Any],
) -> SubscriptionTriggerConfig:
    """
    Build SubscriptionTriggerConfig from trigger type and config dict.

    Args:
        trigger_type: The trigger type enum
        trigger_config: Dict containing trigger-specific configuration

    Returns:
        SubscriptionTriggerConfig object
    """
    trigger_type_enum = (
        trigger_type
        if isinstance(trigger_type, SubscriptionTriggerType)
        else SubscriptionTriggerType(trigger_type)
    )

    if trigger_type_enum == SubscriptionTriggerType.CRON:
        return SubscriptionTriggerConfig(
            type=trigger_type_enum,
            cron=CronTriggerConfig(
                expression=trigger_config.get("expression", "0 9 * * *"),
                timezone=trigger_config.get("timezone", "UTC"),
            ),
        )
    elif trigger_type_enum == SubscriptionTriggerType.INTERVAL:
        return SubscriptionTriggerConfig(
            type=trigger_type_enum,
            interval=IntervalTriggerConfig(
                value=trigger_config.get("value", 1),
                unit=trigger_config.get("unit", "hours"),
            ),
        )
    elif trigger_type_enum == SubscriptionTriggerType.ONE_TIME:
        execute_at_str = trigger_config.get("execute_at")
        if not execute_at_str:
            raise ValueError("execute_at is required for ONE_TIME trigger type")
        # Handle ISO format with 'Z' suffix (JavaScript's toISOString() format)
        # Python's fromisoformat() doesn't support 'Z', need to replace with '+00:00'
        execute_at_normalized = execute_at_str.replace("Z", "+00:00")
        return SubscriptionTriggerConfig(
            type=trigger_type_enum,
            one_time=OneTimeTriggerConfig(
                execute_at=datetime.fromisoformat(execute_at_normalized),
            ),
        )
    elif trigger_type_enum == SubscriptionTriggerType.EVENT:
        event_type = trigger_config.get("event_type", "webhook")
        git_push_config = None

        if event_type == "git_push":
            git_push_data = trigger_config.get("git_push", {})
            git_push_config = GitPushEventConfig(
                repository=git_push_data.get("repository", ""),
                branch=git_push_data.get("branch"),
            )

        return SubscriptionTriggerConfig(
            type=trigger_type_enum,
            event=EventTriggerConfig(
                event_type=SubscriptionEventType(event_type),
                git_push=git_push_config,
            ),
        )

    raise ValueError(f"Unknown trigger type: {trigger_type}")


def extract_trigger_config(trigger: SubscriptionTriggerConfig) -> Dict[str, Any]:
    """
    Extract trigger config dict from SubscriptionTriggerConfig.

    Args:
        trigger: The trigger configuration object

    Returns:
        Dict containing trigger-specific configuration
    """
    if trigger.type == SubscriptionTriggerType.CRON and trigger.cron:
        return {
            "expression": trigger.cron.expression,
            "timezone": trigger.cron.timezone,
        }
    elif trigger.type == SubscriptionTriggerType.INTERVAL and trigger.interval:
        return {
            "value": trigger.interval.value,
            "unit": trigger.interval.unit,
        }
    elif trigger.type == SubscriptionTriggerType.ONE_TIME and trigger.one_time:
        return {
            "execute_at": trigger.one_time.execute_at.isoformat(),
        }
    elif trigger.type == SubscriptionTriggerType.EVENT and trigger.event:
        result = {"event_type": trigger.event.event_type.value}
        if trigger.event.git_push:
            result["git_push"] = {
                "repository": trigger.event.git_push.repository,
                "branch": trigger.event.git_push.branch,
            }
        return result

    return {}


def calculate_next_execution_time(
    trigger_type: SubscriptionTriggerType,
    trigger_config: Dict[str, Any],
) -> Optional[datetime]:
    """
    Calculate the next execution time based on trigger configuration.

    For cron triggers, the timezone from trigger_config is used to interpret
    the cron expression. The returned datetime is always in UTC for storage.

    For example, if cron is "0 9 * * *" with timezone "Asia/Shanghai",
    it means 9:00 AM Shanghai time, which is 1:00 AM UTC.

    All returned datetimes are naive UTC (no tzinfo) for database storage.

    Args:
        trigger_type: The trigger type
        trigger_config: Dict containing trigger-specific configuration

    Returns:
        Next execution time as naive UTC datetime, or None for event triggers
    """
    from zoneinfo import ZoneInfo

    trigger_type_enum = (
        trigger_type
        if isinstance(trigger_type, SubscriptionTriggerType)
        else SubscriptionTriggerType(trigger_type)
    )

    # Use UTC as the reference time
    utc_tz = ZoneInfo("UTC")
    now_utc = datetime.now(utc_tz)

    if trigger_type_enum == SubscriptionTriggerType.CRON:
        # Use croniter to calculate next run with timezone support
        try:
            from croniter import croniter

            cron_expr = trigger_config.get("expression", "0 9 * * *")
            timezone_str = trigger_config.get("timezone", "UTC")

            # Get the user's timezone
            try:
                user_tz = ZoneInfo(timezone_str)
            except Exception:
                logger.warning(
                    f"Invalid timezone '{timezone_str}', falling back to UTC"
                )
                user_tz = utc_tz

            # Convert current UTC time to user's timezone
            now_user_tz = now_utc.astimezone(user_tz)

            # Calculate next execution in user's timezone
            iter = croniter(cron_expr, now_user_tz)
            next_user_tz = iter.get_next(datetime)

            # Ensure the result has timezone info
            if next_user_tz.tzinfo is None:
                next_user_tz = next_user_tz.replace(tzinfo=user_tz)

            # Convert back to UTC
            next_utc = next_user_tz.astimezone(utc_tz)

            logger.debug(
                f"Cron calculation: expr={cron_expr}, tz={timezone_str}, "
                f"now_utc={now_utc}, now_user_tz={now_user_tz}, "
                f"next_user_tz={next_user_tz}, next_utc={next_utc}"
            )

            # Return naive UTC datetime for database storage
            return next_utc.replace(tzinfo=None)
        except Exception as e:
            logger.warning(f"Failed to parse cron expression: {e}")
            return None

    elif trigger_type_enum == SubscriptionTriggerType.INTERVAL:
        value = trigger_config.get("value", 1)
        unit = trigger_config.get("unit", "hours")

        # Calculate interval from UTC now
        now_naive_utc = now_utc.replace(tzinfo=None)
        if unit == "minutes":
            return now_naive_utc + timedelta(minutes=value)
        elif unit == "hours":
            return now_naive_utc + timedelta(hours=value)
        elif unit == "days":
            return now_naive_utc + timedelta(days=value)

    elif trigger_type_enum == SubscriptionTriggerType.ONE_TIME:
        execute_at = trigger_config.get("execute_at")
        if execute_at:
            if isinstance(execute_at, str):
                # Parse ISO format, handle both timezone-aware and naive
                parsed = datetime.fromisoformat(execute_at.replace("Z", "+00:00"))
                if parsed.tzinfo is not None:
                    # Convert to UTC and strip tzinfo
                    return parsed.astimezone(utc_tz).replace(tzinfo=None)
                # Assume naive datetime is already UTC
                return parsed
            elif hasattr(execute_at, "tzinfo") and execute_at.tzinfo is not None:
                return execute_at.astimezone(utc_tz).replace(tzinfo=None)
            return execute_at

    # Event triggers don't have scheduled next execution
    return None


def create_or_get_workspace(
    db: Session,
    *,
    user_id: int,
    git_repo: str,
    git_repo_id: Optional[int],
    git_domain: str,
    branch_name: str,
) -> int:
    """
    Create or get a workspace for the given git repository.

    This method checks if a workspace already exists for the given repo/branch,
    and creates one if it doesn't exist.

    Args:
        db: Database session
        user_id: User ID
        git_repo: Git repository name (e.g., 'owner/repo')
        git_repo_id: Git repository ID
        git_domain: Git domain (e.g., 'github.com')
        branch_name: Git branch name

    Returns:
        Workspace ID
    """
    from app.core.constants import KIND_WORKSPACE
    from app.models.task import TaskResource

    # Generate a unique workspace name based on repo and branch
    workspace_name = f"{git_repo.replace('/', '-')}-{branch_name}".lower()[:100]
    namespace = "default"

    # Check if workspace already exists
    existing = (
        db.query(TaskResource)
        .filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == KIND_WORKSPACE,
            TaskResource.name == workspace_name,
            TaskResource.namespace == namespace,
            TaskResource.is_active == True,
        )
        .first()
    )

    if existing:
        return existing.id

    # Build git URL from domain and repo
    git_url = f"https://{git_domain}/{git_repo}.git"

    # Create workspace CRD JSON
    workspace_json = {
        "apiVersion": "wegent.io/v1",
        "kind": "Workspace",
        "metadata": {
            "name": workspace_name,
            "namespace": namespace,
        },
        "spec": {
            "repository": {
                "gitUrl": git_url,
                "gitRepo": git_repo,
                "gitRepoId": git_repo_id or 0,
                "gitDomain": git_domain,
                "branchName": branch_name,
            }
        },
    }

    # Create new workspace
    workspace = TaskResource(
        user_id=user_id,
        kind=KIND_WORKSPACE,
        name=workspace_name,
        namespace=namespace,
        json=workspace_json,
        is_active=True,
    )

    db.add(workspace)
    db.flush()  # Get the ID without committing

    return workspace.id
