"""Project boards aggregate only currently readable owning-group Threads."""

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ThreadProjectLink,
)
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.project_board_snapshot import project_board_snapshot_service
from tests.services.test_project_board_snapshot_queries import _project
from tests.services.test_thread_participation import make_group, make_thread, person


def test_linked_thread_previews_remain_private_to_current_readable_group_members(
    test_db, test_user
):
    project_id, _ = _project(test_db, test_user.id, 0)
    other = person(test_db, "private-preview-other")
    group = make_group(test_db, other, [(test_user, "Developer")])
    thread = make_thread(test_db, group, other)
    thread.sequence_number = 1
    thread.priority = "none"
    test_db.add_all(
        [
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(project_id),
                entity_type="user",
                entity_id=str(other.id),
                user_id=other.id,
                role="Developer",
                status="approved",
            ),
            ThreadProjectLink(
                parent_id=project_id, loop_item_id=thread.id, status="active"
            ),
        ]
    )
    for user in [test_user, other]:
        test_db.add(
            LoopItemTaskBinding(
                id=f"private-preview-binding-{user.id}",
                cloud_project_id=group.id,
                loop_item_id=thread.id,
                task_user_id=user.id,
                linked_by_user_id=user.id,
                device_id=f"private-device-{user.id}",
                task_id=f"private-task-{user.id}",
            )
        )
    test_db.commit()

    for user in [test_user, other]:
        for container_id in [project_id, group.id]:
            snapshot = project_board_snapshot_service.get(
                test_db, container_id, user.id
            )
            assert [row.id for row in snapshot.items] == [thread.id]
            assert [row.task_user_id for row in snapshot.task_bindings] == [user.id]
            assert [row.task_id for row in snapshot.task_bindings] == [
                f"private-task-{user.id}"
            ]

    thread.deleted_at = datetime(2026, 11, 1)
    test_db.commit()
    for user in [test_user, other]:
        bindings = loop_item_service.list_project_task_bindings(
            test_db, project_id, user.id, item_ids=[thread.id]
        )
        assert [row.task_user_id for row in bindings] == [user.id]
    thread.deleted_at = None
    test_db.commit()

    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_id=str(test_user.id),
        )
        .one()
    )
    test_db.delete(grant)
    test_db.commit()
    snapshot = project_board_snapshot_service.get(test_db, project_id, test_user.id)
    assert snapshot.items == []
    assert snapshot.task_bindings == []
    assert (
        loop_item_service.list_project_task_bindings(
            test_db, project_id, test_user.id, item_ids=[thread.id]
        )
        == []
    )


@pytest.mark.parametrize(
    "role,archived_group,denied",
    [
        ("Developer", False, None),
        ("Viewer", False, 403),
        (None, False, 404),
        ("Developer", True, 409),
    ],
)
def test_restore_group_subtree_rechecks_current_group_edit_authority(
    test_db, test_user, role, archived_group, denied
):
    owner = person(test_db, "restore-group-owner")
    group = make_group(test_db, owner, [(test_user, role)] if role else [])
    thread = make_thread(test_db, group, owner)
    archived_at = datetime(2026, 11, 1)
    thread.deleted_at = archived_at
    child = LoopItem(
        id="GROUP-2",
        cloud_project_id=group.id,
        parent_id=thread.id,
        title="Archived child",
        created_by_user_id=owner.id,
        status="pending",
        deleted_at=archived_at,
        version=1,
    )
    test_db.add(child)
    if archived_group:
        group.status = "archived"
    test_db.commit()
    if denied:
        with pytest.raises(HTTPException) as refusal:
            loop_item_service.restore(test_db, thread.id, test_user.id)
        assert refusal.value.status_code == denied
        assert thread.deleted_at == child.deleted_at == archived_at
        assert thread.version == child.version == 1
    else:
        restored = loop_item_service.restore(test_db, thread.id, test_user.id)
        assert {item.id for item in restored} == {thread.id, child.id}
        assert all(item.deleted_at is None and item.version == 2 for item in restored)
        assert all(item.cloud_project_id == group.id for item in restored)


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("group_access", [True, False])
def test_external_archive_merges_readable_threads_before_paging(
    test_db, test_user, monkeypatch, provider, group_access
):
    project_id, _ = _project(test_db, test_user.id, 0)
    project = test_db.get(CloudProject, project_id)
    project.metadata_json = {**(project.metadata_json or {}), "task_provider": provider}
    owner = person(test_db, "external-archive-owner")
    group = make_group(test_db, owner, [(test_user, "Viewer")] if group_access else [])
    thread = make_thread(test_db, group, owner)
    thread.deleted_at = datetime(2026, 11, 1)
    test_db.add(
        ThreadProjectLink(parent_id=project_id, loop_item_id=thread.id, status="active")
    )
    test_db.flush()
    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_issues_state",
        lambda *_: [
            {
                "number": 7,
                "iid": 7,
                "title": "Closed external Issue",
                "state": "closed",
                "labels": [],
                "closed_at": "2026-11-02T00:00:00Z",
                "updated_at": "2026-11-02T00:00:00Z",
            }
        ],
    )
    first, cursor = external_loop_item_provider.list_archived(
        test_db, project_id, test_user.id, offset=0, limit=1
    )
    assert [item["id"] for item in first] == [f"{project.project_key}-7"]
    assert cursor == ("1" if group_access else None)
    second, cursor = external_loop_item_provider.list_archived(
        test_db, project_id, test_user.id, offset=1, limit=1
    )
    assert [item["id"] for item in second] == ([thread.id] if group_access else [])
    assert cursor is None
    if second:
        assert second[0]["group_id"] == str(group.id)


@pytest.mark.parametrize("role", ["Viewer", "Developer", None])
def test_project_archive_requires_current_group_grant(test_db, test_user, role):
    project_id, _ = _project(test_db, test_user.id, 0)
    owner = person(test_db, "archive-group-owner")
    group = make_group(test_db, owner, [(test_user, role)] if role else [])
    thread = make_thread(test_db, group, owner)
    thread.deleted_at = datetime(2026, 11, 1)
    test_db.add(
        ThreadProjectLink(parent_id=project_id, loop_item_id=thread.id, status="active")
    )
    test_db.flush()
    items, cursor = loop_item_service.list_deleted(test_db, project_id, test_user.id)
    assert [item.id for item in items] == ([thread.id] if role else [])
    assert cursor is None
    if role:
        grant = (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="CollaborationChatGroup",
                resource_id=int(group.id),
                entity_id=str(test_user.id),
            )
            .one()
        )
        test_db.delete(grant)
        test_db.flush()
        assert (
            loop_item_service.list_deleted(test_db, project_id, test_user.id)[0] == []
        )


@pytest.mark.parametrize(
    "role,expected", [(None, 404), ("Viewer", 403), ("Developer", None)]
)
def test_classified_creation_requires_both_group_and_project_edit_authority(
    test_db, test_user, role, expected
):
    project_id, _ = _project(test_db, test_user.id, 0)
    creator = person(test_db, "thread-creator")
    group = make_group(test_db, creator, [])
    if role:
        test_db.add(
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(project_id),
                entity_type="user",
                entity_id=str(creator.id),
                user_id=creator.id,
                role=role,
                status="approved",
            )
        )
    test_db.flush()
    before = group.next_item_number
    values = LoopItemCreate(
        title="Classified at creation", classification_project_id=str(project_id)
    )
    if expected:
        with pytest.raises(HTTPException) as denied:
            loop_item_service.create(
                test_db, group.id, creator.id, values, commit=False
            )
        assert denied.value.status_code == expected
        assert group.next_item_number == before
        assert test_db.query(LoopItem).filter_by(cloud_project_id=group.id).count() == 0
    else:
        item = loop_item_service.create(
            test_db, group.id, creator.id, values, commit=False
        )
        assert item.cloud_project_id == group.id
        link = test_db.query(ThreadProjectLink).filter_by(loop_item_id=item.id).one()
        assert link.parent_id == project_id
        assert link.status == "active"
        snapshot = project_board_snapshot_service.get(test_db, project_id, creator.id)
        assert [row.id for row in snapshot.items] == [item.id]


def test_classified_creation_rolls_back_thread_and_link_together(test_db, test_user):
    project_id, _ = _project(test_db, test_user.id, 0)
    group = make_group(test_db, test_user, [])
    before = group.next_item_number
    with pytest.raises(RuntimeError, match="abort creation"):
        with test_db.begin_nested():
            item = loop_item_service.create(
                test_db,
                group.id,
                test_user.id,
                LoopItemCreate(
                    title="Atomic creation", classification_project_id=str(project_id)
                ),
                commit=False,
            )
            assert (
                test_db.query(ThreadProjectLink).filter_by(loop_item_id=item.id).count()
                == 1
            )
            raise RuntimeError("abort creation")
    assert test_db.query(LoopItem).filter_by(cloud_project_id=group.id).count() == 0
    assert test_db.query(ThreadProjectLink).count() == 0
    test_db.refresh(group)
    assert group.next_item_number == before


@pytest.mark.parametrize(
    "state,visible,writable",
    [
        ("observer", True, True),
        ("viewer", True, False),
        ("removed", False, False),
        ("pending", False, False),
        ("archived", True, False),
        ("deleted_group", False, False),
        ("deleted_thread", False, False),
        ("unlinked", False, False),
        ("deleted_link", False, False),
    ],
)
def test_project_role_never_replaces_group_role(
    test_db, test_user, state, visible, writable
):
    project_id, _ = _project(test_db, test_user.id, 0)
    owner = person(test_db, "group-owner")
    group = make_group(
        test_db, owner, [(test_user, "Viewer" if state == "viewer" else "Developer")]
    )
    thread = make_thread(test_db, group, owner)
    thread.sequence_number = 1
    thread.priority = "none"
    link = ThreadProjectLink(
        parent_id=project_id, loop_item_id=thread.id, status="active"
    )
    test_db.add(link)
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_id=str(test_user.id),
        )
        .one()
    )
    if state == "removed":
        test_db.delete(grant)
    elif state == "pending":
        grant.status = "pending"
    elif state == "archived":
        group.status = "archived"
    elif state == "deleted_group":
        group.deleted_at = datetime(2026, 11, 1)
    elif state == "deleted_thread":
        thread.deleted_at = datetime(2026, 11, 1)
    elif state == "unlinked":
        link.status = "removed"
    elif state == "deleted_link":
        link.deleted_at = datetime(2026, 11, 1)
    test_db.flush()

    snapshot = project_board_snapshot_service.get(test_db, project_id, test_user.id)

    assert bool(snapshot.items) is visible
    if visible:
        item = snapshot.items[0]
        assert item.id == thread.id
        assert str(item.cloud_project_id) == str(group.id)
        assert item.group_id == str(group.id)
        assert item.group_name == group.name
        assert item.joined is False
        assert item.can_edit is writable
        assert item.permissions.comment is False
        assert item.permissions.execute is False
    assert snapshot.task_bindings == []


def test_project_filters_apply_to_linked_threads(test_db, test_user):
    project_id, _ = _project(test_db, test_user.id, 0)
    owner = person(test_db, "group-owner")
    group = make_group(test_db, owner, [(test_user, "Developer")])
    thread = make_thread(test_db, group, owner, owner)
    thread.sequence_number = 1
    thread.priority = "none"
    test_db.add(
        ThreadProjectLink(parent_id=project_id, loop_item_id=thread.id, status="active")
    )
    test_db.flush()

    _, matched = project_board_snapshot_service.list_item_views(
        test_db,
        project_id,
        test_user.id,
        assignee_type="user",
        assignee_id=str(owner.id),
    )
    _, absent = project_board_snapshot_service.list_item_views(
        test_db,
        project_id,
        test_user.id,
        assignee_type="user",
        assignee_id=str(test_user.id),
    )
    _, not_running = project_board_snapshot_service.list_item_views(
        test_db, project_id, test_user.id, execution_state="running"
    )

    assert [row.id for row in matched] == [thread.id]
    assert absent == []
    assert not_running == []


def test_project_viewer_retains_separate_group_edit_role(test_db, test_user):
    project_id, _ = _project(test_db, test_user.id, 0)
    reader = person(test_db, "project-reader")
    group = make_group(test_db, test_user, [(reader, "Developer")])
    thread = make_thread(test_db, group, test_user)
    thread.sequence_number = 1
    thread.priority = "none"
    test_db.add_all(
        [
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(project_id),
                entity_type="user",
                entity_id=str(reader.id),
                user_id=reader.id,
                role="Viewer",
                status="approved",
            ),
            ThreadProjectLink(
                parent_id=project_id, loop_item_id=thread.id, status="active"
            ),
        ]
    )
    test_db.flush()

    snapshot = project_board_snapshot_service.get(test_db, project_id, reader.id)

    assert [item.id for item in snapshot.items] == [thread.id]
    assert snapshot.items[0].can_edit is True
    assert snapshot.items[0].permissions.comment is False
    assert snapshot.task_bindings == []
    assert snapshot.members == []


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("group_access", [True, False])
def test_external_project_also_aggregates_authorized_threads(
    test_db, test_user, monkeypatch, provider, group_access
):
    project_id, _ = _project(test_db, test_user.id, 0)
    project = test_db.get(CloudProject, project_id)
    project.metadata_json = {**(project.metadata_json or {}), "task_provider": provider}
    owner = person(test_db, "group-owner")
    group = make_group(test_db, owner, [(test_user, "Viewer")] if group_access else [])
    thread = make_thread(test_db, group, owner)
    thread.sequence_number = 1
    thread.priority = "none"
    test_db.add(
        ThreadProjectLink(parent_id=project_id, loop_item_id=thread.id, status="active")
    )
    test_db.flush()
    monkeypatch.setattr(
        "app.services.project_board_snapshot.external_loop_item_provider.list",
        lambda *_args, **_kwargs: [],
    )

    _, items = project_board_snapshot_service.list_item_views(
        test_db, project_id, test_user.id
    )

    assert [item.id for item in items] == ([thread.id] if group_access else [])
    if group_access:
        assert items[0].group_id == str(group.id)
        assert items[0].can_edit is False
