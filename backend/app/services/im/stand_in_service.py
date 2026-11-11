# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dispatch IM input through the existing persistent stand-in conversation."""

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession
from app.models.user import User
from app.services.channels.callback import runtime_local_task_callback_key
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from app.services.user_mcp_service import UserMCPService
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

BINDING_PREFIX = "channel:stand_in_binding:"
SETUP_GUIDANCE = "请在 Wework“我的分身”中打开“分身详情”浮层，点击对应的 IM 渠道连接，并确认执行设备在线。"


def binding_key(user_id: int, session_key: str) -> str:
    return f"{BINDING_PREFIX}{user_id}:{session_key}"


async def get_stand_in_binding(user_id: int, session_key: str) -> dict[str, Any] | None:
    value = await cache_manager.get_or_raise(binding_key(user_id, session_key))
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("deviceId"), str)
        or not value["deviceId"].strip()
        or value.get("roleId") is not None
        and not isinstance(value["roleId"], str)
    ):
        raise ValueError("Invalid stored stand-in binding")
    return value


async def resolve_stand_in_target(
    db: Session, user: User, session: IMPrivateSession
) -> dict[str, Any] | None:
    if session.user_id != user.id:
        raise ValueError("IM session owner does not match the sender")
    binding = await get_stand_in_binding(user.id, session.session_key)
    if isinstance(binding, dict):
        device_id = binding.get("deviceId")
        role_id = binding.get("roleId")
    else:
        preferences = UserMCPService.load_preferences(user.preferences)
        device_id = preferences.get("default_execution_target")
        role_id = None
    if not isinstance(device_id, str) or not device_id or device_id == "cloud":
        return None
    identity = resolve_runtime_route_identity(
        db, user_id=user.id, submitted_device_id=device_id
    )
    if identity is None:
        return None
    suffix = f"role-{role_id}" if role_id else "primary"
    return {
        "deviceId": identity.logical_device_id,
        "runtimeDeviceId": identity.runtime_device_id,
        "roleId": role_id,
        "taskId": f"stand-in-chat-{user.id}-{suffix}",
    }


def _message_source(session: IMPrivateSession, context: Any) -> dict[str, Any]:
    return {
        "source": "im",
        "external_id": session.session_key,
        "channel_type": session.channel_type,
        "channel_id": session.channel_id,
        "conversation_id": session.conversation_id,
        "sender_id": session.sender_id,
        "message_id": context.extra_data.get("message_id"),
    }


@trace_async("im.stand_in.send", "im")
async def send_stand_in_message(
    db: Session, user: User, session: IMPrivateSession, context: Any, port: Any
) -> bool:
    try:
        target = await resolve_stand_in_target(db, user, session)
    except Exception:
        logger.exception("Could not resolve IM stand-in: user_id=%s", user.id)
        await port.send_text_reply(context, f"无法读取分身连接。{SETUP_GUIDANCE}")
        return False
    if target is None:
        await port.send_text_reply(context, SETUP_GUIDANCE)
        return False
    source = _message_source(session, context)
    client_id = port._private_im_runtime_client_user_message_id(source)
    source["callback_id"] = f"{session.session_key}:{client_id}"
    callback_key = runtime_local_task_callback_key(
        target["runtimeDeviceId"], target["taskId"], source["callback_id"]
    )
    context.extra_data["card_runtime_task"] = {
        "deviceId": target["deviceId"],
        "localTaskId": target["taskId"],
    }
    emitter = None
    try:
        emitter = await port._create_private_im_runtime_streaming_emitter(
            callback_key=callback_key, message_context=context
        )
        await port._register_private_im_runtime_callback(
            callback_key=callback_key,
            message_context=context,
            streaming_emitter=emitter,
        )
        await _dispatch(db, user, session, context, port, target, source, client_id)
        return True
    except Exception as error:
        logger.exception(
            "IM stand-in dispatch failed: user_id=%s device_id=%s",
            user.id,
            target["deviceId"],
        )
        await port._delete_private_im_runtime_callback(callback_key)
        message = (
            "附件未能保存，请重新发送。"
            if getattr(error, "code", None) == "attachment_failed"
            else f"分身暂时无法接收消息。{SETUP_GUIDANCE}"
        )
        try:
            await port._emit_private_im_runtime_stream_error(
                streaming_emitter=emitter,
                task_id=callback_key,
                message_context=context,
                error=message,
            )
        except Exception:
            logger.exception(
                "IM stand-in card error delivery failed: user_id=%s", user.id
            )
            await port.send_text_reply(context, message)
        callback_service = port.get_callback_service()
        if callback_service:
            await callback_service._remove_emitter(callback_key)
        return False


async def _dispatch(
    db: Session,
    user: User,
    session: IMPrivateSession,
    context: Any,
    port: Any,
    target: dict[str, Any],
    source: dict[str, Any],
    client_id: str,
) -> None:
    from app.services.runtime_work_service import _runtime_attachment_payloads

    attachment_ids = _persist_attachments(db, user.id, context, port)
    additional_context = await _quoted_task_context(session, context)
    result = await runtime_rpc_service.call(
        user_id=user.id,
        device_id=target["deviceId"],
        method="runtime.stand_in.conversation",
        allow_app_device_stand_in=True,
        payload={
            "userId": user.id,
            "roleId": target["roleId"],
            "message": context.content or "请查看附件",
            "options": {
                "attachments": _runtime_attachment_payloads(
                    db, user.id, attachment_ids
                ),
                "clientUserMessageId": client_id,
                "source": source,
                "additionalContext": additional_context,
            },
        },
    )
    if result.get("success") is False:
        raise RuntimeRpcError("Stand-in conversation rejected the message")


def _persist_attachments(
    db: Session, user_id: int, context: Any, port: Any
) -> list[int]:
    ids = (
        port._persist_im_images_as_attachments(
            db=db, user_id=user_id, subtask_id=0, images=context.images, strict=True
        )
        if context.images
        else []
    )
    if context.files:
        files = port._persist_im_files_as_attachments(
            db=db, user_id=user_id, subtask_id=0, files=context.files
        )
        if len(files) != len(context.files):
            raise RuntimeRpcError(
                "IM attachment persistence failed", code="attachment_failed"
            )
        ids.extend(item["id"] for item in files)
    if ids:
        db.commit()
    return ids


async def _quoted_task_context(
    session: IMPrivateSession, context: Any
) -> dict[str, Any]:
    from app.services.im.session_service import im_session_service

    quoted_task = await im_session_service.get_runtime_task_reply_target(
        session=session, message_id=context.extra_data.get("reply_to_message_id")
    )
    card_task = context.extra_data.get("im_card_task_reference")
    if not quoted_task and isinstance(card_task, dict):
        return {
            "wework.im.quoted-task": {
                "kind": "untrusted",
                "value": json.dumps(card_task),
            }
        }
    if not quoted_task:
        return {}
    return {
        "wework.im.quoted-task": {
            "kind": "untrusted",
            "value": json.dumps(
                {
                    "deviceId": quoted_task.get("deviceId"),
                    "taskId": quoted_task.get("localTaskId")
                    or quoted_task.get("taskId"),
                }
            ),
        }
    }
