# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WecodeErpUser model for storing internal user ERP profile information.

This model stores ERP-related profile data (employee_id, department_name, etc.)
that is extracted from CAS login XML and used for org_department entity resolution.

Database DDL (MySQL):
=====================

CREATE TABLE `wecode_erp_user` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `user_id` int NOT NULL DEFAULT '0' COMMENT 'User ID (FK to users.id)',
  `employee_id` varchar(50) NOT NULL DEFAULT '' COMMENT 'ERP employee ID (工号 from CAS username)',
  `department_name` varchar(100) NOT NULL DEFAULT '' COMMENT 'Primary department name (from CAS organization)',
  `erp_name` varchar(100) NOT NULL DEFAULT '' COMMENT 'ERP display name (from CAS erpname or OpenSearch API name)',
  `email` varchar(255) NOT NULL DEFAULT '' COMMENT 'Work email from CAS fullemail',
  `last_synced_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Last profile update timestamp (login time)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wecode_user_profiles_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Wecode user profile cache table';
"""

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped
from sqlalchemy.sql import func

from app.db.base import Base


class WecodeErpUser(Base):
    """User profile with ERP data from CAS login."""

    __tablename__ = "wecode_erp_user"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            name="uniq_wecode_user_profiles_user_id",
        ),
    )

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=False,
        default=0,
        comment="User ID (FK to users.id)",
    )
    employee_id: Mapped[str] = Column(
        String(50),
        nullable=False,
        server_default="",
        comment="ERP employee ID (工号 from CAS username)",
    )
    department_name: Mapped[str] = Column(
        String(100),
        nullable=False,
        server_default="",
        comment="Primary department name (from CAS organization)",
    )
    erp_name: Mapped[str] = Column(
        String(100),
        nullable=False,
        server_default="",
        comment="ERP display name (from CAS erpname or OpenSearch API name)",
    )
    email: Mapped[str] = Column(
        String(255),
        nullable=False,
        server_default="",
        comment="Work email from CAS fullemail",
    )
    last_synced_at: Mapped[DateTime] = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        comment="Last profile update timestamp (login time)",
    )
    created_at: Mapped[DateTime] = Column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[DateTime] = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        return (
            f"<WecodeErpUser(id={self.id}, user_id={self.user_id}, "
            f"employee_id={self.employee_id}, department_name={self.department_name})>"
        )
