"""Utility functions for filtering data by excluded user IDs."""
from typing import List

from sqlalchemy import not_
from sqlalchemy.sql import Select

from app.core.config import settings
from app.models import ConversationRecord


def get_excluded_user_ids() -> List[int]:
    """Get the list of excluded user IDs from settings."""
    return settings.excluded_user_ids_list


def apply_user_filter(query: Select, table=None) -> Select:
    """
    Apply user ID exclusion filter to a SQLAlchemy query.
    Filters out records where user_id is in the excluded list.

    Args:
        query: The SQLAlchemy Select query
        table: Optional table reference (defaults to ConversationRecord)

    Returns:
        The filtered query
    """
    excluded_ids = get_excluded_user_ids()
    if not excluded_ids:
        return query

    target_table = table if table is not None else ConversationRecord
    return query.where(not_(target_table.user_id.in_(excluded_ids)))
