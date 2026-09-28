# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execute a submitted card turn independently of its receipt's short lock."""

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.db.session import SessionLocal
from app.models.subtask import SubtaskStatus
from app.models.user import User
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.im.task_continuation_service import get_task_team
from app.stores.tasks import subtask_store, task_store
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from app.services.channels.dingtalk.handler import DingTalkChannelHandler
    from app.services.channels.handler import MessageContext


@dataclass(frozen=True)
class CardTaskExecution:
    task_id: int
    subtask_id: int
    user_subtask_id: int
    user_id: int
    context: "MessageContext"
    params: TaskCreationParams

    def claim(self) -> bool:
        """Claim a prepared turn once using its existing persisted task status."""
        with SessionLocal() as db:
            subtask = subtask_store.get_basic_by_id_for_update(
                db, subtask_id=self.subtask_id
            )
            if subtask is None or subtask.status != SubtaskStatus.PENDING:
                return False
            subtask.status = SubtaskStatus.RUNNING
            db.commit()
            return True

    @trace_async(
        span_name="dingtalk.card.execute", tracer_name="backend.channels.dingtalk"
    )
    async def run(self, handler: "DingTalkChannelHandler") -> bool:
        with SessionLocal() as db:
            db.expire_on_commit = False
            task = task_store.get_by_id(db, task_id=self.task_id)
            subtask = subtask_store.get_by_id(db, subtask_id=self.subtask_id)
            user = db.get(User, self.user_id)
            if task is None or subtask is None:
                raise ValueError("追问对应的任务或账号已不可用")
            if subtask.status != SubtaskStatus.RUNNING:
                return False
            try:
                if user is None:
                    raise ValueError("追问对应的账号已不可用")
                return await handler._trigger_private_im_task_response(
                    db=db,
                    task=task,
                    assistant_subtask=subtask,
                    team=get_task_team(db, task),
                    user=user,
                    user_subtask_id=self.user_subtask_id,
                    message=self.context.content,
                    message_context=self.context,
                    params=self.params,
                )
            except (Exception, asyncio.CancelledError):
                # Dispatch handles cancellation after start; also settle a turn
                # interrupted during card initialization before dispatch began.
                db.rollback()
                db.refresh(subtask)
                if subtask.status in (SubtaskStatus.PENDING, SubtaskStatus.RUNNING):
                    db.refresh(task)
                    handler._mark_private_im_task_response_failed(
                        db,
                        task=task,
                        assistant_subtask=subtask,
                        error_message="追问执行在启动前中断，请重新提交",
                    )
                raise
