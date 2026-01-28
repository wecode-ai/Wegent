# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission request model for knowledge base access approval workflow.

Provides storage for permission requests that require approval from resource owners.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import (
    Column,
    DateTime,
)
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import (
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base


class PermissionRequestStatus(str, PyEnum):
    """Status of a permission request."""

    PENDING = "pending"  # Waiting for approval
    APPROVED = "approved"  # Request approved
    REJECTED = "rejected"  # Request rejected
    CANCELLED = "cancelled"  # Request cancelled by applicant
    EXPIRED = "expired"  # Request expired (resource deleted)


class PermissionRequest(Base):
    """
    Permission request record table.

    Stores permission requests for resources like knowledge bases.
    Supports the approval workflow for sharing resources.
    """

    __tablename__ = "permission_requests"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Kind.id - the resource being requested
    kind_id = Column(Integer, nullable=False, index=True)
    # Resource type for future extensibility (e.g., "knowledge_base", "team", etc.)
    resource_type = Column(String(50), nullable=False, default="knowledge_base")
    # User who is requesting permission
    applicant_user_id = Column(Integer, nullable=False, index=True)
    # Requested permission level: read, download, write, manage
    requested_permission_type = Column(String(20), nullable=False, default="read")
    # Reason for the request (provided by applicant)
    request_reason = Column(Text, nullable=True)
    # Request status
    status = Column(
        SQLEnum(
            PermissionRequestStatus, values_callable=lambda obj: [e.value for e in obj]
        ),
        nullable=False,
        default=PermissionRequestStatus.PENDING,
    )
    # User who processed the request (approver/rejector)
    processed_by_user_id = Column(Integer, nullable=True)
    # When the request was processed
    processed_at = Column(DateTime, nullable=True)
    # Response message from the processor (optional)
    response_message = Column(Text, nullable=True)
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        # Ensure only one pending request per user per resource
        UniqueConstraint(
            "kind_id",
            "resource_type",
            "applicant_user_id",
            "status",
            name="uq_permission_request_pending",
        ),
        # Index for efficient lookup of pending requests for a resource
        Index("ix_permission_requests_kb_status", "kind_id", "status"),
        # Index for user's requests
        Index("ix_permission_requests_applicant", "applicant_user_id", "status"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Permission request table for resource access approval workflow",
        },
    )
