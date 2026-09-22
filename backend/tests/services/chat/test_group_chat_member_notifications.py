# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Group chat update fan-out for shared tasks.

Copying a shared task writes a ResourceMember row on the original task. That
row grants access to the copy, not group chat membership, so the copier must
not be notified about updates of the original task.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.services.chat.trigger.group_chat import notify_group_members_task_updated

TASK_ID = 559101662882104
OWNER_ID = 4068
MEMBER_ID = 2301
OTHER_MEMBER_ID = 2302
SHARE_RECIPIENT_ID = 2300
COPIED_TASK_ID = 316109593138700


class _RecordingEmitter:
    """Emitter stub that records the notified user ids."""

    def __init__(self) -> None:
        """Initialize the recorder."""
        self.notified: list[int] = []

    async def emit_group_chat_new_message(
        self,
        *,
        user_id: int,
        task_id: int,
        status: str,
        progress: int = 0,
    ) -> None:
        """Record one notification target."""
        self.notified.append(user_id)


def _member(entity_id: int, *, copied_resource_id: int = 0) -> ResourceMember:
    """Build an approved ResourceMember row for the task under test."""
    return ResourceMember(
        resource_type=ResourceType.TASK.value,
        resource_id=TASK_ID,
        entity_type="user",
        entity_id=str(entity_id),
        role=ResourceRole.Maintainer.value,
        status=MemberStatus.APPROVED.value,
        copied_resource_id=copied_resource_id,
    )


def _task() -> TaskResource:
    """Build a minimal Task resource the notifier can parse."""
    return TaskResource(
        id=TASK_ID,
        user_id=OWNER_ID,
        kind="Task",
        name="chat-task",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "chat-task", "namespace": "default"},
            "spec": {
                "title": "chat-task",
                "prompt": "",
                "teamRef": {"name": "wegent-wework", "namespace": "default"},
                "workspaceRef": {"name": "chat-task", "namespace": "default"},
                "is_group_chat": True,
            },
            "status": {"state": "Available", "status": "COMPLETED", "progress": 100},
        },
    )


def _record_emitter(monkeypatch: pytest.MonkeyPatch) -> _RecordingEmitter:
    """Patch the emitter factory with a recording stub."""
    emitter = _RecordingEmitter()
    monkeypatch.setattr(
        "app.services.chat.webpage_ws_extended_emitter.get_extended_emitter",
        lambda: emitter,
    )
    return emitter


@pytest.mark.unit
async def test_share_recipient_is_not_notified(
    test_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Share copies are not subscribed to the original task's updates."""
    test_db.add_all(
        [
            _member(MEMBER_ID),
            _member(SHARE_RECIPIENT_ID, copied_resource_id=COPIED_TASK_ID),
        ]
    )
    test_db.commit()
    emitter = _record_emitter(monkeypatch)

    await notify_group_members_task_updated(test_db, _task(), sender_user_id=OWNER_ID)

    assert emitter.notified == [MEMBER_ID]


@pytest.mark.unit
async def test_direct_member_is_notified_but_sender_is_skipped(
    test_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Direct members are notified; the sender and the owner as sender are not."""
    test_db.add_all([_member(MEMBER_ID), _member(OTHER_MEMBER_ID)])
    test_db.commit()
    emitter = _record_emitter(monkeypatch)

    await notify_group_members_task_updated(test_db, _task(), sender_user_id=MEMBER_ID)

    # The owner is still a member; only the sender is skipped.
    assert set(emitter.notified) == {OWNER_ID, OTHER_MEMBER_ID}
