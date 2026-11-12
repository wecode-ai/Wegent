"""Transaction-scoped best-effort UI publication, including nested savepoints."""

import logging
from collections.abc import Callable

from sqlalchemy import event
from sqlalchemy.orm import Session, SessionTransaction

logger = logging.getLogger(__name__)
_PENDING = "collaboration_after_commit"
_READY = "collaboration_committed"


def queue_after_commit(db: Session, key: str, publish: Callable[[], None]) -> None:
    transaction = db.get_nested_transaction() or db.get_transaction()
    if transaction is None:
        raise RuntimeError("Publication requires an active persistence transaction")
    db.info.setdefault(_PENDING, {}).setdefault(transaction, {})[key] = publish


@event.listens_for(Session, "after_commit")
def _publish_committed(db: Session) -> None:
    transaction = db.get_nested_transaction() or db.get_transaction()
    pending = db.info.get(_PENDING, {})
    publications = pending.pop(transaction, {})
    if transaction is not None and transaction.nested:
        pending.setdefault(transaction.parent, {}).update(publications)
        return
    db.info.pop(_PENDING, None)
    if publications:
        db.info.setdefault(_READY, {})[transaction] = publications


@event.listens_for(Session, "after_transaction_end")
def _publish_after_release(db: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is not None:
        return
    db.info.pop(_PENDING, None)
    # Fresh authority reads must run after the writer's connection is released.
    # This also preserves operation with a one-connection pool.
    publications = db.info.get(_READY, {}).pop(transaction, {})
    if not db.info.get(_READY):
        db.info.pop(_READY, None)
    for key, publish in publications.items():
        try:
            publish()
        except Exception:
            logger.exception("Collaboration publication failed: key=%s", key)


@event.listens_for(Session, "after_rollback")
def _discard_rolled_back(db: Session) -> None:
    transaction = db.get_nested_transaction()
    if transaction is None:
        db.info.pop(_PENDING, None)
        db.info.pop(_READY, None)
    else:
        db.info.get(_PENDING, {}).pop(transaction, None)
