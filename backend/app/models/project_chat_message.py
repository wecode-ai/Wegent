# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistent messages for one shared chat timeline per cloud project."""

from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Index, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


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
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
