"""Bounded scalar log snapshots tied to existing SQLAlchemy transactions."""

from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import Session

from shared.event_reporting import is_event_reporting_enabled
from shared.event_reporting.catalogs.knowledge import observe

_KEY = "_knowledge_fact_logs"
_MAX_TRANSACTION_LOGS = 128


def after_commit_fact(db: Session, event_type: str, fields: dict[str, Any]) -> None:
    """No I/O or transaction changes; oversized transaction log batches are dropped."""
    if not is_event_reporting_enabled(event_type):
        return
    try:
        entries = db.info.setdefault(_KEY, [])
        if len(entries) < _MAX_TRANSACTION_LOGS:
            entries.append((event_type, fields))
    except Exception:
        pass


@event.listens_for(Session, "after_commit")
def _emit_committed(db: Session) -> None:
    try:
        if db.in_nested_transaction():
            return
        for event_type, fields in db.info.pop(_KEY, ()):
            observe(event_type, lambda fields=fields: fields)
    except Exception:
        pass


@event.listens_for(Session, "after_rollback")
def _discard_rolled_back(db: Session) -> None:
    # Dropping all logs on a savepoint rollback is conservative but never emits
    # a rolled-back fact. Logging must not become a second transaction manager.
    try:
        db.info.pop(_KEY, None)
    except Exception:
        pass


@event.listens_for(Session, "after_transaction_end")
def _discard_closed(db: Session, transaction: Any) -> None:
    try:
        if transaction.parent is None:
            db.info.pop(_KEY, None)
    except Exception:
        pass
