# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helper functions for task detail response assembly."""

from typing import Any, Dict, List, Set, Tuple

from sqlalchemy.orm import Session

from app.schemas.kind import Bot, Shell
from app.utils.prompt_utils import extract_display_prompt


def get_bots_for_subtasks(
    db: Session, all_bot_ids: Set[int]
) -> Dict[int, Dict[str, Any]]:
    """Get bot information used by subtasks."""
    from app.services.readers.kinds import KindType, kindReader

    bots: Dict[int, Dict[str, Any]] = {}
    if not all_bot_ids:
        return bots

    model_cache: Dict[Tuple[int, str, str], Any] = {}
    shell_type_cache: Dict[Tuple[int, str, str], str] = {}

    bot_objects = kindReader.get_by_ids(db, KindType.BOT, list(all_bot_ids))
    for bot in bot_objects:
        bot_crd = Bot.model_validate(bot.json)

        shell_type = ""
        agent_config: Dict[str, Any] = {}

        if bot_crd.spec.modelRef:
            model_ref = bot_crd.spec.modelRef
            model_key = (bot.user_id, model_ref.namespace, model_ref.name)
            if model_key not in model_cache:
                model_cache[model_key] = kindReader.get_by_name_and_namespace(
                    db,
                    bot.user_id,
                    KindType.MODEL,
                    model_ref.namespace,
                    model_ref.name,
                )
            model = model_cache[model_key]
            model_type = "public" if model and model.user_id == 0 else "user"
            agent_config = {
                "bind_model": model_ref.name,
                "bind_model_type": model_type,
            }

        if bot_crd.spec.shellRef:
            shell_ref = bot_crd.spec.shellRef
            shell_key = (bot.user_id, shell_ref.namespace, shell_ref.name)
            if shell_key not in shell_type_cache:
                shell = kindReader.get_by_name_and_namespace(
                    db,
                    bot.user_id,
                    KindType.SHELL,
                    shell_ref.namespace,
                    shell_ref.name,
                )
                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type_cache[shell_key] = shell_crd.spec.shellType
                else:
                    shell_type_cache[shell_key] = ""
            shell_type = shell_type_cache[shell_key]

        bots[bot.id] = {
            "id": bot.id,
            "user_id": bot.user_id,
            "name": bot.name,
            "shell_type": shell_type,
            "agent_config": agent_config,
            "is_active": bot.is_active,
            "created_at": (bot.created_at.isoformat() if bot.created_at else None),
            "updated_at": (bot.updated_at.isoformat() if bot.updated_at else None),
        }

    return bots


def convert_subtasks_to_dict(
    subtasks: List[Any], bots: Dict[int, Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Convert subtask objects to response dictionaries."""
    subtasks_dict = []
    for subtask in subtasks:
        contexts_list = []
        if hasattr(subtask, "contexts") and subtask.contexts:
            for ctx in subtask.contexts:
                ctx_dict = {
                    "id": ctx.id,
                    "context_type": ctx.context_type,
                    "name": ctx.name,
                    "status": (
                        ctx.status.value if hasattr(ctx.status, "value") else ctx.status
                    ),
                }

                if ctx.context_type == "attachment":
                    ctx_dict.update(
                        {
                            "file_extension": ctx.file_extension,
                            "file_size": ctx.file_size,
                            "mime_type": ctx.mime_type,
                        }
                    )
                elif ctx.context_type == "knowledge_base":
                    ctx_dict.update({"document_count": ctx.document_count})
                elif ctx.context_type == "table":
                    type_data = ctx.type_data or {}
                    url = type_data.get("url")
                    if url:
                        ctx_dict["source_config"] = {"url": url}

                contexts_list.append(ctx_dict)

        subtasks_dict.append(
            {
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_ids": subtask.bot_ids,
                "role": subtask.role,
                "prompt": extract_display_prompt(subtask.prompt),
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "message_id": subtask.message_id,
                "parent_id": subtask.parent_id,
                "status": subtask.status,
                "progress": subtask.progress,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "user_id": subtask.user_id,
                "created_at": (
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
                "updated_at": (
                    subtask.updated_at.isoformat() if subtask.updated_at else None
                ),
                "completed_at": (
                    subtask.completed_at.isoformat() if subtask.completed_at else None
                ),
                "bots": [
                    bots.get(bot_id) for bot_id in subtask.bot_ids if bot_id in bots
                ],
                "contexts": contexts_list,
                "attachments": [],
                "sender_type": subtask.sender_type,
                "sender_user_id": subtask.sender_user_id,
                "sender_user_name": getattr(subtask, "sender_user_name", None),
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
        )

    return subtasks_dict


def add_group_chat_info_to_task(
    db: Session, *, task_id: int, task_dict: Dict[str, Any], user_id: int
) -> None:
    """Add group chat metadata to a task detail dictionary."""
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    members = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task_id,
            ResourceMember.status == MemberStatus.APPROVED,
        )
        .all()
    )

    is_group_chat = task_dict.get("is_group_chat", False)
    if not is_group_chat:
        is_group_chat = len(members) > 0

    task_dict["is_group_chat"] = is_group_chat
    task_dict["is_group_owner"] = task_dict.get("user_id") == user_id
    task_dict["member_count"] = len(members) if is_group_chat else None
