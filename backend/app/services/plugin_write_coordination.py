"""Transaction-scoped coordination for authentication and plugin installations.

Redis serializes one account installation across all devices. The installation's
write revision fences its dependent authentication and device records. No
SELECT FOR UPDATE or account-wide plugin lease is used for ordinary writes.
"""

import logging
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends
from redis.exceptions import RedisError
from sqlalchemy import event, func
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, SessionTransaction
from sqlalchemy.orm.attributes import set_committed_value

from app.api.dependencies import get_db
from app.core.distributed_lock import (
    DistributedLockUnavailableError,
    distributed_lock,
)
from app.models.kind import Kind
from app.services.plugin_policy_revision import (
    PolicyRevision,
    advance_policy_revision,
    read_policy_revision,
    validate_policy_revision,
)
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_resources import redis_client as _redis_client
from app.services.plugin_write_revision import (
    PluginWriteRevision,
    advance_creation_revision,
    advance_plugin_revision,
    read_creation_revision,
    read_plugin_revisions,
    write_revision,
)

logger = logging.getLogger(__name__)

LEASE_SECONDS = 30
WAIT_SECONDS = 3
RENEW_SECONDS = 10
OPERATION_SECONDS = 20
_LEASES = "plugin_write_leases"
_CONFIGURED = "plugin_write_read_committed"
_SAVEPOINTS = "plugin_policy_savepoint_revisions"
_REVISIONS = "plugin_installation_write_revisions"
_NEW_INSTALLS = "plugin_new_installations"
_CREATIONS = "plugin_creation_revisions"
_DESIRED_CHANGED = "plugin_desired_changed"


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
    policy: PolicyRevision | None = None
    scope: str = ""
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


def acquire_plugin_write_lock(
    db: Session,
    user_id: int,
    *,
    installed_id: int | None = None,
    name: str | None = None,
) -> None:
    """Acquire one installation's lease, including inactive reinstall records."""
    configure_plugin_session(db)
    if installed_id is not None:
        from app.services.plugin_write_identity import installed_write_name

        name = installed_write_name(db, user_id, installed_id)
    if name is None:
        raise ValueError("Plugin coordination requires an explicit installation")
    _acquire_plugin_write_lock(db, user_id, name=name, blocking_timeout=WAIT_SECONDS)
    if installed_id is not None:
        if installed_write_name(
            db, user_id, installed_id
        ) != name or installed_id not in db.info.get(_REVISIONS, {}):
            raise PluginWriteError("plugin_write_conflict")


def _release_plugin_write_lease(db: Session, user_id: int, lease: _Lease) -> None:
    logger.info(
        "Plugin write lease releasing user_id=%s session_id=%s "
        "operation=%s held_ms=%d plugin_scope=%s",
        user_id,
        id(db),
        db.info.get("plugin_write_operation", "request"),
        int((time.monotonic() - lease.started) * 1000),
        lease.scope,
    )
    lease.release()


def acquire_plugin_write_locks(
    db: Session, installations: Iterable[tuple[int, int]]
) -> None:
    """Acquire a batch before business writes, sharing one coordination budget."""
    from app.services.plugin_write_identity import installed_write_name

    configure_plugin_session(db)
    requested = {
        (user_id, installed_id): installed_write_name(db, user_id, installed_id)
        for user_id, installed_id in installations
    }
    targets = sorted({(user_id, name) for (user_id, _), name in requested.items()})
    if not targets:
        return
    deadline = time.monotonic() + WAIT_SECONDS
    leases: dict[tuple[int, str], _Lease] = db.info.get(_LEASES, {})
    if leases:
        deadline = min(
            deadline,
            min(lease.started + OPERATION_SECONDS for lease in leases.values()),
        )
    try:
        for user_id, name in targets:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PluginWriteError("plugin_write_busy")
            _acquire_plugin_write_lock(
                db,
                user_id,
                name=name,
                blocking_timeout=remaining if len(targets) == 1 else 0,
            )
        if time.monotonic() >= deadline:
            raise PluginWriteError("plugin_write_busy")
        for lease in db.info.get(_LEASES, {}).values():
            lease.check()
        for (user_id, installed_id), name in requested.items():
            if installed_write_name(
                db, user_id, installed_id
            ) != name or installed_id not in db.info.get(_REVISIONS, {}):
                raise PluginWriteError("plugin_write_conflict")
    except Exception:
        # Policy reads can reactivate rows. Roll back before releasing any lease.
        db.rollback()
        raise


def _acquire_plugin_write_lock(
    db: Session, user_id: int, *, name: str, blocking_timeout: float
) -> None:
    configure_plugin_session(db)
    leases: dict[tuple[int, str], _Lease] = db.info.setdefault(_LEASES, {})
    identity = (user_id, name)
    if identity in leases:
        _recapture_revisions(db)
        leases[identity].check()
        return
    try:
        lock = distributed_lock.owned_lock(
            f"wegent:plugin-write:{user_id}:{name}",
            expire_seconds=LEASE_SECONDS,
            blocking_timeout=blocking_timeout,
            redis_client=_redis_client(),
        )
        acquired = lock.acquire()
    except (RedisError, DistributedLockUnavailableError):
        raise PluginWriteError("plugin_write_unavailable") from None
    if not acquired:
        logger.warning(
            "Plugin write coordination rejected stage=acquire "
            "user_id=%s session_id=%s operation=%s plugin_scope=%s",
            user_id,
            id(db),
            db.info.get("plugin_write_operation", "request"),
            name,
        )
        raise PluginWriteError("plugin_write_busy")
    logger.info(
        "Plugin write lease acquired user_id=%s session_id=%s operation=%s plugin_scope=%s",
        user_id,
        id(db),
        db.info.get("plugin_write_operation", "request"),
        name,
    )
    lease = _Lease(lock=lock)
    lease.scope = name
    leases[identity] = lease
    try:
        threading.Thread(target=lease.renew, daemon=True).start()
        if name == "@account-policy":
            lease.policy = read_policy_revision(db, user_id)
        else:
            revisions = db.info.setdefault(_REVISIONS, {})
            parents = read_plugin_revisions(db, user_id, name)
            for row_id, expected in parents.items():
                revisions.setdefault(row_id, expected)
            if not parents and not name.startswith("@"):
                db.info.setdefault(_CREATIONS, {}).setdefault(
                    (user_id, name), read_creation_revision(db, user_id, name)
                )
        lease.check()
        if not (db.new or db.dirty or db.deleted):
            db.expire_all()
        leases[identity] = lease
    except SQLAlchemyError as exc:
        leases.pop(identity, None)
        _release_plugin_write_lease(db, user_id, lease)
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
        leases.pop(identity, None)
        _release_plugin_write_lease(db, user_id, lease)
        raise


def configure_auth_policy(db: Session, user_id: int, enabled: bool) -> None:
    """Change the real parent policy without ever overwriting its CAS version."""
    acquire_plugin_write_lock(db, user_id, name="@account-policy")
    policy = db.info[_LEASES][(user_id, "@account-policy")].policy
    assert policy is not None
    nested = db.get_nested_transaction()
    while nested is not None and nested.nested:
        versions = db.info.setdefault(_SAVEPOINTS, {}).setdefault(nested, {})
        versions.setdefault(user_id, policy.revision)
        nested = nested.parent
    advance_policy_revision(db, policy, enabled=enabled)
    if user_id in db.info.get("plugin_auth_policy_fences", {}):
        db.info["plugin_auth_policy_fences"][user_id] = policy


@event.listens_for(Session, "after_soft_rollback")
def _restore_policy_revision(db: Session, previous: SessionTransaction) -> None:
    """A savepoint rollback restores the database and its expected versions."""
    versions = db.info.get(_SAVEPOINTS, {}).pop(previous, {})
    leases = db.info.get(_LEASES, {})
    for user_id, revision in versions.items():
        lease = leases.get((user_id, "@account-policy"))
        if lease is not None and lease.policy is not None:
            lease.policy.revision = revision
    frame = db.info.get("plugin_coordination_savepoints", {}).pop(previous, None)
    if frame is not None:
        for key, value in frame.items():
            if value is None:
                db.info.pop(key, None)
            else:
                db.info[key] = value
        db.info["plugin_revision_recapture"] = True


def _recapture_revisions(db: Session) -> None:
    if not db.info.pop("plugin_revision_recapture", False):
        return
    revisions = db.info.setdefault(_REVISIONS, {})
    for (user_id, name), lease in db.info.get(_LEASES, {}).items():
        if name not in {
            "@account-policy",
            "@sync-init",
            "@empty",
        } and not name.startswith("@operation:"):
            parents = read_plugin_revisions(db, user_id, name)
            for row_id, expected in parents.items():
                revisions.setdefault(row_id, expected)
            if not parents and not name.startswith("@"):
                db.info.setdefault(_CREATIONS, {}).setdefault(
                    (user_id, name), read_creation_revision(db, user_id, name)
                )


@event.listens_for(Session, "after_transaction_create")
def _remember_savepoint(db: Session, transaction: SessionTransaction) -> None:
    if not transaction.nested:
        return
    from copy import deepcopy

    keys = (
        _REVISIONS,
        _CREATIONS,
        _DESIRED_CHANGED,
        "plugin_auth_policy_fences",
        "plugin_sync_expected_revisions",
        "plugin_sync_original_documents",
        "plugin_sync_merge_rows",
    )
    frame = {key: deepcopy(db.info.get(key)) for key in keys}
    frame[_NEW_INSTALLS] = list(db.info.get(_NEW_INSTALLS, []))
    db.info.setdefault("plugin_coordination_savepoints", {})[transaction] = frame


@event.listens_for(Session, "before_flush")
def _guard_flush(db: Session, _context: Any, _instances: Any) -> None:
    from app.services.plugin_sync_revision import flush_sync_revision

    _recapture_revisions(db)
    for lease in db.info.get(_LEASES, {}).values():
        lease.check()
    for row in list(db.dirty):
        if (
            isinstance(row, Kind)
            and db.info.get(_CONFIGURED)
            and (
                row.id in db.info.get("plugin_sync_expected_revisions", {})
                or db.info.get(_LEASES)
            )
            and row.kind == "PluginSyncState"
            and row.namespace == "plugin-sync"
            and row.name == "account"
        ):
            flush_sync_revision(db, row)
    if not db.info.get(_LEASES):
        return
    for row in list(db.new):
        if isinstance(row, Kind) and row.kind == "InstalledPlugin":
            db.info.setdefault(_NEW_INSTALLS, []).append(row)
            db.info[_DESIRED_CHANGED] = True
    for row in list(db.dirty):
        if not isinstance(row, Kind) or row.kind != "InstalledPlugin":
            continue
        expected = db.info.get(_REVISIONS, {}).get(row.id)
        if expected is None or write_revision(row.json) != expected.revision:
            raise PluginWriteError("plugin_write_conflict")
        updated = (
            db.query(Kind)
            .filter(
                Kind.id == row.id,
                Kind.user_id == row.user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == row.namespace,
                Kind.name == expected.name,
                func.coalesce(Kind.json["spec"]["writeRevision"].as_integer(), 0)
                == expected.revision,
            )
            .update(
                {
                    Kind.json: row.json,
                    Kind.name: row.name,
                    Kind.is_active: row.is_active,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            raise PluginWriteError("plugin_write_conflict")
        expected.name = row.name
        for attribute in ("json", "name", "is_active"):
            set_committed_value(row, attribute, getattr(row, attribute))
        db.info[_DESIRED_CHANGED] = True


@event.listens_for(Session, "after_flush_postexec")
def _remember_created_installations(db: Session, _context: Any) -> None:
    for row in db.info.get(_NEW_INSTALLS, []):
        if row.id is not None:
            db.info.setdefault(_REVISIONS, {}).setdefault(
                row.id,
                PluginWriteRevision(
                    row.id, row.user_id, row.name, write_revision(row.json)
                ),
            )


@event.listens_for(Session, "before_commit")
def _guard_commit(db: Session) -> None:
    leases: dict[tuple[int, str], _Lease] = db.info.get(_LEASES, {})
    if not leases or db.in_nested_transaction():
        return
    _recapture_revisions(db)
    db.flush()
    creations = set()
    for row in db.info.pop(_NEW_INSTALLS, []):
        if (row.user_id, row.name) not in leases:
            raise PluginWriteError("plugin_write_conflict")
        db.info.setdefault(_REVISIONS, {}).update(
            read_plugin_revisions(db, row.user_id, row.name)
        )
        creations.add((row.user_id, row.name))
    for _, lease in sorted(leases.items()):
        lease.check()
    for identity in sorted(creations):
        expected = db.info.get(_CREATIONS, {}).get(identity)
        if expected is None:
            raise PluginWriteError("plugin_write_conflict")
        advance_creation_revision(db, expected)
    for expected in db.info.get(_REVISIONS, {}).values():
        advance_plugin_revision(db, expected)
    if db.info.pop(_DESIRED_CHANGED, False):
        from copy import deepcopy

        from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

        users = {expected.user_id for expected in db.info.get(_REVISIONS, {}).values()}
        for user_id in sorted(users):
            state = lock_plugin_sync_state(db, user_id, merge=True)
            state.json = deepcopy(state.json)
        db.flush()
    for policy in db.info.get("plugin_auth_policy_fences", {}).values():
        validate_policy_revision(db, policy)


@event.listens_for(Session, "after_transaction_end")
def _release_transaction(db: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is not None:
        return
    db.info.pop("plugin_revision_recapture", None)
    db.info.pop(_SAVEPOINTS, None)
    db.info.pop("plugin_coordination_savepoints", None)
    db.info.pop(_REVISIONS, None)
    db.info.pop(_NEW_INSTALLS, None)
    db.info.pop(_CREATIONS, None)
    db.info.pop(_DESIRED_CHANGED, None)
    db.info.pop("plugin_auth_policy_fences", None)
    from app.services.plugin_sync_revision import clear_sync_revisions

    clear_sync_revisions(db)
    for (user_id, _), lease in db.info.pop(_LEASES, {}).items():
        _release_plugin_write_lease(db, user_id, lease)
