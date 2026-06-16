# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared SQLAlchemy column types."""

from sqlalchemy import BigInteger, Integer


def big_integer_id_type() -> BigInteger:
    """Return BIGINT with SQLite INTEGER affinity for autoincrement primary keys."""
    return BigInteger().with_variant(Integer, "sqlite")
