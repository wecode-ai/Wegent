"""Shared filters for project-owned tasks and classified group Threads."""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Query

from app.models.delivery import LoopItem


def filtered_items(
    query: Query,
    *,
    assignee_type: str | None = None,
    assignee_id: str | None = None,
    execution_state: str | None = None,
) -> list[LoopItem]:
    if assignee_type == "user" and assignee_id:
        try:
            assignee_user_id = int(assignee_id)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "User assignee id must be numeric",
            ) from exc
        query = query.filter(LoopItem.assignee_user_id == assignee_user_id)
    elif assignee_type == "agent" and assignee_id:
        query = query.filter(LoopItem.assignee_agent_id == assignee_id)
    elif assignee_type == "team" and assignee_id:
        try:
            assignee_team_id = int(assignee_id)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Team assignee id must be numeric",
            ) from exc
        query = query.filter(LoopItem.assignee_team_id == assignee_team_id)
    if execution_state:
        from app.models.loop_item_execution import LoopItemExecution

        query = query.filter(
            LoopItem.id.in_(
                select(LoopItemExecution.loop_item_id).where(
                    LoopItemExecution.status == execution_state
                )
            )
        )
    return query.order_by(
        LoopItem.sort_order, LoopItem.updated_at.desc(), LoopItem.id
    ).all()
