# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Repository helpers for transition page items."""

from typing import Any, Optional

from sqlalchemy.orm import Session

from shared.utils.snowflake import get_snowflake_id
from wecode.models.transition_page import TransitionPageItem
from wecode.service.transition_pages.constants import (
    ITEM_GROUP_MEMBER,
    user_key,
)


class TransitionPageRepository:
    def __init__(self, db: Session):
        self.db = db

    def create_item(
        self,
        page_id: str,
        item_type: str,
        key: str,
        data_json: dict[str, Any],
        *,
        global_key: Optional[str] = None,
        parent_key: Optional[str] = None,
        sort_order: int = 0,
        user_id: int = 0,
    ) -> TransitionPageItem:
        item = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=item_type,
            key=key,
            global_key=global_key,
            parent_key=parent_key,
            data_json=data_json,
            sort_order=sort_order,
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(item)
        self.db.flush()
        return item

    def upsert_item(
        self,
        page_id: str,
        item_type: str,
        key: str,
        data_json: dict[str, Any],
        *,
        global_key: Optional[str] = None,
        parent_key: Optional[str] = None,
        sort_order: int = 0,
        user_id: int = 0,
    ) -> TransitionPageItem:
        """Create or update an item within the current SQLAlchemy session.

        This helper is session-scoped and does not provide a database-native
        atomic upsert. Concurrent writers targeting the same
        ``(page_id, type, key)`` tuple can still race and must handle
        ``IntegrityError`` at the call site.
        """
        item = self.get_item(page_id, item_type, key)
        if item is None:
            return self.create_item(
                page_id,
                item_type,
                key,
                data_json,
                global_key=global_key,
                parent_key=parent_key,
                sort_order=sort_order,
                user_id=user_id,
            )

        item.data_json = data_json
        item.global_key = global_key
        item.parent_key = parent_key
        item.sort_order = sort_order
        item.updated_by = user_id
        self.db.flush()
        return item

    def get_item(
        self, page_id: str, item_type: str, key: str
    ) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == item_type,
                TransitionPageItem.key == key,
            )
            .first()
        )

    def get_by_global_key(self, global_key: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.global_key == global_key)
            .first()
        )

    def get_user_member(
        self, page_id: str, user_id: int
    ) -> Optional[TransitionPageItem]:
        return self.get_item(page_id, ITEM_GROUP_MEMBER, user_key(user_id))

    def list_items(self, page_id: str, item_type: str) -> list[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == item_type,
            )
            .order_by(
                TransitionPageItem.sort_order.asc(),
                TransitionPageItem.id.asc(),
            )
            .all()
        )

    def delete_page(self, page_id: str) -> int:
        deleted = (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.page_id == page_id)
            .delete(synchronize_session="fetch")
        )
        self.db.flush()
        return deleted
