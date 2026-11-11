"""Stage verified public Thread objects without changing database ownership."""

from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, CollaborationChatGroup
from app.services.delivery.storage import (
    DeliveryStorage,
    delivery_storage,
)
from app.services.thread_migration_inventory import (
    ThreadMigrationEntry,
    ThreadMigrationInventory,
    inspect_thread_migration,
)


@dataclass(frozen=True)
class ThreadMigrationObjectTarget:
    thread_id: str
    source_key: str
    target_key: str
    expected_size_bytes: int | None
    expected_sha256: str | None


@dataclass(frozen=True)
class ThreadMigrationObjectCopy:
    thread_id: str
    source_key: str
    target_key: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ThreadMigrationAssets:
    inventory_id: str
    objects: tuple[ThreadMigrationObjectCopy, ...]


def require_current_inventory(
    db: Session, inventory: ThreadMigrationInventory, actor_user_id: int
) -> None:
    """A previous report never substitutes for current actor or source facts."""
    mapping = {
        (entry.source_status or ""): entry.target_status
        for entry in inventory.entries
        if entry.target_status is not None
        and entry.source_status != entry.target_status
    }
    current = inspect_thread_migration(
        db,
        source_project_id=int(inventory.source_project_id),
        target_group_id=int(inventory.target_group_id),
        actor_user_id=actor_user_id,
        status_map=mapping,
    )
    if current.to_dict() != inventory.to_dict():
        raise HTTPException(409, "Migration inventory changed; inspect it again")
    if current.blockers or any(entry.blockers for entry in current.entries):
        raise HTTPException(409, "Resolve migration inventory blockers first")


def _copy_object(
    storage: DeliveryStorage, target: ThreadMigrationObjectTarget
) -> ThreadMigrationObjectCopy:
    source_key, target_key = target.source_key, target.target_key
    expected = storage.fingerprint(source_key)
    if (
        target.expected_size_bytes is not None
        and target.expected_size_bytes != expected[0]
    ) or (
        target.expected_sha256 is not None
        and target.expected_sha256.lower() != expected[1]
    ):
        raise HTTPException(
            409, "Migration source bytes do not match recorded metadata"
        )
    created = storage.copy_object_if_absent(source_key, target_key)
    if storage.fingerprint(target_key) != expected:
        if not created:
            raise HTTPException(409, "Migration target object contains different bytes")
        raise HTTPException(409, "Migration object copy verification failed")
    if storage.fingerprint(source_key) != expected:
        raise HTTPException(409, "Migration source object changed during copying")
    return ThreadMigrationObjectCopy(
        thread_id=target.thread_id,
        source_key=source_key,
        target_key=target_key,
        size_bytes=expected[0],
        sha256=expected[1],
    )


def _recorded_fingerprint(
    entry: ThreadMigrationEntry, key: str
) -> tuple[int | None, str | None]:
    references = [reference for reference in entry.objects if reference.key == key]
    sizes = {value.size_bytes for value in references if value.size_bytes is not None}
    hashes = {value.sha256.lower() for value in references if value.sha256 is not None}
    if len(sizes) > 1 or len(hashes) > 1:
        raise HTTPException(409, "Conflicting migration object metadata")
    return next(iter(sizes), None), next(iter(hashes), None)


def migration_object_targets(
    db: Session, inventory: ThreadMigrationInventory
) -> tuple[ThreadMigrationObjectTarget, ...]:
    """Resolve only canonical keys after the caller verifies current access."""
    source = db.get(CloudProject, inventory.source_project_id)
    target = db.get(CollaborationChatGroup, inventory.target_group_id)
    if (
        source is None
        or not source.public_id
        or target is None
        or target.public_id != str(target.id)
        or target.storage_prefix != f"groups/{target.id}"
    ):
        raise HTTPException(409, "Migration storage namespaces are not initialized")
    targets = []
    for entry in inventory.entries:
        source_prefix = f"projects/{source.public_id}/loop-items/{entry.thread_id}/"
        target_prefix = f"projects/{target.public_id}/loop-items/{entry.thread_id}/"
        for key in entry.object_keys:
            if not key.startswith(source_prefix):
                raise HTTPException(
                    409, "Migration object is outside its source Thread"
                )
            suffix = key.removeprefix(source_prefix)
            if not suffix or any(part in {"", ".", ".."} for part in suffix.split("/")):
                raise HTTPException(409, "Invalid migration object identity")
            size, digest = _recorded_fingerprint(entry, key)
            targets.append(
                ThreadMigrationObjectTarget(
                    thread_id=entry.thread_id,
                    source_key=key,
                    target_key=target_prefix + suffix,
                    expected_size_bytes=size,
                    expected_sha256=digest,
                )
            )
    return tuple(targets)


def verify_thread_migration_assets(
    storage: DeliveryStorage, assets: ThreadMigrationAssets
) -> None:
    """Verify both ends again; a receipt is evidence, never access authority."""
    for copy in assets.objects:
        expected = copy.size_bytes, copy.sha256
        if storage.fingerprint(copy.source_key) != expected:
            raise HTTPException(409, "Migration source object changed during copying")
        if storage.fingerprint(copy.target_key) != expected:
            raise HTTPException(409, "Migration object copy verification failed")


def require_migration_asset_receipts(
    db: Session,
    inventory: ThreadMigrationInventory,
    assets: ThreadMigrationAssets,
    storage: DeliveryStorage,
) -> None:
    """Match every receipt to current references before ownership changes."""
    if assets.inventory_id != inventory.to_dict()["inventory_id"]:
        raise HTTPException(409, "Migration asset receipts belong to another inventory")
    targets = migration_object_targets(db, inventory)
    copies = {
        (row.thread_id, row.source_key, row.target_key): row for row in assets.objects
    }
    if len(copies) != len(assets.objects) or set(copies) != {
        (row.thread_id, row.source_key, row.target_key) for row in targets
    }:
        raise HTTPException(
            409, "Migration asset receipts do not cover current objects"
        )
    for target in targets:
        copy = copies[target.thread_id, target.source_key, target.target_key]
        if (
            target.expected_size_bytes is not None
            and target.expected_size_bytes != copy.size_bytes
        ) or (
            target.expected_sha256 is not None and target.expected_sha256 != copy.sha256
        ):
            raise HTTPException(
                409, "Migration receipts do not match recorded metadata"
            )
    verify_thread_migration_assets(storage, assets)


def prepare_thread_migration_assets(
    *,
    inventory: ThreadMigrationInventory,
    actor_user_id: int,
    session_factory: Callable[[], AbstractContextManager[Session]],
    storage: DeliveryStorage = delivery_storage,
) -> ThreadMigrationAssets:
    """Copy only inventoried Thread objects; preserve immutable snapshot bytes.

    A failure leaves the source untouched and verified destination objects may
    be reused on a later attempt. No rows, grants or execution contexts change.
    The caller must revalidate these receipts before its ownership transaction.
    """
    with session_factory() as current:
        require_current_inventory(current, inventory, actor_user_id)
        targets = migration_object_targets(current, inventory)
    copies = tuple(_copy_object(storage, target) for target in targets)
    assets = ThreadMigrationAssets(
        inventory_id=str(inventory.to_dict()["inventory_id"]), objects=copies
    )
    verify_thread_migration_assets(storage, assets)
    with session_factory() as current:
        require_current_inventory(current, inventory, actor_user_id)
    return assets
