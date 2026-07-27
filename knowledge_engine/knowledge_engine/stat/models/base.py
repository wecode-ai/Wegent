# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Independent declarative base for stat tables.

Uses a separate Base from the business database to prevent
alembic autogenerate from mixing stat tables into business migrations.
"""

from sqlalchemy.orm import declarative_base

StatBase = declarative_base()
