# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database-session timezone helpers."""

from datetime import datetime, timedelta, timezone

from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import Session

MYSQL_SESSION_TIMEZONE_OFFSET = "+08:00"
MYSQL_SESSION_TIMEZONE = timezone(timedelta(hours=8))


def database_datetime_timezone(db: Session) -> timezone:
    """Return the timezone used for naive datetimes read from this session."""
    bind = None
    try:
        if isinstance(db, AsyncSession):
            # Prefer the bound AsyncEngine's sync dialect: mocked sessions in
            # tests may return a coroutine from get_bind().
            bound = db.bind
            bind = bound.sync_engine if isinstance(bound, AsyncEngine) else None
        else:
            bind = db.get_bind()
    except Exception:
        # Session wrappers and mocks without a resolvable bind: fall back to
        # the production (MySQL) basis.
        bind = None
    # bind may be an Engine or a Connection; both expose .dialect.
    dialect = getattr(bind, "dialect", None)
    if dialect is not None and dialect.name == "sqlite":
        return timezone.utc
    return MYSQL_SESSION_TIMEZONE


def db_now(db: Session) -> datetime:
    """Naive datetime on the same basis as database-generated values.

    MySQL sessions are pinned to +08:00, so database-generated values are +8
    naive; SQLite (unit tests) generates UTC naive. Test fixtures must use
    the same basis (UTC on SQLite, +08:00 on MySQL).

    Use this helper for any value that will be compared with database
    datetime columns. Prefer SQL-side func.now() comparisons when precision
    to the second matters, since this helper uses the application process
    clock.
    """
    return datetime.now(database_datetime_timezone(db)).replace(tzinfo=None)


def db_now_iso() -> str:
    """Timezone-aware +08:00 ISO timestamp for outbound (WS/SSE) payloads.

    Outbound timestamps must carry their offset so consumers never have to
    guess the basis; +08:00 matches the MySQL session time zone.
    """
    return datetime.now(MYSQL_SESSION_TIMEZONE).isoformat()
