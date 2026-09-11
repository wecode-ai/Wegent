# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace aggregate and shared capability bindings."""

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class Workspace(Base):
    """Long-lived collaboration and authorization boundary."""

    __tablename__ = "collaboration_workspaces"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    public_id = Column(String(36), nullable=False, unique=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=False, default="")
    created_by_user_id = Column(Integer, nullable=False, index=True)
    is_default = Column(Boolean, nullable=False, default=False, server_default="0")
    status = Column(
        String(16), nullable=False, default="active", server_default="active"
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "idx_collaboration_workspaces_owner_status",
            "created_by_user_id",
            "status",
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class WorkspaceAgentBinding(Base):
    """Authorize one Wegent Team as an Agent inside a Workspace."""

    __tablename__ = "workspace_agent_bindings"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    workspace_id = Column(
        big_integer_id_type(),
        ForeignKey("collaboration_workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    team_id = Column(
        Integer,
        ForeignKey("kinds.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_type = Column(
        String(16), nullable=False, default="human", server_default="human"
    )
    owner_user_id = Column(Integer, nullable=True)
    added_by_user_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "team_id",
            name="uniq_workspace_agent_team",
        ),
        Index("idx_workspace_agents_owner", "owner_type", "owner_user_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class WorkspaceExecutionEnvironment(Base):
    """Authorize one Device/Runtime record for Workspace executions."""

    __tablename__ = "workspace_execution_environments"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    workspace_id = Column(
        big_integer_id_type(),
        ForeignKey("collaboration_workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    device_id = Column(
        Integer,
        ForeignKey("kinds.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_type = Column(
        String(16), nullable=False, default="human", server_default="human"
    )
    owner_user_id = Column(Integer, nullable=True)
    added_by_user_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "device_id",
            name="uniq_workspace_execution_environment_device",
        ),
        Index(
            "idx_workspace_execution_environments_workspace",
            "workspace_id",
            "created_at",
        ),
        Index(
            "idx_workspace_execution_environments_owner",
            "owner_type",
            "owner_user_id",
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
