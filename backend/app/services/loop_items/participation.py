"""Use the same participant records shown in the Issue detail."""

from sqlalchemy import select
from sqlalchemy.sql.elements import ColumnElement

from app.models.delivery import LoopItem, LoopItemCollaborator


def participating_item_filter(user_id: int) -> ColumnElement[bool]:
    return LoopItem.id.in_(
        select(LoopItemCollaborator.loop_item_id).where(
            LoopItemCollaborator.user_id == user_id
        )
    )
