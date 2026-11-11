"""Project ranks preserve Group authority, classification and transaction atomicity."""

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, LoopItem, ThreadProjectLink
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.loop_items.service import loop_item_service
from app.services.project_board_snapshot import project_board_snapshot_service
from tests.services.test_project_board_snapshot_queries import _project
from tests.services.test_thread_participation import make_group, person


@pytest.fixture(autouse=True)
def no_external_chat_delivery(monkeypatch):
    monkeypatch.setattr(
        "app.services.project_chat.push.queue_project_chat_after_commit",
        lambda *args, **kwargs: None,
    )


def fixture(db, actor):
    project_id, _ = _project(db, actor.id, 0)
    other = person(db, "project-order-other")
    rows = []
    for index in range(3):
        group = make_group(db, other, [(actor, "Developer")])
        group.project_key = f"ORDER{index}"
        db.flush()
        item = loop_item_service.create(
            db,
            int(group.id),
            actor.id,
            LoopItemCreate(
                title=f"Card{index}", status="completed" if index == 1 else "pending"
            ),
        )
        db.add(
            ThreadProjectLink(
                parent_id=project_id, loop_item_id=item.id, status="active"
            )
        )
        rows.append(item)
    db.commit()
    return project_id, rows


def move(db, actor, project, item, before, **fields):
    return loop_item_service.update(
        db,
        item.id,
        actor.id,
        LoopItemUpdate(
            version=item.version,
            position={"beforeItemId": before, "classificationProjectId": project},
            **fields,
        ),
    )


def test_project_order_persists_without_mutating_foreign_group_items(
    test_db, test_user
):
    project, rows = fixture(test_db, test_user)
    first, completed, last = rows
    before = {
        row.id: (row.cloud_project_id, row.sort_order, row.version) for row in rows
    }
    move(test_db, test_user, project, completed, first.id, status="pending")
    test_db.expire_all()
    _, visible = project_board_snapshot_service.list_item_views(
        test_db, int(project), test_user.id
    )
    ordered = [row.id for row in sorted(visible, key=lambda row: row.sort_order)]
    assert ordered.index(completed.id) + 1 == ordered.index(first.id)
    for row in rows:
        test_db.refresh(row)
        assert (row.cloud_project_id, row.sort_order) == before[row.id][:2]
        if row.id != completed.id:
            assert row.version == before[row.id][2]
    assert completed.status == "pending"
    move(test_db, test_user, project, last, completed.id)
    test_db.expire_all()
    _, visible = project_board_snapshot_service.list_item_views(
        test_db, int(project), test_user.id
    )
    ordered = [row.id for row in sorted(visible, key=lambda row: row.sort_order)]
    assert ordered == [last.id, completed.id, first.id]
    assert all(row.group_id == before[row.id][0] for row in visible)


@pytest.mark.parametrize(
    "invalid",
    [
        "foreign-project",
        "foreign-parent",
        "group-viewer",
        "anchor-revoked",
        "invalid-state",
    ],
)
def test_project_order_rejects_invalid_scope_atomically(test_db, test_user, invalid):
    project, rows = fixture(test_db, test_user)
    first, moving, _ = rows
    scope = project
    fields = {"status": "pending"}
    if invalid == "foreign-project":
        scope, _ = _project(test_db, test_user.id, 0)
    elif invalid == "foreign-parent":
        parent = loop_item_service.create(
            test_db,
            int(first.cloud_project_id),
            test_user.id,
            LoopItemCreate(title="Other parent", status="pending"),
        )
        first.parent_id = parent.id
    elif invalid in ("group-viewer", "anchor-revoked"):
        owner = (
            moving.cloud_project_id
            if invalid == "group-viewer"
            else first.cloud_project_id
        )
        grant = (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="CollaborationChatGroup",
                resource_id=int(owner),
                entity_id=str(test_user.id),
            )
            .one()
        )
        grant.role = "Viewer" if invalid == "group-viewer" else grant.role
        if invalid == "anchor-revoked":
            grant.status = "rejected"
    else:
        fields["status"] = "unknown"
    test_db.commit()
    before = (moving.status, moving.version, moving.cloud_project_id)
    metadata = dict(test_db.get(CloudProject, project).metadata_json or {})
    with pytest.raises(HTTPException):
        move(test_db, test_user, scope, moving, first.id, **fields)
    test_db.rollback()
    test_db.refresh(moving)
    assert (moving.status, moving.version, moving.cloud_project_id) == before
    assert (test_db.get(CloudProject, project).metadata_json or {}) == metadata


def test_project_ranks_never_expose_or_rewrite_inaccessible_group_items(
    test_db, test_user
):
    from app.services.cloud_projects.responses import project_response

    project_id, rows = fixture(test_db, test_user)
    other = person(test_db, "hidden-project-order-owner")
    hidden_group = make_group(test_db, other, [])
    hidden_group.project_key = "HIDDENORDER"
    test_db.flush()
    hidden = loop_item_service.create(
        test_db,
        int(hidden_group.id),
        other.id,
        LoopItemCreate(title="HiddenGroupSecret", status="pending"),
    )
    test_db.add(
        ThreadProjectLink(parent_id=project_id, loop_item_id=hidden.id, status="active")
    )
    project = test_db.get(CloudProject, project_id)
    project.metadata_json = {
        **(project.metadata_json or {}),
        "board_item_order": {hidden.id: 432},
    }
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(rows[0].cloud_project_id),
            entity_id=str(test_user.id),
        )
        .one()
    )
    grant.role = "Viewer"
    test_db.commit()
    version = hidden.version
    move(test_db, test_user, project_id, rows[1], rows[0].id, status="pending")
    test_db.expire_all()
    assert project.metadata_json["board_item_order"][hidden.id] == 432
    assert hidden.version == version
    _, values = project_board_snapshot_service.list_item_views(
        test_db, int(project_id), test_user.id
    )
    assert hidden.id not in [row.id for row in values]
    payload = project_response(test_db, project, test_user).model_dump_json()
    assert "board_item_order" not in payload
    assert hidden.id not in payload
    assert "HiddenGroupSecret" not in payload
    with pytest.raises(HTTPException) as rejected:
        loop_item_service.get(test_db, hidden.id, test_user.id)
    assert rejected.value.status_code == 404
