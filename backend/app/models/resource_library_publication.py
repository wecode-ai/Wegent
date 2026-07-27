# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Small indexed projection of user-published marketplace resources."""

from sqlalchemy import Column, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class ResourceLibraryPublication(Base):
    """Index row for one currently published Team or Skill."""

    __tablename__ = "resource_library_publications"

    kind_id = Column(
        Integer,
        primary_key=True,
        autoincrement=False,
        comment="Associated Kind resource ID",
    )
    resource_type = Column(
        String(20),
        nullable=False,
        default="",
        server_default="",
        comment="Resource type: agent or skill",
    )
    install_count = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Cumulative first-time marketplace installations",
    )
    published_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        server_default=func.now(),
        comment="Initial publication time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        server_default=func.now(),
        onupdate=func.now(),
        comment="Resource update time",
    )

    __table_args__ = (
        Index(
            "idx_resource_library_publications_type_updated",
            "resource_type",
            "updated_at",
            "kind_id",
        ),
        Index(
            "idx_resource_library_publications_type_installs",
            "resource_type",
            "install_count",
            "updated_at",
            "kind_id",
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )
