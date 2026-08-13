# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add mr_records.seen_note_ids

Revision ID: 4c8d2a6f0b3e
Revises: 0a3f5b7c9d1e
Create Date: 2026-08-13

Tracks which GitLab note ids the most recent robot run saw when it dispatched.
Comments outside this set are pending feedback: they arrived after the run read
the card, so the state machine must pull the card back for another run instead
of treating them as addressed by the fix (the old round-based exclusion dropped
mid-run comments).
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "4c8d2a6f0b3e"
down_revision: Union[str, Sequence[str], None] = "0a3f5b7c9d1e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mr_records",
        sa.Column(
            "seen_note_ids",
            sa.JSON(),
            nullable=False,
            comment="Note ids the last robot run saw at dispatch; others are pending",
        ),
    )


def downgrade() -> None:
    op.drop_column("mr_records", "seen_note_ids")
