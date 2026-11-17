# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve one subscription history window for every execution entry point."""

from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource

MAX_SUBSCRIPTION_HISTORY = 50
DEFAULT_SUBSCRIPTION_HISTORY = 10


def is_subscription_task(task: TaskResource) -> bool:
    """Recognize retained tasks independently of which entry triggered execution."""
    document = getattr(task, "json", None) or {}
    labels = document.get("metadata", {}).get("labels") or {}
    return (
        getattr(task, "is_active", None) == TaskResource.STATE_SUBSCRIPTION
        or labels.get("type") == "subscription"
    )


def resolve_subscription_history_limit(
    db: Session, task: TaskResource, requested: Optional[int] = None
) -> Optional[int]:
    """Keep ordinary requests unchanged and cap subscription continuation/retry."""
    if not is_subscription_task(task):
        return requested
    if requested is not None:
        return min(MAX_SUBSCRIPTION_HISTORY, max(0, requested))
    labels = (task.json or {}).get("metadata", {}).get("labels") or {}
    subscription_id = str(labels.get("subscriptionId", ""))
    row = None
    if subscription_id.isascii() and subscription_id.isdigit():
        row = (
            db.query(Kind.json)
            .filter(
                Kind.id == int(subscription_id),
                Kind.user_id == task.user_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
    if row is None:
        return DEFAULT_SUBSCRIPTION_HISTORY
    spec = (row[0] or {}).get("spec") or {}
    if not spec.get("preserveHistory", False):
        return 0
    configured = spec.get("historyMessageCount", DEFAULT_SUBSCRIPTION_HISTORY)
    if not isinstance(configured, int):
        configured = DEFAULT_SUBSCRIPTION_HISTORY
    return min(MAX_SUBSCRIPTION_HISTORY, max(0, configured))
