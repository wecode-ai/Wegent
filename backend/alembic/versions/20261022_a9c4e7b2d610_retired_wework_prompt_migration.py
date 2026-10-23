# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Retain the retired Wework prompt revision without changing application data.

Revision ID: a9c4e7b2d610
Revises: f3a7c9e1b2d4
Create Date: 2026-10-22

An earlier PR version rewrote a built-in Ghost prompt. That data migration is
withdrawn. Keep its revision identity so databases already stamped or upgraded
to it remain readable. Neither direction edits or restores Ghost configuration;
artifact delivery instructions are injected by the executor at execution time.
"""

revision = "a9c4e7b2d610"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Retain version history without reading or writing application data."""
    pass


def downgrade() -> None:
    """Leave all existing prompts, including previously migrated ones, intact."""
    pass
