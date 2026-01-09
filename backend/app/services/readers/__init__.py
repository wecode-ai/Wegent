# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Readers package - read-only queries with optional caching.

This package provides reader instances for database resources.
Each module supports optional extension via SERVICE_EXTENSION env var.

Usage:
    from app.services.readers.kinds import kindReader, KindType
    from app.services.readers.users import userReader

    bot = kindReader.get_by_name_and_namespace(db, user_id, KindType.BOT, "default", "mybot")
    user = userReader.get_by_id(db, user_id)
"""

from app.services.readers.kinds import KindType, kindReader
from app.services.readers.users import userReader

__all__ = [
    "kindReader",
    "userReader",
    "KindType",
]
