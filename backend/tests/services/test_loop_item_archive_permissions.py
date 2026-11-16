# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""CP13/CP14: archive and restore authorize all Issues before mutation."""

import uuid
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, loop_datetime_value_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.loop_items.external_provider import (
    PARENT_MARKER,
    external_loop_item_provider,
)
from app.services.loop_items.service import loop_item_service
from tests.api.test_deliveries_api import delivery_project


@pytest.fixture
def archive_member(test_db: Session, delivery_project: CloudProject) -> User:
    member = User(
        user_name=f"archive-member-{uuid.uuid4().hex}",
        password_hash="unused",
        email=f"{uuid.uuid4().hex}@example.com",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=delivery_project.id,
            entity_id=str(member.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.commit()
    return member


def queued_run(db: Session, project: CloudProject, item_id: str) -> LoopItemExecution:
    execution = LoopItemExecution(
        loop_item_id=item_id,
        cloud_project_id=project.id,
        executor_owner_user_id=project.created_by_user_id,
        status="queued",
    )
    db.add(execution)
    db.commit()
    return execution


def test_native_archive_rejects_private_descendant_without_mutation(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
) -> None:
    items = []
    for index in range(3):
        item = LoopItem(
            cloud_project_id=delivery_project.id,
            title=f"Archive generation {index}",
            parent_id=items[-1].id if items else None,
            created_by_user_id=archive_member.id if index == 0 else test_user.id,
            metadata_json={"security_level": "related" if index == 2 else "open"},
        )
        test_db.add(item)
        test_db.flush()
        items.append(item)
    test_db.commit()
    execution = queued_run(test_db, delivery_project, items[-1].id)
    versions = [item.version for item in items]
    assert loop_item_service.get(test_db, items[0].id, archive_member.id)

    with pytest.raises(HTTPException) as denied:
        loop_item_service.delete(test_db, items[0].id, archive_member.id)
    assert denied.value.status_code == 404
    test_db.expire_all()
    assert all(loop_datetime_value_is_unset(item.deleted_at) for item in items)
    assert [item.version for item in items] == versions
    assert execution.status == "queued"

    loop_item_service.delete(test_db, items[0].id, test_user.id)
    assert all(not loop_datetime_value_is_unset(item.deleted_at) for item in items)
    assert execution.status == "cancelled"
    archived_versions = [item.version for item in items]
    with pytest.raises(HTTPException) as denied_restore:
        loop_item_service.restore(test_db, items[0].id, archive_member.id)
    assert denied_restore.value.status_code == 404
    test_db.expire_all()
    assert all(not loop_datetime_value_is_unset(item.deleted_at) for item in items)
    assert [item.version for item in items] == archived_versions
    assert len(loop_item_service.restore(test_db, items[0].id, test_user.id)) == 3


@pytest.mark.parametrize("provider", ["github", "gitlab"])
def test_external_archive_rejects_private_descendant_before_provider_writes(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    project = delivery_project
    project.metadata_json = {
        "task_provider": provider,
        "provider_config": {"repository": "fixture/project"},
    }
    test_db.commit()
    issues: dict[int, dict[str, Any]] = {}
    for number in range(1, 4):
        labels = [f"wegent:creator:{test_user.id}:Owner"]
        labels.append(
            "wegent:security:related" if number == 3 else "wegent:security:open"
        )
        description = (
            f"{PARENT_MARKER} {project.project_key}-{number - 1}"
            if number > 1
            else "Parent"
        )
        issues[number] = {
            "iid": number,
            "number": number,
            "title": f"Issue {number}",
            "state": "open" if provider == "github" else "opened",
            "body" if provider == "github" else "description": description,
            "labels": (
                [{"name": label} for label in labels]
                if provider == "github"
                else labels
            ),
        }
    writes: list[int] = []

    def update(
        _project: CloudProject, number: int, payload: dict[str, Any]
    ) -> dict[str, Any]:
        writes.append(number)
        issues[number]["state"] = payload["state"]
        return issues[number]

    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_issues",
        lambda _project: list(issues.values()),
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, number: issues[number],
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_issues_state",
        lambda _project, state: [
            issue for issue in issues.values() if issue["state"] == state
        ],
    )
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update)
    execution = queued_run(test_db, project, f"{project.project_key}-3")
    root_id = f"{project.project_key}-1"
    assert external_loop_item_provider.get(test_db, root_id, archive_member.id)[
        "can_edit"
    ]

    with pytest.raises(HTTPException) as denied:
        external_loop_item_provider.archive(test_db, root_id, archive_member.id)
    assert denied.value.status_code == 404
    assert writes == []
    test_db.refresh(execution)
    assert execution.status == "queued"
    assert all(issue["state"] != "closed" for issue in issues.values())

    external_loop_item_provider.archive(test_db, root_id, test_user.id)
    assert set(writes) == {1, 2, 3}
    test_db.refresh(execution)
    assert execution.status == "cancelled"
    writes.clear()
    with pytest.raises(HTTPException) as denied_restore:
        external_loop_item_provider.restore(test_db, root_id, archive_member.id)
    assert denied_restore.value.status_code == 404
    assert writes == []
    assert all(issue["state"] == "closed" for issue in issues.values())
    assert len(external_loop_item_provider.restore(test_db, root_id, test_user.id)) == 3
