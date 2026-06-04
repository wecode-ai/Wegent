# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds import task_kinds_service


def _create_placeholder(db: Session, user_id: int) -> TaskResource:
    placeholder = TaskResource(
        user_id=user_id,
        kind="Placeholder",
        name="temp-placeholder",
        namespace="default",
        json={
            "kind": "Placeholder",
            "metadata": {"name": "temp-placeholder", "namespace": "default"},
            "spec": {},
            "status": {"state": "Reserved"},
        },
        is_active=TaskResource.STATE_DELETED,
    )
    db.add(placeholder)
    db.commit()
    db.refresh(placeholder)
    return placeholder


def test_create_task_id_allocates_new_placeholder_instead_of_reusing_existing(
    test_db: Session,
    test_user: User,
):
    existing_placeholder = _create_placeholder(test_db, test_user.id)

    first_id = task_kinds_service.create_task_id(test_db, test_user.id)
    second_id = task_kinds_service.create_task_id(test_db, test_user.id)

    assert first_id != existing_placeholder.id
    assert second_id != existing_placeholder.id
    assert first_id != second_id

    placeholders = (
        test_db.query(TaskResource)
        .filter(
            TaskResource.user_id == test_user.id, TaskResource.kind == "Placeholder"
        )
        .all()
    )
    assert len(placeholders) == 3
    assert len({placeholder.name for placeholder in placeholders}) == 3
