# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Single-table project, task, execution, file, and delivery nodes."""

import secrets
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    event,
    or_,
)
from sqlalchemy.engine import Connection
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


def _numeric_id() -> str:
    return str(secrets.randbelow(9_000_000_000_000_000_000) + 1)


class LoopNode(Base):
    __tablename__ = "loop_items"

    id = Column(String(64), primary_key=True, default=_numeric_id)
    resource_type = Column(String(24), nullable=False, index=True)
    project_space = Column(
        String(100),
        nullable=False,
        default="default",
        server_default="default",
        index=True,
    )
    cloud_project_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    parent_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    loop_item_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    delivery_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    public_id = Column(String(36), nullable=True, unique=True)
    project_key = Column(String(16), nullable=True, unique=True)
    name = Column(String(255), nullable=True)
    title = Column(String(255), nullable=True)
    description = Column(Text, nullable=False, default="")
    storage_prefix = Column(String(512), nullable=True, unique=True)
    sequence_number = Column(Integer, nullable=True)
    next_item_number = Column(Integer, nullable=True, default=1)
    created_by_user_id = Column(Integer, nullable=True, index=True)
    updated_by_user_id = Column(Integer, nullable=True)
    assignee_user_id = Column(Integer, nullable=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    added_by_user_id = Column(Integer, nullable=True)
    source = Column(String(20), nullable=True)
    status = Column(String(32), nullable=True, index=True)
    priority = Column(String(20), nullable=True)
    due_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    current_delivery_id = Column(String(64), nullable=True)
    local_project_id = Column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True
    )
    device_id = Column(String(100), nullable=True)
    is_default = Column(Boolean, nullable=True)
    task_user_id = Column(Integer, nullable=True)
    task_id = Column(String(255), nullable=True)
    task_title = Column(String(255), nullable=True)
    backend_task_id = Column(
        big_integer_id_type(),
        ForeignKey("tasks.id", ondelete="SET NULL"),
        nullable=True,
    )
    linked_by_user_id = Column(Integer, nullable=True)
    linked_at = Column(DateTime, nullable=True)
    unlinked_at = Column(DateTime, nullable=True)
    path = Column(String(700), nullable=True)
    kind = Column(String(32), nullable=True)
    display_name = Column(String(255), nullable=True)
    relative_path = Column(String(700), nullable=True)
    object_key = Column(String(1400), nullable=True)
    content_type = Column(String(255), nullable=True)
    size_bytes = Column(big_integer_id_type(), nullable=True)
    sha256 = Column(String(64), nullable=True)
    source_task_binding_id = Column(String(64), nullable=True)
    source_task_snapshot = Column(JSON, nullable=True)
    markdown_object_key = Column(String(1024), nullable=True)
    chat_object_key = Column(String(1024), nullable=True)
    manifest_object_key = Column(String(1024), nullable=True)
    metadata_json = Column("metadata", JSON, nullable=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )
    completed_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)

    __mapper_args__ = {"polymorphic_on": resource_type, "polymorphic_identity": "node"}
    __table_args__ = (
        Index("idx_loop_items_project_type", "cloud_project_id", "resource_type"),
        Index("idx_loop_items_parent_type", "parent_id", "resource_type", "sort_order"),
        Index("idx_loop_items_project_path", "cloud_project_id", "path"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class CloudProject(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "project"}

    def __init__(self, **kwargs: object) -> None:
        kwargs.setdefault("status", "active")
        kwargs.setdefault("next_item_number", 1)
        super().__init__(**kwargs)


class LoopItem(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "task"}


class CloudProjectLocalBinding(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "local_binding"}

    def __init__(self, **kwargs: object) -> None:
        kwargs.setdefault("is_default", False)
        super().__init__(**kwargs)


class LoopItemTaskBinding(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "execution"}

    def __init__(self, **kwargs: object) -> None:
        kwargs.setdefault("linked_at", func.now())
        super().__init__(**kwargs)


class CloudProjectFile(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "file"}

    def __init__(self, **kwargs: object) -> None:
        kwargs.setdefault("size_bytes", 0)
        super().__init__(**kwargs)


class LoopItemAttachment(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "attachment"}


class LoopItemCollaborator(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "collaborator"}


class Delivery(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "delivery"}


class DeliveryAsset(LoopNode):
    __mapper_args__ = {"polymorphic_identity": "delivery_asset"}


_MYSQL_UNSET_DATETIME = datetime(1970, 1, 1, 0, 0, 1)
_MYSQL_NON_NULL_DEFAULTS: dict[str, object] = {
    "cloud_project_id": "",
    "parent_id": "",
    "loop_item_id": "",
    "delivery_id": "",
    "public_id": "",
    "project_key": "",
    "name": "",
    "title": "",
    "storage_prefix": "",
    "sequence_number": 0,
    "created_by_user_id": 0,
    "updated_by_user_id": 0,
    "assignee_user_id": 0,
    "user_id": 0,
    "added_by_user_id": 0,
    "source": "",
    "status": "",
    "priority": "",
    "due_at": _MYSQL_UNSET_DATETIME,
    "current_delivery_id": "",
    "local_project_id": 0,
    "device_id": "",
    "is_default": False,
    "task_user_id": 0,
    "task_id": "",
    "task_title": "",
    "backend_task_id": 0,
    "linked_by_user_id": 0,
    "linked_at": _MYSQL_UNSET_DATETIME,
    "unlinked_at": _MYSQL_UNSET_DATETIME,
    "path": "",
    "kind": "",
    "display_name": "",
    "relative_path": "",
    "object_key": "",
    "content_type": "",
    "size_bytes": 0,
    "sha256": "",
    "source_task_binding_id": "",
    "source_task_snapshot": {},
    "markdown_object_key": "",
    "chat_object_key": "",
    "manifest_object_key": "",
    "metadata_json": {},
    "completed_at": _MYSQL_UNSET_DATETIME,
    "delivered_at": _MYSQL_UNSET_DATETIME,
}


def adapt_loop_node_values_for_dialect(
    values: dict[str, object], dialect_name: str
) -> dict[str, object]:
    """Convert explicit nulls to sentinels required by the production schema."""
    if dialect_name != "mysql":
        return values
    adapted = values.copy()
    for attribute, default in _MYSQL_NON_NULL_DEFAULTS.items():
        if attribute in adapted and adapted[attribute] is None:
            adapted[attribute] = (
                default.copy() if isinstance(default, dict) else default
            )
    return adapted


def loop_datetime_is_unset(column: object) -> object:
    """Match unset datetimes in both nullable and sentinel schemas."""
    return or_(column.is_(None), column == _MYSQL_UNSET_DATETIME)


@event.listens_for(LoopNode, "before_insert", propagate=True)
def _populate_mysql_non_null_defaults(
    _mapper: object, connection: Connection, target: LoopNode
) -> None:
    """Adapt nullable model values to the production MySQL sentinel schema."""
    values = {
        attribute: getattr(target, attribute) for attribute in _MYSQL_NON_NULL_DEFAULTS
    }
    adapted = adapt_loop_node_values_for_dialect(values, connection.dialect.name)
    for attribute, value in adapted.items():
        setattr(target, attribute, value)
