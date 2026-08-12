# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistent messages for one shared chat timeline per cloud project."""

import hashlib
from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Index,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


def project_chat_message_key(message_id: str, *, deleted: bool = False) -> str:
    """Return a unique non-runtime key for one durable message."""

    namespace = "deleted" if deleted else "message"
    return hashlib.sha256(f"{namespace}\0{message_id}".encode("utf-8")).hexdigest()


class ProjectChatMessage(Base):
    """One durable public message or agent response in a project chat."""

    __tablename__ = "project_chat_messages"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    message_id = Column(String(64), nullable=False)
    client_message_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    project_id = Column(String(64), nullable=False, default="", server_default="")
    task_id = Column(String(64), nullable=False, default="", server_default="")
    sender_type = Column(String(16), nullable=False, default="", server_default="")
    sender_id = Column(String(128), nullable=False, default="", server_default="")
    sender_name = Column(String(255), nullable=False, default="", server_default="")
    message_type = Column(
        String(32), nullable=False, default="text", server_default="text"
    )
    content = Column(Text, nullable=False, default="")
    metadata_json = Column("metadata", JSON, nullable=False, default=dict)
    trigger_message_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    reply_to_message_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    thread_root_message_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    agent_id = Column(String(128), nullable=False, default="", server_default="")
    runtime_device_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    runtime_task_id = Column(String(255), nullable=False, default="", server_default="")
    # One activity message per (runtime device, task, trigger): robot runs use
    # an empty trigger, chat continuations and subagent cards carry their own
    # trigger. The unique index turns "exactly one comment per run" into a
    # database invariant instead of a check-then-insert convention that races
    # across threads. Non-runtime and deleted messages use their message id.
    runtime_activity_key = Column(String(64), nullable=False)
    status = Column(
        String(16), nullable=False, default="completed", server_default="completed"
    )
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )

    __table_args__ = (
        UniqueConstraint("message_id", name="uniq_project_chat_message_id"),
        Index(
            "idx_project_chat_client_message",
            "sender_type",
            "sender_id",
            "client_message_id",
        ),
        Index("idx_project_chat_project_order", "project_id", "id"),
        Index("idx_project_chat_task_order", "task_id", "id"),
        Index("idx_project_chat_thread_order", "thread_root_message_id", "id"),
        Index("idx_project_chat_trigger_agent", "trigger_message_id", "agent_id"),
        Index("idx_project_chat_runtime", "runtime_device_id", "runtime_task_id", "id"),
        Index(
            "uniq_project_chat_runtime_activity",
            "runtime_activity_key",
            unique=True,
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


@event.listens_for(ProjectChatMessage, "before_insert")
def _populate_project_chat_message_key(
    _mapper: object, _connection: object, target: ProjectChatMessage
) -> None:
    """Give every message a unique key without relying on nullable columns."""

    if not target.runtime_activity_key:
        target.runtime_activity_key = project_chat_message_key(target.message_id)
