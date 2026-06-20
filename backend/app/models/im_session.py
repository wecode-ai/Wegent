# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistent private IM session state."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base


class IMSessionMode:
    """Private IM session modes."""

    CHAT = "chat"
    TASK = "task"


class IMSessionState:
    """Private IM session transient states."""

    IDLE = "idle"
    PENDING_TASK_SWITCH = "pending_task_switch"
    PENDING_TASK_CREATION = "pending_task_creation"


class IMPrivateSession(Base):
    """A user-owned private conversation with one IM provider channel."""

    __tablename__ = "im_private_sessions"

    id = Column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    user_id = Column(Integer, nullable=False, index=True)
    channel_type = Column(String(32), nullable=False)
    channel_id = Column(Integer, nullable=False, index=True)
    conversation_id = Column(String(255), nullable=False)
    sender_id = Column(String(255), nullable=False, default="")
    display_name = Column(String(255), nullable=False, default="")
    mode = Column(String(16), nullable=False, default=IMSessionMode.CHAT)
    state = Column(String(32), nullable=False, default=IMSessionState.IDLE)
    active_task_id = Column(
        BigInteger().with_variant(Integer, "sqlite"),
        nullable=True,
        index=True,
    )
    pending_payload = Column(JSON, nullable=False, default=dict)
    state_expires_at = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, nullable=False, default=datetime.now)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "channel_type",
            "channel_id",
            "conversation_id",
            "user_id",
            name="uniq_im_private_session_identity",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
