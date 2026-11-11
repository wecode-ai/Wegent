"""Forward ownership transactions preserve public records and private authority."""

import json
from dataclasses import replace
from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    LoopItem,
    LoopItemComment,
    LoopItemTaskBinding,
    StandInIssueEvent,
    ThreadMigrationCheckpoint,
    ThreadParticipant,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.services.thread_migration import apply_thread_migration
from app.services.thread_migration_assets import prepare_thread_migration_assets
from app.services.thread_participation import participant_id
from app.services.thread_project_links import linked_project_id
from tests.services.test_thread_migration_assets import migration as migration_fixture

migration = migration_fixture


def _apply(arguments, storage, **overrides):
    assets = prepare_thread_migration_assets(storage=storage, **arguments)
    return apply_thread_migration(
        **arguments,
        assets=assets,
        storage=storage,
        retain_source_project=overrides.pop("retain_source_project", True),
        **overrides,
    )


def test_atomic_move_replay_preserves_public_history_private_binding_and_choices(
    test_db, test_user, migration
):
    arguments, storage, thread, group = migration
    source = thread.cloud_project_id
    original_created, original_updated = thread.created_at, thread.updated_at
    # Persist source facts, then inspect again rather than tampering with the plan.
    test_db.add_all(
        [
            LoopItemComment(
                id="discussion",
                cloud_project_id=source,
                loop_item_id=thread.id,
                description="Original discussion",
                created_by_user_id=test_user.id,
                created_at=datetime(2026, 1, 1),
            ),
            LoopItemTaskBinding(
                id="private",
                cloud_project_id=source,
                loop_item_id=thread.id,
                task_user_id=test_user.id,
                task_id="private-runtime",
                device_id="private-device",
                metadata_json={"execution_context": {"private": "keep"}},
            ),
            StandInIssueEvent(
                id="private-event",
                cloud_project_id=source,
                loop_item_id=thread.id,
                user_id=test_user.id,
                metadata_json={"source_scope": source},
            ),
            ProjectChatMessage(
                message_id="public-chat",
                project_id=source,
                task_id=thread.id,
                sender_type="user",
                sender_id=str(test_user.id),
                message_type="text",
                content="Public chat",
                metadata_json={"origin": "original-public-metadata"},
                status="completed",
            ),
        ]
    )
    test_db.commit()
    from app.services.thread_migration_inventory import inspect_thread_migration

    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assets = prepare_thread_migration_assets(storage=storage, **arguments)
    grants = test_db.query(ResourceMember).count()
    result = apply_thread_migration(
        **arguments, assets=assets, storage=storage, retain_source_project=True
    )
    test_db.expire_all()
    assert result.thread_ids == (thread.id,) and not result.replayed
    assert thread.cloud_project_id == group.id
    assert thread.version == 2 and thread.sequence_number == 1
    assert (
        thread.created_at == original_created and thread.updated_at == original_updated
    )
    assert linked_project_id(test_db, thread.id) == source
    assert test_db.get(LoopItemComment, "discussion").cloud_project_id == group.id
    binding = test_db.get(LoopItemTaskBinding, "private")
    assert binding.cloud_project_id == group.id
    assert (binding.task_user_id, binding.task_id, binding.device_id) == (
        test_user.id,
        "private-runtime",
        "private-device",
    )
    assert binding.execution_context == {"private": "keep"}
    assert test_db.get(StandInIssueEvent, "private-event").cloud_project_id == source
    messages = test_db.query(ProjectChatMessage).all()
    assert len(messages) == 2
    assert all(message.project_id == group.id for message in messages)
    assert {message.content for message in messages} == {
        "Public chat",
        "Original discussion",
    }
    ordered = test_db.query(ProjectChatMessage).order_by(ProjectChatMessage.id).all()
    assert [row.content for row in ordered] == ["Original discussion", "Public chat"]
    assert [row.message_id for row in ordered] == ["discussion", "public-chat"]
    assert ordered[1].metadata_json == {"origin": "original-public-metadata"}
    participant = test_db.get(
        ThreadParticipant, participant_id(thread.id, test_user.id)
    )
    assert participant.status == "active"
    participant.status = "left"
    participant.metadata_json = {"notifications": "muted"}
    thread.title = "Edited after migration"
    test_db.commit()
    replay = apply_thread_migration(
        **arguments, assets=assets, storage=storage, retain_source_project=True
    )
    test_db.expire_all()
    assert replay.replayed and replay.checkpoint_id == result.checkpoint_id
    assert participant.status == "left" and participant.metadata_json == {
        "notifications": "muted"
    }
    assert thread.title == "Edited after migration" and group.next_item_number == 2
    assert test_db.query(ResourceMember).count() == grants
    assert test_db.query(ThreadMigrationCheckpoint).count() == 1


@pytest.mark.parametrize("terminal_status", ["completed", "failed", "cancelled"])
def test_terminal_execution_history_follows_thread_without_rewriting_private_origin(
    test_db, test_user, migration, terminal_status
):
    arguments, storage, thread, group = migration
    source_id = thread.cloud_project_id
    execution = LoopItemExecution(
        loop_item_id=thread.id,
        cloud_project_id=source_id,
        status=terminal_status,
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 2),
        executor_owner_user_id=test_user.id,
        runtime_device_id="original-private-device",
        runtime_task_id="original-private-task",
        execution_payload=json.dumps(
            {"origin_context": {"cloudProjectId": source_id, "private": "keep"}}
        ),
    )
    test_db.add(execution)
    test_db.commit()
    _apply(arguments, storage)
    test_db.expire_all()
    assert execution.cloud_project_id == str(group.id)
    assert execution.status == terminal_status
    assert execution.created_at == datetime(2026, 1, 1)
    assert execution.updated_at == datetime(2026, 1, 2)
    assert execution.executor_owner_user_id == test_user.id
    assert execution.runtime_device_id == "original-private-device"
    assert execution.runtime_task_id == "original-private-task"
    assert execution.runtime_origin_context == {
        "cloudProjectId": source_id,
        "private": "keep",
    }
    assert (
        test_db.query(LoopItemExecution)
        .filter_by(cloud_project_id=source_id, loop_item_id=thread.id)
        .count()
        == 0
    )


def test_failure_after_move_rolls_back_all_database_changes(
    test_db, migration, monkeypatch
):
    import app.services.thread_migration as service

    arguments, storage, thread, group = migration
    source = thread.cloud_project_id
    execution = LoopItemExecution(
        loop_item_id=thread.id, cloud_project_id=source, status="completed"
    )
    test_db.add(execution)
    test_db.commit()
    original = service._move_resources

    def interrupt(*args):
        original(*args)
        raise OSError("interrupted before checkpoint")

    monkeypatch.setattr(service, "_move_resources", interrupt)
    with pytest.raises(OSError, match="interrupted"):
        _apply(arguments, storage)
    test_db.expire_all()
    assert thread.cloud_project_id == source and thread.version == 1
    assert group.next_item_number == 1
    assert execution.cloud_project_id == source
    assert test_db.query(ThreadMigrationCheckpoint).count() == 0
    assert test_db.query(ThreadParticipant).count() == 0
    assert linked_project_id(test_db, thread.id) is None
    monkeypatch.setattr(service, "_move_resources", original)
    assert not _apply(arguments, storage).replayed
    test_db.refresh(execution)
    assert execution.cloud_project_id == str(group.id)


@pytest.mark.parametrize(
    "problem", ["receipt", "source-version", "revoked", "active-run"]
)
def test_stale_or_unauthorized_plan_has_no_ownership_side_effects(
    test_db, test_user, migration, problem
):
    arguments, storage, thread, group = migration
    source = thread.cloud_project_id
    assets = prepare_thread_migration_assets(storage=storage, **arguments)
    if problem == "receipt":
        assets = replace(assets, objects=assets.objects[:-1])
    elif problem == "source-version":
        thread.version += 1
    elif problem == "revoked":
        grant = (
            test_db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == "CollaborationChatGroup",
                ResourceMember.entity_id == str(test_user.id),
            )
            .one()
        )
        grant.status = "revoked"
    else:
        test_db.add(
            LoopItemExecution(
                loop_item_id=thread.id, cloud_project_id=source, status="queued"
            )
        )
    test_db.commit()
    with pytest.raises(HTTPException):
        apply_thread_migration(
            **arguments, assets=assets, storage=storage, retain_source_project=True
        )
    test_db.expire_all()
    assert thread.cloud_project_id == source and group.next_item_number == 1
    assert test_db.query(ThreadMigrationCheckpoint).count() == 0


def test_explicit_unclassified_move_keeps_restricted_records_at_source(
    test_db, migration
):
    arguments, storage, thread, group = migration
    source = thread.cloud_project_id
    restricted = LoopItem(
        id="PRIVATE-CHILD",
        cloud_project_id=source,
        parent_id=thread.id,
        status="pending",
        metadata_json={"security_level": "related"},
    )
    test_db.add(restricted)
    test_db.commit()
    from app.services.thread_migration_inventory import inspect_thread_migration

    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=arguments["actor_user_id"],
    )
    _apply(arguments, storage, retain_source_project=False)
    test_db.expire_all()
    assert (
        thread.cloud_project_id == group.id
        and linked_project_id(test_db, thread.id) is None
    )
    assert restricted.cloud_project_id == source and restricted.parent_id is None
    assert restricted.metadata_json == {"security_level": "related"}


def test_finished_archived_thread_preserves_dates_tags_and_left_muted_choice(
    test_db, test_user, migration
):
    arguments, storage, thread, group = migration
    thread.status = "completed"
    thread.completed_at = datetime(2026, 2, 1)
    thread.deleted_at = datetime(2026, 3, 1)
    thread.metadata_json = {"tags": ["任意标签", "historical"]}
    test_db.add(
        ThreadParticipant(
            id=participant_id(thread.id, test_user.id),
            parent_id=thread.id,
            user_id=test_user.id,
            status="left",
            metadata_json={"notifications": "muted"},
        )
    )
    test_db.commit()
    from app.services.thread_migration_inventory import inspect_thread_migration

    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(thread.cloud_project_id),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    _apply(arguments, storage)
    test_db.expire_all()
    assert thread.status == "completed"
    assert thread.completed_at == datetime(2026, 2, 1)
    assert thread.deleted_at == datetime(2026, 3, 1)
    assert thread.metadata_json == {"tags": ["任意标签", "historical"]}
    participant = test_db.get(
        ThreadParticipant, participant_id(thread.id, test_user.id)
    )
    assert participant.status == "left"
    assert participant.metadata_json == {"notifications": "muted"}


def test_completed_checkpoint_never_substitutes_for_current_authority(
    test_db, test_user, migration
):
    arguments, storage, thread, group = migration
    assets = prepare_thread_migration_assets(storage=storage, **arguments)
    first = apply_thread_migration(
        **arguments, assets=assets, storage=storage, retain_source_project=True
    )
    test_db.expire_all()
    version, next_number = thread.version, group.next_item_number
    test_user.is_active = False
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        apply_thread_migration(
            **arguments, assets=assets, storage=storage, retain_source_project=True
        )
    assert denied.value.status_code == 404
    test_db.expire_all()
    assert thread.version == version and group.next_item_number == next_number
    assert test_db.get(ThreadMigrationCheckpoint, first.checkpoint_id) is not None


def test_report_round_trip_and_tampered_report_rejection(migration):
    from app.services.thread_migration_inventory import ThreadMigrationInventory

    arguments, _, _, _ = migration
    value = json.loads(json.dumps(arguments["inventory"].to_dict()))
    decoded = ThreadMigrationInventory.from_dict(value)
    assert decoded.to_dict() == arguments["inventory"].to_dict()
    value["target_group_id"] = "12345"
    with pytest.raises(ValueError, match="digest"):
        ThreadMigrationInventory.from_dict(value)


def test_operator_receipts_are_created_without_overwriting_another_plan(tmp_path):
    from scripts.migrate_threads import save_receipts

    path = tmp_path / "receipt.json"
    save_receipts(path, {"inventory_id": "first"})
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        save_receipts(path, {"inventory_id": "second"})
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


def test_explicit_mapping_for_unset_legacy_status_is_preserved_on_revalidation(
    test_db, migration
):
    from app.services.thread_migration_inventory import inspect_thread_migration

    arguments, storage, thread, group = migration
    thread.status = None
    test_db.commit()
    arguments["inventory"] = inspect_thread_migration(
        test_db,
        source_project_id=int(thread.cloud_project_id),
        target_group_id=int(group.id),
        actor_user_id=arguments["actor_user_id"],
        status_map={"": "pending"},
    )
    assert arguments["inventory"].entries[0].blockers == ()
    _apply(arguments, storage)
    test_db.expire_all()
    assert thread.cloud_project_id == group.id and thread.status == "pending"
