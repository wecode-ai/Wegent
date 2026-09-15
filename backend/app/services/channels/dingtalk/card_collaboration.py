# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Join a shared DingTalk card's existing task using Wegent group membership."""

import logging

from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.services.channels.dingtalk.card_binding import CardBinding
from app.services.chat.storage.task_manager import get_task_with_access_check
from app.services.task_member_service import task_member_service


def join_card_task(
    db: Session, binding: CardBinding, user_id: int
) -> tuple[TaskResource, bool]:
    """The server-owned card binding grants joining in its original DingTalk group.

    Preserve removal decisions, task ownership and all other channels' rules.
    Callers commit conversion and membership together with the new user turn.
    """
    task, _ = get_task_with_access_check(db, binding.task_id, binding.user_id)
    if task is None:
        raise ValueError("原卡片对应的任务已不可用或原发言人已无访问权限")
    if user_id == task.user_id or task_member_service.is_member(db, task.id, user_id):
        return task, False
    if binding.runtime_task or binding.incoming_data.get("conversationType") != "2":
        raise ValueError("仅原钉钉群内的任务卡片支持自动加入协作")

    # Serialize joins across channels and API workers; both service mutations
    # below flush without releasing this row lock.
    task = (
        db.query(TaskResource)
        .filter(TaskResource.id == task.id)
        .with_for_update()
        .one()
    )
    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
        )
        .first()
    )
    if member and member.status == MemberStatus.REJECTED:
        raise ValueError("你已被移出此任务，请联系任务发起者重新邀请")
    if member and member.copied_resource_id:
        raise ValueError("请通过 Wegent 任务邀请加入原任务")
    if member and member.status == MemberStatus.APPROVED:
        return task, False
    task_member_service.convert_to_group_chat(db, task.id, commit=False)
    task_member_service.add_member(
        db, task.id, user_id, invited_by=binding.user_id, commit=False
    )
    return task, True


async def notify_card_task_joined(
    db: Session, task: TaskResource, user_id: int, invited_by: int
) -> None:
    """Expose the committed membership through the existing group chat UI."""
    from app.services.chat.webpage_ws_extended_emitter import get_extended_emitter

    try:
        inviter = task_member_service.get_user(db, invited_by)
        await get_extended_emitter().emit_task_invited(
            user_id=user_id,
            task_id=task.id,
            title=task.json.get("spec", {}).get("title", task.name),
            team_id=task_member_service.get_team_id(db, task.id) or 0,
            team_name=task_member_service.get_team_name(db, task.id) or "Unknown",
            invited_by={
                "user_id": invited_by,
                "user_name": inviter.user_name if inviter else "Unknown",
            },
        )
    except Exception:
        logging.getLogger(__name__).exception(
            "[DingTalkCard] Member notification failed task=%s user=%s",
            task.id,
            user_id,
        )
