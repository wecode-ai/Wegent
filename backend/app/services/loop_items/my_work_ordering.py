"""Database ordering for personal work; applied before keyset pagination."""

from datetime import datetime

from sqlalchemy import Integer, String, and_, case, cast, func, literal, or_, select
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from app.models.delivery import LoopItem, LoopItemTaskBinding, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution


def attention_order(
    user_id: int, assigned_only: bool, order: str = "attention"
) -> tuple[ColumnElement[int], ColumnElement[int], ColumnElement[str]]:
    nodes = LoopItem.__table__.alias("attention_node")
    mine = LoopItem.assignee_user_id == user_id
    request = (
        select(nodes.c.id)
        .where(
            nodes.c.resource_type == "human_request_index",
            nodes.c.parent_id == LoopItem.id,
            nodes.c.assignee_user_id == user_id,
        )
        .exists()
    )
    execution = (
        select(LoopItemExecution.status)
        .where(LoopItemExecution.loop_item_id == LoopItem.id)
        .order_by(LoopItemExecution.id.desc())
        .limit(1)
        .correlate(LoopItem)
        .scalar_subquery()
    )
    binding = aliased(LoopItemTaskBinding)
    bound = (
        select(binding.id)
        .where(
            binding.loop_item_id == LoopItem.id,
            binding.task_user_id == user_id,
            loop_datetime_is_unset(binding.unlinked_at),
        )
        .correlate(LoopItem)
        .exists()
    )
    needs_me = or_(
        request,
        and_(mine, LoopItem.status == "in_review"),
    )
    latest_id = (
        select(func.max(LoopItemExecution.id))
        .where(
            LoopItemExecution.loop_item_id == LoopItem.id,
        )
        .correlate(LoopItem)
        .scalar_subquery()
    )
    agent = LoopItem.__table__.alias("attention_agent")
    owns_agent = (
        select(agent.c.id)
        .where(
            agent.c.id == LoopItem.assignee_agent_id,
            agent.c.resource_type == "chat_agent",
            agent.c.created_by_user_id == user_id,
        )
        .exists()
    )
    approval = (
        select(LoopItemExecution.id)
        .where(
            LoopItemExecution.loop_item_id == LoopItem.id,
            LoopItemExecution.id == latest_id,
            LoopItemExecution.status == "pending_approval",
        )
        .exists()
    )
    rank = case(
        (LoopItem.status.in_(["completed", "cancelled", "archived"]), 4),
        (or_(needs_me, and_(approval, owns_agent)), 0),
        *(
            [
                (
                    and_(
                        mine,
                        LoopItem.status.in_(["inbox", "pending"]),
                        ~bound,
                        execution.is_(None),
                    ),
                    1,
                ),
                (
                    or_(
                        LoopItem.status == "in_progress",
                        execution.in_(
                            ["queued", "claimed", "running", "cancel_requested"]
                        ),
                    ),
                    2,
                ),
            ]
            if assigned_only
            else []
        ),
        else_=3,
    )
    priority = (
        case(
            (LoopItem.priority == "urgent", 0),
            (LoopItem.priority == "high", 1),
            (LoopItem.priority == "medium", 2),
            (LoopItem.priority == "low", 3),
            else_=4,
        )
        if assigned_only or order == "priority"
        else cast(literal(0), Integer)
    )
    comment_at = (
        select(func.max(nodes.c.created_at))
        .where(
            nodes.c.resource_type == "comment",
            nodes.c.loop_item_id == LoopItem.id,
            loop_datetime_is_unset(nodes.c.deleted_at),
        )
        .correlate(LoopItem)
        .scalar_subquery()
    )
    completed_at = (
        select(func.max(LoopItemExecution.completed_at))
        .where(
            LoopItemExecution.loop_item_id == LoopItem.id,
            LoopItemExecution.status.in_(["completed", "failed", "cancelled"]),
        )
        .correlate(LoopItem)
        .scalar_subquery()
    )
    # Execution heartbeat/stream updates are deliberately excluded.
    activity = case(
        (comment_at > LoopItem.updated_at, comment_at), else_=LoopItem.updated_at
    )
    activity = case((completed_at > activity, completed_at), else_=activity)
    if order != "attention":
        rank = case(
            (LoopItem.status.in_(["completed", "cancelled", "archived"]), 4), else_=0
        )
        if order != "priority":
            priority = cast(literal(0), Integer)
    if order == "assignment":
        index = LoopItem.__table__.alias("attention_assignment")
        event = LoopItem.__table__.alias("attention_assignment_event")
        assigned_at = (
            select(func.max(event.c.created_at))
            .select_from(index.join(event, event.c.id == index.c.loop_item_id))
            .where(
                index.c.resource_type == "assignment_index",
                index.c.parent_id == LoopItem.id,
                event.c.resource_type == "comment",
                event.c.metadata["target_type"].as_string() == "human",
                event.c.metadata["target_id"].as_string() == str(user_id),
                mine,
            )
            .correlate(LoopItem)
            .scalar_subquery()
        )
        rank = case(
            (LoopItem.status.in_(["completed", "cancelled", "archived"]), 4),
            (assigned_at.is_(None), 3),
            else_=0,
        )
        activity = func.coalesce(assigned_at, literal(datetime(9999, 1, 1)))
    return rank, priority, cast(activity, String)
