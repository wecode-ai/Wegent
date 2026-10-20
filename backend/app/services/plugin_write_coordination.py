"""Transaction-scoped coordination for authentication and plugin installations.

Redis serializes plugin writes without locking the shared users row. A durable
commit fence prevents a paused worker from committing after its lease expires
and a successor takes ownership. Ordinary database writes still use InnoDB's
transactional locks; no SELECT FOR UPDATE is needed for coordination.
"""

import logging
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException
from redis.exceptions import RedisError
from sqlalchemy import event, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, SessionTransaction

from app.api.dependencies import get_db
from app.services.plugin_write_resources import fence_engine, redis_client

logger = logging.getLogger(__name__)

LEASE_SECONDS = 30
WAIT_SECONDS = 3
RENEW_SECONDS = 10
_LEASES = "plugin_write_leases"
_CONFIGURED = "plugin_write_read_committed"


class PluginWriteError(HTTPException):
    """Client-safe, retryable coordination failure."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(
            status_code=503, detail=code, headers={"Cache-Control": "no-store"}
        )


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


def _engine(db: Session) -> Engine:
    bind = db.get_bind()
    return bind.engine if isinstance(bind, Connection) else bind


def _claim_fence(db: Session, user_id: int, token: str) -> None:
    """Publish ownership independently of the pending business transaction."""
    with fence_engine(_engine(db)).begin() as connection:
        suffix = (
            "ON DUPLICATE KEY UPDATE token = VALUES(token)"
            if connection.dialect.name == "mysql"
            else "ON CONFLICT(user_id) DO UPDATE SET token = excluded.token"
        )
        connection.execute(
            text(
                "INSERT INTO plugin_write_fences (user_id, token) "
                f"VALUES (:user_id, :token) {suffix}"
            ),
            {"user_id": user_id, "token": token},
        )


def _check_commit_fence(db: Session, user_id: int, token: str) -> None:
    """Fence the last database statement against successors' ownership."""
    values = {"user_id": user_id, "token": token, "committed": f"{token}:committed"}
    result = db.execute(
        text(
            "UPDATE plugin_write_fences SET token = :committed "
            "WHERE user_id = :user_id AND token = :token"
        ),
        values,
    )
    # Changing the value makes both matched-row and changed-row drivers agree.
    if result.rowcount != 1:
        raise PluginWriteError("plugin_write_lease_lost")


@dataclass
class _Lease:
    lock: Any
    token: str
    stopped: threading.Event = field(default_factory=threading.Event)
    lost: threading.Event = field(default_factory=threading.Event)

    def renew(self) -> None:
        while not self.stopped.wait(RENEW_SECONDS):
            try:
                if not self.lock.reacquire():
                    self.lost.set()
                    return
            except Exception:
                self.lost.set()
                return

    def check(self) -> None:
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
    threading.Thread(target=lease.renew, daemon=True).start()
    try:
        _claim_fence(db, user_id, token)
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
            "Plugin write coordination failed stage=fence_claim "
            "user_id=%s error_type=%s db_errno=%s",
            user_id,
            type(exc).__name__,
            errno,
        )
        raise PluginWriteError("plugin_write_unavailable") from None
    except Exception:
        lease.release()
        raise


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
    for user_id, lease in sorted(leases.items()):
        lease.check()
        _check_commit_fence(db, user_id, lease.token)


@event.listens_for(Session, "after_transaction_end")
def _release_transaction(db: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is not None:
        return
    for lease in db.info.pop(_LEASES, {}).values():
        lease.release()
