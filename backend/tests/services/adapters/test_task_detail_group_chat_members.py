# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Group chat detection on the task detail endpoint.

Accepting a share link copies the task and leaves a ResourceMember row on the
original task. Share records are access grants, not group chat membership: if
they count as members the original task is reported as a group chat and every
follow-up message needs an "@team" mention before the agent runs.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.services.adapters.task_kinds.task_detail_helpers import (
    add_group_chat_info_to_task,
)

TASK_ID = 559101662882104
OWNER_ID = 4068
RECIPIENT_ID = 2300


def _member(
    entity_id: int,
    *,
    copied_resource_id: int = 0,
    status: str = MemberStatus.APPROVED.value,
) -> ResourceMember:
    """Build an approved ResourceMember row for the task under test."""
    return ResourceMember(
        resource_type=ResourceType.TASK.value,
        resource_id=TASK_ID,
        entity_type="user",
        entity_id=str(entity_id),
        role=ResourceRole.Maintainer.value,
        status=status,
        copied_resource_id=copied_resource_id,
    )


def _task_detail(db: Session) -> dict:
    """Run the detail helper and return the mutated task dict."""
    task_dict: dict = {"user_id": OWNER_ID}
    add_group_chat_info_to_task(
        db, task_id=TASK_ID, task_dict=task_dict, user_id=OWNER_ID
    )
    return task_dict


@pytest.mark.unit
def test_share_recipient_does_not_mark_task_as_group_chat(test_db: Session) -> None:
    """Copied share records are access grants, not group chat membership."""
    test_db.add(_member(RECIPIENT_ID, copied_resource_id=316109593138700))
    test_db.commit()

    task_dict = _task_detail(test_db)

    assert task_dict["is_group_chat"] is False
    assert task_dict["member_count"] is None
    assert task_dict["is_group_owner"] is True


@pytest.mark.unit
def test_direct_member_marks_task_as_group_chat(test_db: Session) -> None:
    """A real member still turns the task into a group chat."""
    test_db.add(_member(RECIPIENT_ID))
    test_db.commit()

    task_dict = _task_detail(test_db)

    assert task_dict["is_group_chat"] is True
    assert task_dict["member_count"] == 1


@pytest.mark.unit
def test_member_count_ignores_share_recipients(test_db: Session) -> None:
    """member_count only counts direct members, not share copies."""
    test_db.add_all(
        [
            _member(RECIPIENT_ID),
            _member(2301, copied_resource_id=316109593138701),
        ]
    )
    test_db.commit()

    task_dict = _task_detail(test_db)

    assert task_dict["is_group_chat"] is True
    assert task_dict["member_count"] == 1


@pytest.mark.unit
def test_pending_member_is_not_a_group_chat_member(test_db: Session) -> None:
    """Only approved members count."""
    test_db.add(_member(RECIPIENT_ID, status=MemberStatus.PENDING.value))
    test_db.commit()

    task_dict = _task_detail(test_db)

    assert task_dict["is_group_chat"] is False
