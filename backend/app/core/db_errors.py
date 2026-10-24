# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Classify database errors that are safe to retry."""

from sqlalchemy.exc import OperationalError

MYSQL_DEADLOCK_ERROR = 1213


def is_mysql_deadlock(error: OperationalError) -> bool:
    """Return whether ``error`` is MySQL's "deadlock found" (1213).

    MySQL asks the client to restart the transaction when a deadlock is
    detected, so callers may retry the whole unit of work instead of failing
    the request with a 500.
    """
    original = error.orig
    args = getattr(original, "args", ())
    return bool(args) and args[0] == MYSQL_DEADLOCK_ERROR
