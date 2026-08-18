# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Merge the execution-sentinel and MR integration migration heads.

Revision ID: 865bc4a6ffe3
Revises: 0c5cf69f98fb, a3b4c5d6e7f8
Create Date: 2026-08-18 10:26:50.985284+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "865bc4a6ffe3"
down_revision: Union[str, Sequence[str], None] = ("0c5cf69f98fb", "a3b4c5d6e7f8")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
