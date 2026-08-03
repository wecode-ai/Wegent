# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Read-only database session factory for business database queries.

Collector queries run against a read replica to avoid impacting
the primary database's online traffic (especially subtask_contexts
which is latency-sensitive for chat).

Configuration via environment variables (priority order):
1. DATABASE_READONLY_URL - read replica
2. DATABASE_URL - primary database (fallback)

Only initialized in knowledge_runtime process; backend never imports this module.
"""

import os
from typing import Optional

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

# Module-level engine and session factory (lazily initialized)
_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def resolve_readonly_database_url() -> str:
    """Resolve read-only database URL, falling back to primary."""
    return os.getenv("DATABASE_READONLY_URL") or os.getenv("DATABASE_URL") or ""


def init_readonly_db(database_url: Optional[str] = None) -> None:
    """Initialize the read-only database engine and session factory."""
    global _engine, _SessionLocal

    url = database_url or resolve_readonly_database_url()
    if not url:
        raise RuntimeError("No database URL resolved for readonly")

    # SQLite (used in tests) does not accept the MySQL connect_args below and
    # does not support ``SET SESSION TRANSACTION READ ONLY``; detect it so the
    # readonly guarantees degrade to the application-level guard only there.
    is_sqlite = url.startswith("sqlite")
    connect_args = {} if is_sqlite else {"charset": "utf8mb4"}

    _engine = create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args=connect_args,
    )

    # Force every connection to UTC so DATE(created_at) in collector SQL
    # resolves to the UTC calendar day regardless of the host's local tz.
    # This must mirror stat_session's hook — otherwise naive datetimes read
    # from the business DB are interpreted in different time zones on the
    # read vs write side, shifting stat_date boundaries by the tz offset.
    @event.listens_for(_engine, "connect")
    def _force_utc(dbapi_conn, _):  # noqa: ANN001
        cursor = dbapi_conn.cursor()
        if not is_sqlite:
            cursor.execute("SET time_zone = '+00:00'")
            # DB-layer readonly: rejects any write/DDL even if a future caller
            # bypasses the application guard. Mirrors the module's name — the
            # previous implementation enforced readonly only by caller
            # convention, so a stray ``.add()``/``execute(UPDATE)`` could
            # silently land on the business primary DB.
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
        cursor.close()

    # Application-layer readonly: defense-in-depth that raises before the
    # statement reaches the DB. Catches accidental writes regardless of
    # whether the engine points at a read replica or the primary, and gives a
    # clear stack trace at the offending call site instead of a cryptic
    # driver error or — worse — a silent write to the primary.
    @event.listens_for(_engine, "before_cursor_execute")
    def _reject_writes(  # noqa: ANN001
        conn, cursor, statement, params, context, executemany
    ):
        if not isinstance(statement, str):
            return
        stripped = statement.lstrip()
        # ``leading`` is the first word, uppercased; cheap and dialect-neutral.
        leading = stripped.split(None, 1)[0].upper() if stripped else ""
        # ``WITH`` may wrap a write CTE, and ``CREATE/DROP`` may carry a
        # ``TEMPORARY``/``IF NOT EXISTS`` qualifier — check the first two
        # tokens for those cases.
        head2 = " ".join(stripped.split(None, 2)[:2]).upper() if stripped else ""
        write_prefixes = (
            "INSERT",
            "UPDATE",
            "DELETE",
            "REPLACE",
            "MERGE",
            "TRUNCATE",
            "DROP",
            "GRANT",
            "REVOKE",
            "LOAD",
        )
        if (
            leading in write_prefixes
            or leading in ("CREATE", "ALTER")
            or head2.startswith(("CREATE ", "ALTER "))
        ):
            raise RuntimeError(
                "readonly_session does not permit write statements: " + stripped[:80]
            )

    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


def get_readonly_engine() -> Engine:
    """Get the read-only database engine, initializing if needed."""
    global _engine
    if _engine is None:
        init_readonly_db()
    return _engine


def get_readonly_session_factory() -> sessionmaker:
    """Get the read-only session factory, initializing if needed."""
    global _SessionLocal
    if _SessionLocal is None:
        init_readonly_db()
    return _SessionLocal


def get_readonly_session() -> Session:
    """Create a new read-only database session."""
    return get_readonly_session_factory()()
