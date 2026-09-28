# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Receive card actions without changing the IM session's selected task."""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from dingtalk_stream import AckMessage, CallbackHandler, CallbackMessage, ChatbotMessage
from fastapi import HTTPException

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.services.channels.dingtalk.card_adapter import TemplateChatCardAdapter
from app.services.channels.dingtalk.card_binding import (
    CardBinding,
    load_binding,
)
from app.services.channels.dingtalk.card_execution import CardTaskExecution
from app.services.channels.dingtalk.card_images import (
    download_card_images,
    parse_image_urls,
)
from app.services.channels.dingtalk.card_inbox import (
    SUBMISSION_LOCK_SECONDS,
    SUBMISSION_TIMEOUT_SECONDS,
    CardActionInbox,
    CardActionRecord,
)
from app.services.channels.dingtalk.message_logging import log_dingtalk_message
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from app.services.channels.dingtalk.handler import DingTalkChannelHandler

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CardFollowUp:
    text: str
    image_urls: list[str]
    actor_staff_id: str | None = None


def parse_follow_up(data: dict, binding: CardBinding) -> CardFollowUp:
    """Use the stored contract and verified actor, never client-supplied task IDs."""
    if data.get("type") != "actionCallback":
        raise ValueError("不支持的卡片事件")
    address = binding.incoming_data
    if (
        not address.get("senderStaffId")
        or not address.get("senderCorpId")
        or data.get("corpId") != address["senderCorpId"]
    ):
        raise ValueError("卡片身份信息不完整或企业不匹配")
    actor = data.get("userId")
    if not isinstance(actor, str) or not actor.strip() or data.get("userIdType") != 1:
        raise ValueError("卡片回调缺少有效的员工身份")
    if address.get("conversationType") == "2":
        if data.get("spaceType") != "im" or data.get("spaceId") != address.get(
            "conversationId"
        ):
            raise ValueError("请在原钉钉群内使用此任务卡片")
    if actor != address["senderStaffId"] and (
        binding.runtime_task or address.get("conversationType") != "2"
    ):
        raise ValueError("该卡片仅支持原提问者追问")
    if not binding.config.follow_up_enabled:
        raise ValueError("此卡片未启用追问")
    content = data.get("content", {})
    if isinstance(content, str):
        content = json.loads(content)
    if not isinstance(content, dict):
        raise ValueError("无效的卡片事件")
    private = content.get("cardPrivateData", {})
    if not isinstance(private, dict):
        raise ValueError("无效的卡片事件")
    actions = private.get("actionIds", [])
    if not isinstance(actions, list) or binding.config.follow_up_action not in actions:
        raise ValueError("未知的追问动作")
    params = private.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("无效的追问参数")
    text = params.get(binding.config.follow_up_text_key, "")
    if not isinstance(text, str):
        raise ValueError("追问内容必须是文本")
    images = parse_image_urls(params.get(binding.config.follow_up_images_key))
    if not text.strip() and not images:
        raise ValueError("请输入追问内容或上传图片")
    if len(text) > 20000:
        raise ValueError("追问内容不能超过 20000 字")
    if not binding.ready:
        raise ValueError("回答仍在生成，请完成后再追问")
    return CardFollowUp(text.strip(), images, actor)


class DingTalkCardCallbackHandler(CallbackHandler):
    """ACK promptly; retain background jobs and deduplicate Stream retries."""

    def __init__(self, handler: "DingTalkChannelHandler"):
        super().__init__()
        self.handler = handler
        self._jobs: set[asyncio.Task] = set()
        self._scheduled: set[str] = set()
        self.inbox = CardActionInbox(handler.channel_id)
        self._recovery: asyncio.Task | None = None

    @trace_async(
        span_name="dingtalk.card.action", tracer_name="backend.channels.dingtalk"
    )
    async def process(self, callback: CallbackMessage) -> tuple[int, str]:
        log_context = {"channel_id": self.handler.channel_id}
        try:
            data = callback.data
            log_context.update(
                event_id=callback.headers.message_id,
                outTrackId=data.get("outTrackId"),
            )
            log_dingtalk_message(
                logger, "card_action_received", {**log_context, "data": data}
            )
            track_id = data.get("outTrackId")
            if not isinstance(track_id, str) or not track_id or len(track_id) > 256:
                raise ValueError("无效的卡片 ID")
            config = self.handler.chat_card_config
            if (
                not config
                or not self.handler._use_ai_card
                or not config.follow_up_enabled
            ):
                raise ValueError("该机器人未启用聊天卡片")
            binding = await load_binding(self.handler.channel_id, track_id)
            if binding is None:
                raise ValueError("卡片对话已过期，请重新 @机器人")
            follow_up = parse_follow_up(data, binding)
            event_id = callback.headers.message_id
            if not event_id:
                raise ValueError("卡片事件缺少消息 ID")
            record = CardActionRecord(
                binding=binding,
                track_id=track_id,
                event_id=event_id,
                text=follow_up.text,
                image_urls=follow_up.image_urls,
                actor_staff_id=follow_up.actor_staff_id,
            )
            if not await self.inbox.enqueue(record):
                log_dingtalk_message(logger, "card_action_duplicate", log_context)
                return AckMessage.STATUS_OK, "{}"
            log_dingtalk_message(
                logger,
                "card_follow_up_accepted",
                {
                    **log_context,
                    "task_id": binding.task_id,
                    "text": follow_up.text,
                    "image_count": len(follow_up.image_urls),
                    "actor_staff_id": follow_up.actor_staff_id,
                },
            )
            self._schedule(event_id)
            # Omitting cardData/userPrivateData preserves the existing answer.
            return AckMessage.STATUS_OK, "{}"
        except (ValueError, TypeError, AttributeError) as exc:
            log_dingtalk_message(
                logger, "card_action_rejected", {**log_context, "reason": str(exc)}
            )
            return AckMessage.STATUS_BAD_REQUEST, str(exc)
        except Exception:
            logger.exception("[DingTalkCard] Could not accept card action")
            return AckMessage.STATUS_SYSTEM_EXCEPTION, "追问暂时无法提交，请稍后重试"

    def start(self) -> None:
        self._recovery = asyncio.create_task(self._recover())

    async def process_quote(self, data: dict) -> bool:
        from app.services.channels.dingtalk.card_quotes import route_quoted_card

        return await route_quoted_card(self, data)

    def _schedule(self, event_id: str) -> None:
        if event_id in self._scheduled or len(self._jobs) >= 16:
            return
        self._scheduled.add(event_id)
        job = asyncio.create_task(self._run_record(event_id))
        self._jobs.add(job)
        job.add_done_callback(self._jobs.discard)
        job.add_done_callback(lambda _: self._scheduled.discard(event_id))

    async def _recover(self) -> None:
        while True:
            try:
                for event_id in await self.inbox.outstanding():
                    self._schedule(event_id)
            except Exception:
                logger.exception("[DingTalkCard] Could not recover pending actions")
            await asyncio.sleep(10)

    async def drain(self) -> None:
        if self._recovery:
            self._recovery.cancel()
            await asyncio.gather(self._recovery, return_exceptions=True)
            self._recovery = None
        if self._jobs:
            _, pending = await asyncio.wait(list(self._jobs), timeout=5)
            for job in pending:
                job.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    @trace_async(
        span_name="dingtalk.card.receipt", tracer_name="backend.channels.dingtalk"
    )
    async def _run_record(self, event_id: str) -> None:
        try:
            async with self.inbox.claim(event_id) as acquired:
                if not acquired:
                    return
                record, execution = await asyncio.wait_for(
                    self._submit_record(event_id), timeout=SUBMISSION_TIMEOUT_SECONDS
                )
            if record is None:
                return
            # Neither receipt nor task submission locks span model execution.
            # Claiming the persisted turn also fences competing recovery workers.
            if execution is not None and execution.claim():
                await self._execute(record, execution)
            await self._update_status(
                record, "sent" if record.state == "completed" else "failed"
            )
            await self.inbox.settle(record)
        except Exception:
            logger.exception("[DingTalkCard] Action receipt retained for recovery")

    async def _submit_record(
        self, event_id: str
    ) -> tuple[CardActionRecord | None, CardTaskExecution | None]:
        record = await self.inbox.load(event_id)
        if record is None:
            return None, None
        execution = None
        if record.state in ("running", "completed"):
            recovered = self._recover_submission(record)
            if recovered is not None:
                execution = (
                    recovered if isinstance(recovered, CardTaskExecution) else None
                )
                record.state = "completed"
            elif record.state == "running":
                await self._report_error(
                    self._reply_binding(record.binding, record.actor_staff_id),
                    "追问处理曾中断，执行结果待确认。请先查看会话记录，避免重复提交。",
                )
                record.state = "uncertain"
        elif record.state == "pending":
            config = self.handler.chat_card_config
            if (
                not config
                or not self.handler._use_ai_card
                or not config.follow_up_enabled
            ):
                await self._report_error(
                    self._reply_binding(record.binding, record.actor_staff_id),
                    "该机器人已停用卡片追问",
                )
                record.state = "failed"
            else:
                record.state = "running"
                await self.inbox.save(record)
                try:
                    await self._update_status(record, "sending")
                except Exception:
                    logger.exception("[DingTalkCard] Could not show sending state")
                result = await self._run(
                    record.binding,
                    CardFollowUp(record.text, record.image_urls, record.actor_staff_id),
                    event_id,
                )
                execution = result if isinstance(result, CardTaskExecution) else None
                record.state = "completed" if result else "failed"
        # A completed receipt means submitted, not that the model has finished.
        await self.inbox.save(record)
        return record, execution

    async def _execute(
        self, record: CardActionRecord, execution: CardTaskExecution
    ) -> None:
        try:
            await execution.run(self.handler)
        except Exception:
            logger.exception(
                "[DingTalkCard] Submitted execution failed task=%s subtask=%s",
                execution.task_id,
                execution.subtask_id,
            )
            try:
                await self._report_error(
                    self._reply_binding(record.binding, record.actor_staff_id),
                    "追问执行失败，请查看任务状态后重试",
                )
            except Exception:
                logger.exception("[DingTalkCard] Could not report execution failure")

    def _recover_submission(
        self, record: CardActionRecord
    ) -> CardTaskExecution | bool | None:
        from app.models.subtask import SubtaskRole, SubtaskStatus
        from app.services.im.task_continuation_service import build_existing_task_params
        from app.stores.tasks import subtask_store, task_store

        binding = record.binding
        if binding.runtime_task or not isinstance(binding.task_id, int):
            return None
        with SessionLocal() as db:
            message = subtask_store.get_user_by_task_source_message(
                db,
                task_id=binding.task_id,
                channel_type="dingtalk",
                channel_id=binding.channel_id,
                message_id=record.event_id,
            )
            if message is None:
                return None
            subtask = subtask_store.get_by_task_parent_id_and_role(
                db,
                task_id=message.task_id,
                parent_id=message.message_id,
                role=SubtaskRole.ASSISTANT,
            )
            if subtask is None:
                return None
            if subtask.status != SubtaskStatus.PENDING:
                return True
            task = task_store.get_by_id(db, task_id=message.task_id)
            if task is None:
                return None
            context = self._context(
                record.binding, message.prompt, record.event_id, record.actor_staff_id
            )
            params = build_existing_task_params(
                task, message=message.prompt, message_source=message.result["source"]
            )
            params.client_origin = task.client_origin
            params.is_group_chat = task.is_group_chat
            return CardTaskExecution(
                task_id=task.id,
                subtask_id=subtask.id,
                user_subtask_id=message.id,
                user_id=message.sender_user_id or message.user_id,
                context=context,
                params=params,
            )

    async def _update_status(self, record: CardActionRecord, status: str) -> None:
        if not record.binding.config.follow_up_status_key:
            return
        adapter = TemplateChatCardAdapter(
            self.handler._dingtalk_client,
            None,
            record.binding.config,
            record.binding.channel_id,
            record.track_id,
        )
        try:
            await adapter.set_follow_up_status(status)
        finally:
            await adapter.close()

    @trace_async(
        span_name="dingtalk.card.follow_up", tracer_name="backend.channels.dingtalk"
    )
    async def _run(
        self, binding: CardBinding, follow_up: CardFollowUp, event_id: str
    ) -> CardTaskExecution | bool:
        log_dingtalk_message(
            logger,
            "card_follow_up_started",
            {
                "channel_id": binding.channel_id,
                "task_id": binding.task_id,
                "event_id": event_id,
            },
        )
        context = self._context(
            binding, follow_up.text, event_id, follow_up.actor_staff_id
        )
        reply_binding = self._reply_binding(binding, follow_up.actor_staff_id)
        context.extra_data["card_image_urls"] = follow_up.image_urls
        redis = None
        lock = None
        acquired = False
        try:
            redis = await cache_manager._get_client()
            lock = redis.lock(
                f"dingtalk:card_task:{binding.task_id}",
                timeout=SUBMISSION_LOCK_SECONDS,
                blocking=False,
            )
            acquired = await lock.acquire()
            if not acquired:
                raise ValueError("当前任务正在处理追问，请稍后再试")
            with SessionLocal() as db:
                db.expire_on_commit = False
                is_other_actor = follow_up.actor_staff_id not in (
                    None,
                    binding.incoming_data.get("senderStaffId"),
                )
                if (
                    is_other_actor
                    and self.handler.user_mapping_config.mode == "select_user"
                ):
                    raise ValueError(
                        "多人协作需要独立账号，请将钉钉通道用户映射改为员工 ID 或邮箱"
                    )
                user = await self.handler.resolve_user(db, context)
                if not user or (not is_other_actor and user.id != binding.user_id):
                    raise ValueError("当前账号无权访问该卡片对话")
                if is_other_actor and user.id == binding.user_id:
                    raise ValueError(
                        "不同钉钉用户映射到了同一个账号，请检查用户映射配置"
                    )
                context.sender_name = user.user_name
                if binding.runtime_task:
                    return await self._continue_runtime(db, user, binding, context)
                else:
                    return await self._continue_task(db, user, binding, context)
        except HTTPException as exc:
            message = (
                "当前任务仍在执行，请完成后再追问"
                if exc.detail == "Task is still running"
                else "原任务已不可用或无权访问"
            )
            await self._report_error(reply_binding, message)
        except ValueError as exc:
            await self._report_error(reply_binding, str(exc))
        except Exception:
            logger.exception("[DingTalkCard] Follow-up failed task=%s", binding.task_id)
            await self._report_error(reply_binding, "追问处理失败，请稍后重试")
        finally:
            try:
                if acquired:
                    await lock.release()
            finally:
                if redis:
                    await redis.aclose()
        return False

    def _reply_binding(self, binding: CardBinding, actor: str | None) -> CardBinding:
        if not actor or actor == binding.incoming_data.get("senderStaffId"):
            return binding
        return binding.model_copy(
            update={
                "incoming_data": {
                    **binding.incoming_data,
                    "senderStaffId": actor,
                    "senderId": actor,
                    "senderNick": actor,
                }
            }
        )

    def _context(
        self, binding: CardBinding, text: str, event_id: str, actor: str | None = None
    ) -> Any:
        data = {
            **self._reply_binding(binding, actor).incoming_data,
            "msgId": event_id,
            "msgtype": "text",
            "text": {"content": text},
            "isInAtList": True,
        }
        message = ChatbotMessage.from_dict(data)
        message._wegent_callback_data = data
        context = self.handler.parse_message(message)
        context.extra_data["card_follow_up"] = True
        context.extra_data["chat_card"] = binding.config.model_dump()
        return context

    async def _continue_task(
        self, db: Any, user: Any, binding: CardBinding, context: Any
    ) -> CardTaskExecution:
        from app.services.chat.storage.task_manager import (
            check_task_status,
            create_task_and_subtasks,
            get_task_with_access_check,
        )
        from app.services.im.task_continuation_service import (
            build_existing_task_params,
            get_task_team,
        )

        if not isinstance(binding.task_id, int):
            raise ValueError("原任务地址无效，请重新 @机器人")
        from app.services.channels.dingtalk.card_collaboration import (
            join_card_task,
            notify_card_task_joined,
        )

        task, _ = get_task_with_access_check(db, binding.task_id, binding.user_id)
        if task is None:
            raise ValueError("原任务已不可用或无权访问")
        check_task_status(db, task)
        await self._load_images(context)
        task, joined = join_card_task(db, binding, user.id)
        team = get_task_team(db, task)
        source = {
            **self.handler._build_message_source_metadata(),
            "channel_id": binding.channel_id,
            "message_id": context.extra_data["message_id"],
        }
        params = build_existing_task_params(
            task, message=context.content, message_source=source
        )
        params.client_origin = task.client_origin
        params.is_group_chat = task.is_group_chat
        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=context.content,
            params=params,
            task_id=task.id,
            should_trigger_ai=True,
            commit=False,
        )
        self._persist_images(db, user.id, result.user_subtask.id, context, commit=False)
        # Recovery may start this turn as soon as its source event is visible.
        # Commit the user message, assistant and attachments together.
        db.commit()
        if joined:
            try:
                await notify_card_task_joined(db, result.task, user.id, binding.user_id)
            except Exception:
                logger.exception("[DingTalkCard] Could not notify task collaboration")
        return CardTaskExecution(
            task_id=result.task.id,
            subtask_id=result.assistant_subtask.id,
            user_subtask_id=result.user_subtask.id,
            user_id=user.id,
            context=context,
            params=params,
        )

    async def _continue_runtime(
        self, db: Any, user: Any, binding: CardBinding, context: Any
    ) -> bool:
        from app.services.im.session_service import im_session_service

        await self._load_images(context)
        attachment_ids = self._persist_images(db, user.id, 0, context)
        session = await im_session_service.get_or_create_private_session(
            db=db,
            user_id=user.id,
            channel_type="dingtalk",
            channel_id=binding.channel_id,
            conversation_id=context.conversation_id,
            sender_id=context.sender_id,
            proactive_recipient_id=context.proactive_recipient_id,
            display_name=context.sender_name or "",
        )
        return await self.handler._execute_private_im_continue_runtime_task(
            db=db,
            user=user,
            im_session=session,
            message=context.content,
            message_context=context,
            runtime_task=binding.runtime_task,
            attachment_ids=attachment_ids,
        )

    async def _load_images(self, context: Any) -> None:
        context.images = await download_card_images(
            context.extra_data.get("card_image_urls", [])
        )
        if context.images and not context.content:
            context.content = "请查看图片"

    def _persist_images(
        self,
        db: Any,
        user_id: int,
        subtask_id: int,
        context: Any,
        *,
        commit: bool = True,
    ) -> list[int]:
        if not context.images:
            return []
        try:
            ids = self.handler._persist_im_images_as_attachments(
                db=db,
                user_id=user_id,
                subtask_id=subtask_id,
                images=context.images,
                strict=True,
            )
            if commit:
                db.commit()
        except Exception as exc:
            db.rollback()
            raise ValueError("追问图片保存失败，请重新发送") from exc
        log_dingtalk_message(
            logger,
            "card_follow_up_images_persisted",
            {
                "channel_id": self.handler.channel_id,
                "event_id": context.extra_data.get("message_id"),
                "user_subtask_id": subtask_id,
                "image_count": len(context.images),
                "attachment_ids": ids,
            },
        )
        return ids

    async def _report_error(self, binding: CardBinding, message: str) -> None:
        log_dingtalk_message(
            logger,
            "card_follow_up_failed",
            {
                "channel_id": binding.channel_id,
                "task_id": binding.task_id,
                "reason": message,
            },
        )
        from app.services.channels.dingtalk.sender import DingTalkRobotSender

        credential = self.handler._dingtalk_client.credential
        sender = DingTalkRobotSender(credential.client_id, credential.client_secret)
        result = await sender.send_text_message(
            [binding.incoming_data["senderStaffId"]], message
        )
        if not result.get("success"):
            raise RuntimeError("Could not deliver card follow-up error notification")
