# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Impersonation models for admin user impersonation feature.
"""

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class ImpersonationRequest(Base):
    """Model for storing impersonation requests from admin users."""

    __tablename__ = "impersonation_requests"

    id = Column(Integer, primary_key=True, index=True)
    admin_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    target_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(
        String(20), nullable=False, default="pending"
    )  # pending, approved, rejected, expired, used
    expires_at = Column(DateTime, nullable=False)
    approved_at = Column(DateTime, nullable=True)
    session_expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    admin_user = relationship(
        "User", foreign_keys=[admin_user_id], backref="impersonation_requests_as_admin"
    )
    target_user = relationship(
        "User", foreign_keys=[target_user_id], backref="impersonation_requests_as_target"
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ImpersonationAuditLog(Base):
    """Model for storing audit logs during impersonation sessions."""

    __tablename__ = "impersonation_audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    impersonation_request_id = Column(
        Integer, ForeignKey("impersonation_requests.id"), nullable=False, index=True
    )
    admin_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    target_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    action = Column(String(50), nullable=False)  # e.g., api_call, page_view
    method = Column(String(10), nullable=False)  # HTTP method
    path = Column(String(500), nullable=False)
    request_body = Column(Text, nullable=True)
    ip_address = Column(String(50), nullable=True)
    user_agent = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=func.now())

    # Relationships
    impersonation_request = relationship(
        "ImpersonationRequest", backref="audit_logs"
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
