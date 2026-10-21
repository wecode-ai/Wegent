"""Transaction-scoped coordination for authentication and plugin installations.

Redis serializes plugin writes without locking the shared users row. A CAS on
the existing account-auth policy's revision protects the whole transaction
against a successor's committed changes. Ordinary database writes still use
InnoDB's transactional locks; no SELECT FOR UPDATE is used for coordination.
"""

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends
from redis.exceptions import RedisError
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, SessionTransaction

from app.api.dependencies import get_db
from app.services.plugin_policy_revision import (
    PolicyRevision,
    advance_policy_revision,
    read_policy_revision,
)
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_resources import redis_client

logger = logging.getLogger(__name__)

LEASE_SECONDS = 30
WAIT_SECONDS = 3
RENEW_SECONDS = 10
OPERATION_SECONDS = 20
_LEASES = "plugin_write_leases"
_CONFIGURED = "plugin_write_read_committed"
_SAVEPOINTS = "plugin_policy_savepoint_revisions"


def _redis_client() -> Any:
    return redis_client()


def configure_plugin_session(db: Session) -> None:
    """Use fresh committed reads, including reads after waiting for Redis."""
    if db.info.get(_CONFIGURED):
        return
    bind = db.get_bind()
    if bind.dialect.name == "mysql":
        if db.in_transaction():
            raise RuntimeError("Configure the plugin session before its first query")
        if isinstance(bind, Engine):
            db.bind = bind.execution_options(isolation_level="READ COMMITTED")
        else:
            bind.execution_options(isolation_level="READ COMMITTED")
    db.info[_CONFIGURED] = True


def get_plugin_db(db: Session = Depends(get_db)) -> Session:
    """Share the request's authenticated session, configured before auth reads."""
    configure_plugin_session(db)
    return db


@dataclass
class _Lease:
    lock: Any
    token: str
    policy: PolicyRevision | None = None
    started: float = field(default_factory=time.monotonic)
    stopped: threading.Event = field(default_factory=threading.Event)
    lost: threading.Event = field(default_factory=threading.Event)

    def renew(self) -> None:
        while not self.stopped.wait(RENEW_SECONDS):
            if time.monotonic() - self.started >= OPERATION_SECONDS:
                self.lost.set()
                return
            try:
                if not self.lock.reacquire():
                    self.lost.set()
                    return
            except Exception:
                self.lost.set()
                return

    def check(self) -> None:
        if time.monotonic() - self.started >= OPERATION_SECONDS:
            self.lost.set()
            raise PluginWriteError("plugin_write_lease_lost")
        if self.lost.is_set():
            raise PluginWriteError("plugin_write_lease_lost")
        try:
            owned = self.lock.owned()
        except RedisError:
            self.lost.set()
            raise PluginWriteError("plugin_write_unavailable") from None
        if not owned:
            self.lost.set()
            raise PluginWriteError("plugin_write_lease_lost")

    def release(self) -> None:
        self.stopped.set()
        try:
            self.lock.release()
        except Exception:
            # A release failure must not turn an already committed write into
            # a reported failure. Token checks and expiry protect a successor.
            logger.warning("Plugin write lease release failed")


def acquire_plugin_write_lock(db: Session, user_id: int) -> None:
    """Acquire once per user/root transaction; release only at its end."""
    configure_plugin_session(db)
    leases: dict[int, _Lease] = db.info.setdefault(_LEASES, {})
    if user_id in leases:
        leases[user_id].check()
        return
    token = uuid.uuid4().hex
    try:
        lock = _redis_client().lock(
            f"wegent:plugin-write:{user_id}",
            timeout=LEASE_SECONDS,
            blocking_timeout=WAIT_SECONDS,
            thread_local=False,
        )
        acquired = lock.acquire(token=token)
    except RedisError:
        raise PluginWriteError("plugin_write_unavailable") from None
    if not acquired:
        raise PluginWriteError("plugin_write_busy")
    lease = _Lease(lock=lock, token=token)
    try:
        threading.Thread(target=lease.renew, daemon=True).start()
        lease.policy = read_policy_revision(db, user_id)
        lease.check()
        if not db.in_transaction():
            db.begin()
        if not (db.new or db.dirty or db.deleted):
            db.expire_all()
        leases[user_id] = lease
    except SQLAlchemyError as exc:
        lease.release()
        original = getattr(exc, "orig", None)
        args = getattr(original, "args", ())
        errno = args[0] if args and isinstance(args[0], int) else None
        logger.warning(
            "Plugin write coordination failed stage=policy_revision "
            "user_id=%s error_type=%s db_errno=%s",
            user_id,
            type(exc).__name__,
            errno,
        )
        raise PluginWriteError("plugin_write_unavailable") from None
    except Exception:
        lease.release()
        raise


def configure_auth_policy(db: Session, user_id: int, enabled: bool) -> None:
    """Change the real parent policy without ever overwriting its CAS version."""
    acquire_plugin_write_lock(db, user_id)
    policy = db.info[_LEASES][user_id].policy
    assert policy is not None
    nested = db.get_nested_transaction()
    while nested is not None and nested.nested:
        versions = db.info.setdefault(_SAVEPOINTS, {}).setdefault(nested, {})
        versions.setdefault(user_id, policy.revision)
        nested = nested.parent
    advance_policy_revision(db, policy, enabled=enabled)


@event.listens_for(Session, "after_soft_rollback")
def _restore_policy_revision(db: Session, previous: SessionTransaction) -> None:
    """A savepoint rollback restores the database and its expected versions."""
    versions = db.info.get(_SAVEPOINTS, {}).pop(previous, {})
    leases = db.info.get(_LEASES, {})
    for user_id, revision in versions.items():
        lease = leases.get(user_id)
        if lease is not None and lease.policy is not None:
            lease.policy.revision = revision


@event.listens_for(Session, "before_flush")
def _guard_flush(db: Session, _context: Any, _instances: Any) -> None:
    for lease in db.info.get(_LEASES, {}).values():
        lease.check()


@event.listens_for(Session, "before_commit")
def _guard_commit(db: Session) -> None:
    leases: dict[int, _Lease] = db.info.get(_LEASES, {})
    if not leases or db.in_nested_transaction():
        return
    db.flush()
    for _, lease in sorted(leases.items()):
        lease.check()
        assert lease.policy is not None
        advance_policy_revision(db, lease.policy)


@event.listens_for(Session, "after_transaction_end")
def _release_transaction(db: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is not None:
        return
    db.info.pop(_SAVEPOINTS, None)
    for lease in db.info.pop(_LEASES, {}).values():
        lease.release()
