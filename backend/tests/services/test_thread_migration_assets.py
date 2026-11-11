"""Asset staging preserves source ownership and validates copies before a move."""

import hashlib
from dataclasses import replace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemAttachment
from app.models.resource_member import ResourceMember
from app.services.delivery.storage import DeliveryObjectNotFoundError, DeliveryStorage
from app.services.thread_migration_assets import prepare_thread_migration_assets
from app.services.thread_migration_inventory import inspect_thread_migration
from tests.services.test_project_board_snapshot_queries import _project
from tests.services.test_thread_participation import make_group


class RecordingStorage(DeliveryStorage):
    """A unit-level storage double, not an object-store integration fixture."""

    def __init__(self, objects):
        self.objects = dict(objects)
        self.copies = []
        self.after_copy = None
        self.before_copy = None

    def fingerprint(self, key):
        if key not in self.objects:
            raise DeliveryObjectNotFoundError(key)
        content = self.objects[key]
        return len(content), hashlib.sha256(content).hexdigest()

    def copy_object_if_absent(self, source, target):
        if self.before_copy:
            self.before_copy(source, target)
        if target in self.objects:
            return False
        self.copies.append((source, target))
        self.objects[target] = self.objects[source]
        if self.after_copy:
            self.after_copy(source, target)
        return True


@pytest.fixture
def migration(test_db, test_user):
    source_id, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    group.public_id = str(group.id)
    group.storage_prefix = f"groups/{group.id}"
    thread = LoopItem(
        id="MIGRATE-1",
        cloud_project_id=source_id,
        title="Migrate public files",
        status="pending",
        created_by_user_id=test_user.id,
        version=1,
    )
    test_db.add(thread)
    test_db.flush()
    from app.models.delivery import CloudProject

    source = test_db.get(CloudProject, source_id)
    prefix = f"projects/{source.public_id}/loop-items/{thread.id}/attachments/"
    objects = {prefix + "first": b"first", prefix + "second": b"second"}
    for index, (key, content) in enumerate(objects.items()):
        test_db.add(
            LoopItemAttachment(
                id=f"migration-attachment-{index}",
                loop_item_id=thread.id,
                object_key=key,
                size_bytes=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
            )
        )
    test_db.commit()
    inventory = inspect_thread_migration(
        test_db,
        source_project_id=int(source_id),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    arguments = {
        "inventory": inventory,
        "actor_user_id": test_user.id,
        "session_factory": lambda: Session(
            bind=test_db.get_bind(), join_transaction_mode="create_savepoint"
        ),
    }
    return arguments, RecordingStorage(objects), thread, group


def test_copy_and_resume_preserve_bytes_source_rows_and_grants(test_db, migration):
    arguments, storage, thread, group = migration
    source_owner = thread.cloud_project_id
    grant_count = test_db.query(ResourceMember).count()
    receipt = prepare_thread_migration_assets(storage=storage, **arguments)
    assert len(receipt.objects) == len(storage.copies) == 2
    assert receipt.inventory_id == arguments["inventory"].to_dict()["inventory_id"]
    for copy in receipt.objects:
        assert copy.target_key.startswith(
            f"projects/{group.id}/loop-items/{thread.id}/attachments/"
        )
        assert storage.objects[copy.source_key] == storage.objects[copy.target_key]
        assert copy.size_bytes == len(storage.objects[copy.source_key])
        assert (
            copy.sha256 == hashlib.sha256(storage.objects[copy.source_key]).hexdigest()
        )
    assert prepare_thread_migration_assets(storage=storage, **arguments) == receipt
    assert len(storage.copies) == 2
    test_db.refresh(thread)
    assert thread.cloud_project_id == source_owner and thread.version == 1
    assert test_db.query(ResourceMember).count() == grant_count
    assert not test_db.dirty


def test_copy_failure_preserves_source_and_resume_reuses_verified_object(migration):
    arguments, storage, _, _ = migration
    original = dict(storage.objects)

    def interrupt(source, target):
        raise OSError("interrupted before receipt")

    storage.after_copy = interrupt
    with pytest.raises(OSError, match="interrupted"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert all(storage.objects[key] == value for key, value in original.items())
    storage.after_copy = None
    receipt = prepare_thread_migration_assets(storage=storage, **arguments)
    assert len(receipt.objects) == 2
    assert len(storage.copies) == 2


def test_corrupt_destination_is_rejected_without_overwriting_it(migration):
    arguments, storage, _, _ = migration
    storage.after_copy = lambda source, target: storage.objects.update({target: b"bad"})
    with pytest.raises(HTTPException, match="verification failed"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    storage.after_copy = None
    before = len(storage.copies)
    with pytest.raises(HTTPException, match="different bytes"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert len(storage.copies) == before


def test_source_change_during_copy_is_rejected(migration):
    arguments, storage, _, _ = migration
    storage.after_copy = lambda source, target: storage.objects.update({source: b"new"})
    with pytest.raises(HTTPException, match="source object changed"):
        prepare_thread_migration_assets(storage=storage, **arguments)


def test_concurrent_target_creation_is_preserved(migration):
    arguments, storage, _, _ = migration
    targets = []

    def create_target(source, target):
        storage.objects[target] = b"concurrent writer's different bytes"
        targets.append(target)

    storage.before_copy = create_target
    with pytest.raises(HTTPException, match="different bytes"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert targets
    assert all(
        storage.objects[key] == b"concurrent writer's different bytes"
        for key in targets
    )


def test_earlier_object_change_while_copying_later_object_is_rejected(migration):
    arguments, storage, _, _ = migration
    first_key = next(iter(storage.objects))

    def change_previous(source, target):
        if source != first_key:
            storage.objects[first_key] = b"changed after its earlier verification"

    storage.after_copy = change_previous
    with pytest.raises(HTTPException, match="source object changed"):
        prepare_thread_migration_assets(storage=storage, **arguments)


def test_forged_inventory_never_reads_or_copies_objects(migration):
    arguments, storage, _, _ = migration
    report = arguments["inventory"]
    arguments["inventory"] = replace(
        report,
        entries=(
            replace(
                report.entries[0],
                objects=(
                    replace(report.entries[0].objects[0], key="unrelated/private"),
                ),
            ),
        ),
    )
    with pytest.raises(HTTPException, match="inventory changed"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert not storage.copies


def test_current_revocation_after_copy_prevents_receipt(test_db, migration):
    arguments, storage, thread, group = migration

    def revoke(source, target):
        grant = (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="CollaborationChatGroup", resource_id=int(group.id)
            )
            .one()
        )
        grant.status = "removed"
        test_db.commit()

    storage.after_copy = revoke
    with pytest.raises(HTTPException) as denied:
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert denied.value.status_code == 404
    test_db.refresh(thread)
    assert thread.cloud_project_id == arguments["inventory"].source_project_id


def test_recorded_foreign_namespace_never_copies_it(test_db, migration):
    arguments, storage, _, _ = migration
    test_db.query(LoopItemAttachment).first().object_key = "other-owner/private.txt"
    test_db.commit()
    report = arguments["inventory"]
    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(report.source_project_id),
        target_group_id=int(report.target_group_id),
        actor_user_id=arguments["actor_user_id"],
    )
    with pytest.raises(HTTPException, match="outside its source"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert not storage.copies


def test_changed_recorded_checksum_invalidates_inventory(test_db, migration):
    arguments, storage, _, _ = migration
    test_db.query(LoopItemAttachment).first().sha256 = "0" * 64
    test_db.commit()
    with pytest.raises(HTTPException, match="inventory changed"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert not storage.copies


def test_recorded_checksum_must_match_source_bytes(test_db, migration):
    arguments, storage, _, _ = migration
    test_db.query(LoopItemAttachment).first().sha256 = "0" * 64
    test_db.commit()
    report = arguments["inventory"]
    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(report.source_project_id),
        target_group_id=int(report.target_group_id),
        actor_user_id=arguments["actor_user_id"],
    )
    with pytest.raises(HTTPException, match="recorded metadata"):
        prepare_thread_migration_assets(storage=storage, **arguments)
    assert not storage.copies
