# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Form submission database model.

Stores form submission records for tracking and auditing purposes.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)

from app.db.base import Base


class FormSubmissionStatus(str, enum.Enum):
    """Status enum for form submissions."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    ERROR = "error"


class FormSubmission(Base):
    """
    FormSubmission model for tracking form submissions.

    Stores form data, context, and processing status for unified form handling.
    """

    __tablename__ = "form_submissions"

    id = Column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
        comment="UUID primary key",
    )
    action_type = Column(
        String(50),
        nullable=False,
        index=True,
        comment="Form action type (clarification, final_prompt, pipeline_confirmation, etc.)",
    )
    form_data = Column(
        JSON,
        nullable=False,
        comment="Form field data submitted by user",
    )
    context = Column(
        JSON,
        nullable=True,
        comment="Submission context (task_id, subtask_id, etc.)",
    )
    status = Column(
        Enum(FormSubmissionStatus),
        nullable=False,
        default=FormSubmissionStatus.PENDING,
        index=True,
        comment="Processing status",
    )
    result = Column(
        JSON,
        nullable=True,
        comment="Processing result data",
    )
    error_message = Column(
        Text,
        nullable=True,
        comment="Error message if processing failed",
    )
    user_id = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=False,
        index=True,
        comment="User ID who submitted the form",
    )
    task_id = Column(
        Integer,
        ForeignKey("tasks.id"),
        nullable=True,
        index=True,
        comment="Associated task ID (if applicable)",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        index=True,
        comment="Submission time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        comment="Last update time",
    )

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
