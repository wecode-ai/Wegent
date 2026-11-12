"""Migration inventory reports source facts without granting or moving anything."""

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    Delivery,
    DeliveryAsset,
    LoopItem,
    LoopItemComment,
    LoopItemTaskBinding,
    LoopNode,
)
from app.models.resource_member import ResourceMember
from app.services.thread_migration_inventory import inspect_thread_migration
from tests.services.test_project_board_snapshot_queries import _project
from tests.services.test_thread_participation import make_group, person


def test_inventory_uses_human_facts_and_retains_private_runtime_ownership(
    test_db, test_user
):
    source, _ = _project(test_db, test_user.id, 0)
    author = person(test_db, "inventory-author")
    silent = person(test_db, "inventory-silent")
    outsider = person(test_db, "inventory-outsider")
    group = make_group(test_db, test_user, [(author, "Viewer"), (silent, "Developer")])
    thread = LoopItem(
        id="OLD-1",
        cloud_project_id=source,
        title="Public",
        status="pending",
        created_by_user_id=test_user.id,
        version=1,
    )
    test_db.add(thread)
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=int(source),
                entity_id=str(silent.id),
                role="Developer",
                status="approved",
            ),
            LoopItemComment(
                cloud_project_id=source,
                loop_item_id=thread.id,
                description="Human discussion",
                created_by_user_id=author.id,
            ),
            LoopItemComment(
                cloud_project_id=source,
                loop_item_id=thread.id,
                description="Old author without target grant",
                created_by_user_id=outsider.id,
            ),
            LoopItemComment(
                cloud_project_id=source,
                loop_item_id=thread.id,
                description="Assignment event",
                created_by_user_id=silent.id,
                metadata_json={"event_type": "assignment"},
            ),
            LoopItemTaskBinding(
                id="private-binding",
                cloud_project_id=source,
                loop_item_id=thread.id,
                task_user_id=outsider.id,
                device_id="private-device",
                task_id="private-runtime",
                metadata_json={"private": "private-transcript-context"},
            ),
            Delivery(
                id="delivery",
                loop_item_id=thread.id,
                markdown_object_key="old/markdown.md",
                chat_object_key="old/chat.json",
                manifest_object_key="old/manifest.json",
            ),
        ]
    )
    test_db.flush()
    test_db.add(
        DeliveryAsset(
            id="asset", delivery_id="delivery", object_key="old/assets/image.png"
        )
    )
    test_db.commit()
    before = (test_db.query(LoopNode).count(), test_db.query(ResourceMember).count())
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    entry = report.entries[0]
    assert entry.eligible_participant_ids == tuple(sorted([test_user.id, author.id]))
    assert entry.resource_counts["execution"] == 1
    assert entry.resource_counts["delivery_asset"] == 1
    assert entry.object_keys == (
        "old/assets/image.png",
        "old/chat.json",
        "old/manifest.json",
        "old/markdown.md",
    )
    assert entry.blockers == report.blockers == ()
    assert "private-transcript-context" not in str(report.to_dict())
    assert "private-runtime" not in str(report.to_dict())
    assert (
        test_db.query(LoopNode).count(),
        test_db.query(ResourceMember).count(),
    ) == before
    assert thread.cloud_project_id == source and thread.version == 1
    assert (
        test_db.get(LoopItemTaskBinding, "private-binding").task_user_id == outsider.id
    )
    assert not test_db.dirty


def test_restricted_parent_is_excluded_and_unknown_state_requires_mapping(
    test_db, test_user
):
    source, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    parent = LoopItem(
        id="OLD-1",
        cloud_project_id=source,
        title="Restricted legacy title",
        status="completed",
        metadata_json={"security_level": "related"},
    )
    child = LoopItem(
        id="OLD-2",
        cloud_project_id=source,
        parent_id=parent.id,
        status="old-review",
        deleted_at=datetime(2026, 11, 1),
        version=1,
    )
    test_db.add_all([parent, child])
    test_db.commit()
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assert report.excluded_restricted_ids == (parent.id,)
    assert len(report.entries) == 1
    assert report.entries[0].source_parent_id == parent.id
    assert report.entries[0].target_parent_id is None
    assert report.entries[0].archived is True
    assert report.entries[0].target_status is None
    assert report.entries[0].blockers == ("explicit_status_mapping_required",)
    assert "Restricted legacy title" not in str(report.to_dict())
    mapped = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
        status_map={"old-review": "in_review"},
    )
    assert mapped.entries[0].target_status == "in_review"
    assert mapped.entries[0].blockers == ()
    assert (
        mapped.to_dict()
        == inspect_thread_migration(
            test_db,
            source_project_id=int(source),
            target_group_id=int(group.id),
            actor_user_id=test_user.id,
            status_map={"old-review": "in_review"},
        ).to_dict()
    )
    assert child.cloud_project_id == source and child.parent_id == parent.id


@pytest.mark.parametrize("role,expected", [("Viewer", 403), (None, 404)])
def test_project_ownership_does_not_grant_target_group_migration_access(
    test_db, test_user, role, expected
):
    source, _ = _project(test_db, test_user.id, 0)
    owner = person(test_db, "inventory-other-owner")
    group = make_group(test_db, owner, [(test_user, role)] if role else [])
    with pytest.raises(HTTPException) as denied:
        inspect_thread_migration(
            test_db,
            source_project_id=int(source),
            target_group_id=int(group.id),
            actor_user_id=test_user.id,
        )
    assert denied.value.status_code == expected


def test_inventory_reports_resource_mapping_and_invalid_counter_without_repair(
    test_db, test_user
):
    source, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    group.next_item_number = 0
    thread = LoopItem(
        id="OLD-1",
        cloud_project_id=source,
        status="pending",
        assignee_agent_id="old-private-agent",
        version=1,
    )
    test_db.add(thread)
    test_db.commit()
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assert report.blockers == ("target_counter_not_initialized",)
    assert report.entries[0].blockers == ("execution_resource_mapping_required",)
    assert report.target_next_item_number == group.next_item_number == 0
    assert thread.assignee_agent_id == "old-private-agent"
    assert not test_db.dirty


def test_inventory_keeps_existing_source_project_archive_access_restrictions(
    test_db, test_user
):
    from app.models.delivery import CloudProject

    source, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    test_db.get(CloudProject, source).status = "archived"
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        inspect_thread_migration(
            test_db,
            source_project_id=int(source),
            target_group_id=int(group.id),
            actor_user_id=test_user.id,
        )
    assert denied.value.status_code == 404


def test_inventory_does_not_silently_rehome_a_project_execution_crew(
    test_db, test_user
):
    source, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    thread = LoopItem(
        id="OLD-CREW-1",
        cloud_project_id=source,
        status="pending",
        metadata_json={"collaboration_group": {"id": "source-only-execution-crew"}},
    )
    test_db.add(thread)
    test_db.commit()
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assert report.entries[0].blockers == ("execution_resource_mapping_required",)
    assert thread.cloud_project_id == source
