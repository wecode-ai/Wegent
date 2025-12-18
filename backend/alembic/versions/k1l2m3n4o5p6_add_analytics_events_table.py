# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add analytics_events table

Revision ID: k1l2m3n4o5p6
Revises: j0k1l2m3n4o5
Create Date: 2025-12-18 10:00:00.000000+08:00

This migration creates the analytics_events table for tracking user behavior:
- click events: button clicks, link clicks, interactive elements
- page_view events: page navigation tracking
- error events: JavaScript errors, API errors, resource loading failures
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "k1l2m3n4o5p6"
down_revision: Union[str, None] = "j0k1l2m3n4o5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create analytics_events table."""

    # Create event_type enum
    event_type_enum = sa.Enum("click", "page_view", "error", name="event_type_enum")

    # Create analytics_events table
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("event_type", event_type_enum, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("page_url", sa.String(2048), nullable=False),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        # Click event fields
        sa.Column("element_tag", sa.String(50), nullable=True),
        sa.Column("element_id", sa.String(255), nullable=True),
        sa.Column("element_class", sa.String(500), nullable=True),
        sa.Column("element_text", sa.String(100), nullable=True),
        sa.Column("element_href", sa.String(2048), nullable=True),
        sa.Column("data_track_id", sa.String(255), nullable=True),
        # Page view fields
        sa.Column("page_title", sa.String(500), nullable=True),
        sa.Column("referrer", sa.String(2048), nullable=True),
        # Error event fields
        sa.Column("error_type", sa.String(50), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("error_stack", sa.Text(), nullable=True),
        sa.Column("error_source", sa.String(2048), nullable=True),
        sa.Column("error_line", sa.Integer(), nullable=True),
        sa.Column("error_column", sa.Integer(), nullable=True),
        # Metadata
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for efficient querying
    op.create_index(
        "ix_analytics_events_event_type",
        "analytics_events",
        ["event_type"],
    )
    op.create_index(
        "ix_analytics_events_user_id",
        "analytics_events",
        ["user_id"],
    )
    op.create_index(
        "ix_analytics_events_timestamp",
        "analytics_events",
        ["timestamp"],
    )
    op.create_index(
        "ix_analytics_events_data_track_id",
        "analytics_events",
        ["data_track_id"],
    )
    op.create_index(
        "ix_analytics_events_error_type",
        "analytics_events",
        ["error_type"],
    )
    op.create_index(
        "ix_analytics_events_created_at",
        "analytics_events",
        ["created_at"],
    )


def downgrade() -> None:
    """Drop analytics_events table."""

    # Drop indexes
    op.drop_index("ix_analytics_events_created_at", table_name="analytics_events")
    op.drop_index("ix_analytics_events_error_type", table_name="analytics_events")
    op.drop_index("ix_analytics_events_data_track_id", table_name="analytics_events")
    op.drop_index("ix_analytics_events_timestamp", table_name="analytics_events")
    op.drop_index("ix_analytics_events_user_id", table_name="analytics_events")
    op.drop_index("ix_analytics_events_event_type", table_name="analytics_events")

    # Drop table
    op.drop_table("analytics_events")

    # Drop enum type
    op.execute("DROP TYPE IF EXISTS event_type_enum")
