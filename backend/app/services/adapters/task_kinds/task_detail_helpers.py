# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helper functions for task detail response assembly."""

from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.schemas.kind import Bot, Shell
from app.schemas.subtask_context import SubtaskContextBrief
from app.schemas.task import SkillRef
from app.services.task_fork_history import ForkHistoryItem
from app.services.task_skill_selection import parse_requested_skill_refs_from_labels
from app.stores.tasks import task_access_store
from app.utils.client_payload_sanitizer import sanitize_client_payload
from app.utils.prompt_utils import extract_display_prompt

CONVERSATION_CONTEXT_TYPE = "conversation"


def filter_conversation_contexts_for_viewer(
    db: Session, *, subtasks: List[Dict[str, Any]], user_id: int
) -> None:
    """Drop conversation references the viewer cannot access.

    A group-chat member must not learn the title or ID of a private task that
    another member referenced. Contexts are mutated in place.
    """
    referenced_ids: Set[int] = set()
    for subtask in subtasks:
        for context in subtask.get("contexts") or []:
            if context.get("context_type") != CONVERSATION_CONTEXT_TYPE:
                continue
            task_id = context.get("task_id")
            if isinstance(task_id, int):
                referenced_ids.add(task_id)

    if not referenced_ids:
        return

    accessible_ids = {
        task_id
        for task_id in referenced_ids
        if task_access_store.is_member(db, task_id=task_id, user_id=user_id)
    }
    for subtask in subtasks:
        contexts = subtask.get("contexts")
        if not contexts:
            continue
        visible = [
            context
            for context in contexts
            if context.get("context_type") != CONVERSATION_CONTEXT_TYPE
            or context.get("task_id") in accessible_ids
        ]
        if len(visible) != len(contexts):
            subtask["contexts"] = visible


def filter_conversation_contexts_on_subtasks(
    db: Session, *, subtasks: List[Any], user_id: int
) -> None:
    """Drop inaccessible conversation contexts from ORM subtasks in place.

    ``/api/subtasks`` returns the same message payloads as the task detail
    endpoint, so it needs the same rule: a viewer must not learn the title or
    task id of a private task that another member referenced.

    The collection is stored back with ``set_committed_value`` so SQLAlchemy
    does not treat the filtered list as a pending change to the relationship.
    """
    from sqlalchemy.orm.attributes import set_committed_value

    referenced_ids: Set[int] = set()
    for subtask in subtasks:
        for context in getattr(subtask, "contexts", None) or []:
            if context.context_type != CONVERSATION_CONTEXT_TYPE:
                continue
            type_data = context.type_data if isinstance(context.type_data, dict) else {}
            task_id = type_data.get("task_id")
            if isinstance(task_id, int):
                referenced_ids.add(task_id)

    if not referenced_ids:
        return

    accessible_ids = {
        task_id
        for task_id in referenced_ids
        if task_access_store.is_member(db, task_id=task_id, user_id=user_id)
    }
    for subtask in subtasks:
        contexts = getattr(subtask, "contexts", None)
        if not contexts:
            continue
        visible = [
            context
            for context in contexts
            if context.context_type != CONVERSATION_CONTEXT_TYPE
            or (
                isinstance(context.type_data, dict)
                and context.type_data.get("task_id") in accessible_ids
            )
        ]
        if len(visible) != len(contexts):
            set_committed_value(subtask, "contexts", visible)


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
    for item in subtasks:
        subtask = item.subtask if isinstance(item, ForkHistoryItem) else item
        inherited = item.inherited if isinstance(item, ForkHistoryItem) else False
        origin_task_id = (
            item.origin_task_id
            if isinstance(item, ForkHistoryItem)
            else subtask.task_id
        )
        origin_subtask_id = (
            item.origin_subtask_id if isinstance(item, ForkHistoryItem) else subtask.id
        )
        contexts_list = []
        if hasattr(subtask, "contexts") and subtask.contexts:
            for ctx in subtask.contexts:
                contexts_list.append(_serialize_context_brief(ctx))

        subtasks_dict.append(
            {
                "id": subtask.id,
                "task_id": subtask.task_id,
                "inherited": inherited,
                "origin_task_id": origin_task_id,
                "origin_subtask_id": origin_subtask_id,
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
                "result": sanitize_client_payload(subtask.result),
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


def _serialize_context_brief(ctx: Any) -> Dict[str, Any]:
    """Serialize a subtask context through the shared display-field schema."""
    if hasattr(ctx, "model_dump"):
        return ctx.model_dump(mode="json")
    return SubtaskContextBrief.from_model(ctx).model_dump(mode="json")


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
            # Share recipients keep a record here too, but copying a shared
            # task does not turn the original into a group chat. Mirrors the
            # task list path in helpers._add_group_chat_info.
            ResourceMember.copied_resource_id == 0,
        )
        .all()
    )

    is_group_chat = task_dict.get("is_group_chat", False)
    if not is_group_chat:
        is_group_chat = len(members) > 0

    task_dict["is_group_chat"] = is_group_chat
    task_dict["is_group_owner"] = task_dict.get("user_id") == user_id
    task_dict["member_count"] = len(members) if is_group_chat else None


def get_requested_skills_from_task(task_crd: Any) -> Optional[List[SkillRef]]:
    """Extract requested skills from task CRD metadata labels.

    Args:
        task_crd: The Task CRD object

    Returns:
        List of SkillRef objects or None if no skills requested
    """
    if not task_crd or not task_crd.metadata:
        return None

    labels = task_crd.metadata.labels or {}
    skill_refs = parse_requested_skill_refs_from_labels(labels)

    if not skill_refs:
        return None

    return [
        SkillRef(
            skill_id=ref.get("skill_id"),
            name=ref["name"],
            namespace=ref["namespace"],
            is_public=ref["is_public"],
        )
        for ref in skill_refs
    ]
