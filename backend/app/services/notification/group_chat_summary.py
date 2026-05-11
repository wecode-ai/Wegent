# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Group chat summary notification service.

This service handles daily email summaries with group chat conversation content.
It queries the database for recent group chat activity and sends summary emails.
"""

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.subtask import Subtask, SubtaskRole
from app.models.task import TaskResource
from app.models.user import User
from app.services.notification.email_client import EmailClient
from app.services.simple_chat import simple_chat_service

logger = logging.getLogger(__name__)

# Load system prompt template from file
_PROMPT_FILE = Path(__file__).parent / "prompts" / "group_chat_summary.md"
_SYSTEM_PROMPT_TEMPLATE: Optional[str] = None


def _get_system_prompt_template() -> str:
    """Load and cache the system prompt template."""
    global _SYSTEM_PROMPT_TEMPLATE
    if _SYSTEM_PROMPT_TEMPLATE is None:
        try:
            _SYSTEM_PROMPT_TEMPLATE = _PROMPT_FILE.read_text(encoding="utf-8")
        except Exception as e:
            logger.error(f"[GroupChatSummary] Failed to load prompt template: {e}")
            _SYSTEM_PROMPT_TEMPLATE = ""
    return _SYSTEM_PROMPT_TEMPLATE


class GroupChatSummaryService:
    """
    Service for sending daily group chat conversation summaries via email.

    This service:
    1. Queries tasks with is_group_chat=true updated in the last 12 hours
    2. Gets conversation history from subtasks table
    3. Calls LLM to summarize conversations (placeholder - to be implemented)
    4. Sends email with conversation content and summary
    """

    def _get_user_info(self, db: Session, user_id: int) -> Optional[Tuple[str, str]]:
        """
        Get user info (username, email) for a user ID.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Tuple of (username, email) or None if not found
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return None
        email = user.email or f"{user.user_name}@staff.weibo.com"
        return (user.user_name, email)

    async def send_daily_summary(
        self, db: Session, hours_back: int = 12, task_id: Optional[int] = None
    ) -> int:
        """
        Send daily email summary with group chat conversation summaries.

        This queries:
        1. Tasks updated in the specified time period with is_group_chat=true
        2. Subtasks (user messages and AI responses) from that period
        3. Calls model to summarize

        Args:
            db: Database session
            hours_back: Number of hours to look back for messages
                       - 9 for evening run (9:00 to 18:00)
                       - 15 for morning run (previous 18:00 to 9:00)
            task_id: If specified, only process this specific group chat task

        Returns:
            Number of emails sent
        """
        now = datetime.now()
        since = now - timedelta(hours=hours_back)

        logger.info(
            f"[GroupChatSummary] Sending summary for {now.strftime('%Y-%m-%d %H:%M')}, "
            f"looking back {hours_back} hours (since {since.strftime('%Y-%m-%d %H:%M')})"
            + (f", task_id={task_id}" if task_id else "")
        )

        # Step 1: Query tasks with is_group_chat=true updated in the time period
        if task_id:
            # Query specific task
            group_chat_tasks = self._get_specific_group_chat_task(db, task_id)
        else:
            group_chat_tasks = self._get_recent_group_chat_tasks(db, since)
        if not group_chat_tasks:
            logger.info(
                f"[GroupChatSummary] No active group chats in last {hours_back} hours"
            )
            return 0

        logger.info(
            f"[GroupChatSummary] Found {len(group_chat_tasks)} active group chats"
        )

        # Step 2: Get all unique user IDs from these tasks and their subtasks
        user_task_map = self._get_users_in_group_chats(db, group_chat_tasks, since)
        if not user_task_map:
            logger.info("[GroupChatSummary] No users found in group chats")
            return 0

        email_client = EmailClient()
        emails_sent = 0

        # Step 3: Pre-summarize all group chats to avoid duplicate model calls
        # Cache: task_id -> {"title": str, "conversation": list, "summary": str}
        group_summary_cache: Dict[int, Dict] = {}
        for task in group_chat_tasks:
            task_id = task.id
            title = (
                task.json.get("spec", {}).get("title", "")
                or task.name
                or f"群聊 {task_id}"
            )

            # Get conversation history
            conversation = self._get_conversation_history(db, task_id, since)
            if not conversation:
                logger.info(
                    f"[GroupChatSummary] Group '{title}' (task_id={task_id}) has no conversation, skipping"
                )
                continue

            # Call model to summarize
            summary = await self._summarize_conversation(
                conversation, title, hours_back
            )

            # Skip if summary is empty or too short (less than 20 chars)
            if not summary or len(summary.strip()) < 20:
                logger.info(
                    f"[GroupChatSummary] Skipping group '{title}' (task_id={task_id}) - "
                    f"summary too short or empty (length={len(summary.strip()) if summary else 0})"
                )
                continue

            group_summary_cache[task_id] = {
                "title": title,
                "conversation": conversation,
                "summary": summary,
            }

        if not group_summary_cache:
            logger.info(
                "[GroupChatSummary] No groups with substantial content to summarize"
            )
            return 0

        logger.info(
            f"[GroupChatSummary] Summarized {len(group_summary_cache)} groups, "
            f"now sending emails to {len(user_task_map)} users"
        )

        # Step 4: For each user, build group summaries from cache and send email
        for user_id, task_ids in user_task_map.items():
            try:
                # Get user info
                user_info = self._get_user_info(db, user_id)
                if not user_info:
                    logger.warning(
                        f"[GroupChatSummary] User {user_id} not found, skipping email"
                    )
                    continue

                username, email = user_info
                logger.info(
                    f"[GroupChatSummary] Processing user {username} ({email}), user_id={user_id}"
                )

                # Build group summaries for this user from cache
                group_summaries = []
                for task_id in task_ids:
                    if task_id in group_summary_cache:
                        cached = group_summary_cache[task_id]
                        group_summaries.append(
                            {
                                "task_id": task_id,
                                "title": cached["title"],
                                "conversation": cached["conversation"],
                                "summary": cached["summary"],
                            }
                        )

                if not group_summaries:
                    logger.info(
                        f"[GroupChatSummary] No groups with substantial content for user {username} ({email}), skipping email"
                    )
                    continue

                # Send email
                logger.info(
                    f"[GroupChatSummary] Sending email to user {username} ({email}), "
                    f"with {len(group_summaries)} group summaries"
                )
                success = email_client.send_group_chat_summary_email(
                    to_email=email,
                    user_name=username,
                    group_summaries=group_summaries,
                    frontend_url=settings.FRONTEND_URL,
                    hours_back=hours_back,
                )

                if success:
                    emails_sent += 1
                    logger.info(
                        f"[GroupChatSummary] Sent daily summary email to {username}"
                    )
            except Exception as e:
                logger.error(
                    f"[GroupChatSummary] Error sending email to user {user_id}: {e}"
                )

        logger.info(
            f"[GroupChatSummary] Daily summary complete, sent {emails_sent} emails"
        )
        return emails_sent

    def _get_recent_group_chat_tasks(
        self, db: Session, since: datetime
    ) -> List[TaskResource]:
        """
        Get tasks with is_group_chat=true updated in the last 12 hours.

        Args:
            db: Database session
            since: Start time (12 hours ago)

        Returns:
            List of TaskResource objects
        """
        # Query tasks updated recently
        tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.updated_at >= since,
                TaskResource.is_active == True,
            )
            .all()
        )

        # Filter tasks with is_group_chat=true in JSON
        group_chat_tasks = []
        for task in tasks:
            if task.json and task.json.get("spec", {}).get("is_group_chat") is True:
                group_chat_tasks.append(task)

        return group_chat_tasks

    def _get_specific_group_chat_task(
        self, db: Session, task_id: int
    ) -> List[TaskResource]:
        """
        Get a specific task by ID if it's a group chat.

        Args:
            db: Database session
            task_id: Task ID to query

        Returns:
            List containing the task if found and is a group chat, empty list otherwise
        """
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            logger.warning(f"[GroupChatSummary] Task {task_id} not found")
            return []

        # Check if it's a group chat
        if not (task.json and task.json.get("spec", {}).get("is_group_chat") is True):
            logger.warning(f"[GroupChatSummary] Task {task_id} is not a group chat")
            return []

        return [task]

    def _get_users_in_group_chats(
        self, db: Session, tasks: List[TaskResource], since: datetime
    ) -> Dict[int, List[int]]:
        """
        Get all members in these group chats from task_members table.

        Args:
            db: Database session
            tasks: List of group chat tasks
            since: Start time (not used, but kept for API compatibility)

        Returns:
            Dict mapping user_id to list of task_ids they are members of
        """
        task_ids = [t.id for t in tasks]
        if not task_ids:
            return {}

        # Query resource_members to find all approved members
        members = (
            db.query(ResourceMember.resource_id, ResourceMember.entity_id)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK.value,
                ResourceMember.resource_id.in_(task_ids),
                ResourceMember.status == MemberStatus.APPROVED.value,
                ResourceMember.entity_type == 'user',
            )
            .all()
        )

        # Build user_task_map from resource_members
        user_task_map: Dict[int, List[int]] = {}
        for resource_id, user_id in members:
            user_id = int(user_id)
            if user_id not in user_task_map:
                user_task_map[user_id] = []
            if resource_id not in user_task_map[user_id]:
                user_task_map[user_id].append(resource_id)

        # Also include task owners (in case they are not in resource_members)
        for task in tasks:
            user_id = task.user_id
            if user_id > 0:
                if user_id not in user_task_map:
                    user_task_map[user_id] = []
                if task.id not in user_task_map[user_id]:
                    user_task_map[user_id].append(task.id)

        logger.info(
            f"[GroupChatSummary] Found {len(user_task_map)} users in {len(task_ids)} group chats"
        )

        return user_task_map

    def _get_conversation_history(
        self, db: Session, task_id: int, since: datetime
    ) -> List[Dict]:
        """
        Get conversation history for a task in the last 12 hours.

        Args:
            db: Database session
            task_id: Task ID
            since: Start time

        Returns:
            List of conversation messages:
            [{"role": "user", "username": "xxx", "content": "xxx"},
             {"role": "assistant", "content": "xxx"}]
        """
        # Query subtasks ordered by creation time
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.created_at >= since,
            )
            .order_by(Subtask.created_at.asc())
            .all()
        )

        # Cache user names
        user_cache: Dict[int, str] = {}

        conversation = []
        for subtask in subtasks:
            if subtask.role == SubtaskRole.USER:
                # User message
                sender_id = subtask.sender_user_id
                if sender_id > 0:
                    if sender_id not in user_cache:
                        user = db.query(User).filter(User.id == sender_id).first()
                        user_cache[sender_id] = (
                            user.user_name if user else f"用户{sender_id}"
                        )
                    username = user_cache[sender_id]
                else:
                    username = "未知用户"

                content = subtask.prompt or ""
                if content:
                    conversation.append(
                        {
                            "role": "user",
                            "username": username,
                            "content": content,
                        }
                    )
            elif subtask.role == SubtaskRole.ASSISTANT:
                # AI response
                result = subtask.result
                if isinstance(result, dict):
                    content = result.get("value", "") or result.get("content", "")
                elif isinstance(result, str):
                    content = result
                else:
                    content = ""

                if content:
                    conversation.append(
                        {
                            "role": "assistant",
                            "username": "AI",
                            "content": content,
                        }
                    )

        return conversation

    async def _summarize_conversation(
        self, conversation: List[Dict], group_title: str, hours_back: int = 12
    ) -> str:
        """
        Summarize a conversation using AI model.

        Args:
            conversation: List of conversation messages
            group_title: Title of the group chat
            hours_back: Number of hours the conversation spans

        Returns:
            Summary text
        """
        # Build conversation text
        conversation_text = ""
        for msg in conversation:
            role = msg.get("role", "user")
            username = msg.get("username", "未知")
            content = msg.get("content", "")
            if role == "assistant":
                conversation_text += f"AI: {content}\n"
            else:
                conversation_text += f"{username}: {content}\n"

        # Get model configuration from environment variable
        model_config = self._get_model_config()
        if not model_config:
            # Fallback to simple count if no model available
            user_messages = [c for c in conversation if c["role"] == "user"]
            ai_messages = [c for c in conversation if c["role"] == "assistant"]
            return f"共 {len(user_messages)} 条用户消息，{len(ai_messages)} 条 AI 回复"

        # Get system prompt template and replace placeholders
        system_prompt = _get_system_prompt_template()
        if not system_prompt:
            # Fallback to simple prompt if template not available
            system_prompt = "请用简洁的中文总结以下群聊对话的主要内容。"
        else:
            system_prompt = system_prompt.replace("{{GROUP_NAME}}", group_title)
            system_prompt = system_prompt.replace("{{HOURS_BACK}}", str(hours_back))

        user_message = f"""以下是群聊【{group_title}】过去{hours_back}小时内的聊天记录：

{conversation_text}"""

        try:
            logger.info(
                f"[GroupChatSummary] Calling model to summarize group '{group_title}', "
                f"conversation has {len(conversation)} messages"
            )
            summary = await simple_chat_service.chat_completion(
                message=user_message,
                model_config=model_config,
                system_prompt=system_prompt,
            )
            summary = summary.strip()
            logger.info(
                f"[GroupChatSummary] Model returned summary for group '{group_title}', "
                f"length={len(summary)} chars"
            )
            return summary
        except Exception as e:
            logger.error(f"[GroupChatSummary] Error calling model for summary: {e}")
            # Fallback to simple count
            user_messages = [c for c in conversation if c["role"] == "user"]
            ai_messages = [c for c in conversation if c["role"] == "assistant"]
            return f"共 {len(user_messages)} 条用户消息，{len(ai_messages)} 条 AI 回复"

    def _get_model_config(self) -> Optional[Dict]:
        """
        Get model configuration from environment variable.

        Returns:
            Model config dict or None if not configured
        """
        if not settings.DAILY_SUMMARY_MODEL_CONFIG:
            logger.warning(
                "[GroupChatSummary] DAILY_SUMMARY_MODEL_CONFIG not configured"
            )
            return None

        try:
            model_config = json.loads(settings.DAILY_SUMMARY_MODEL_CONFIG)
            # Validate required fields
            required_fields = ["model", "api_key", "base_url", "model_id"]
            for field in required_fields:
                if field not in model_config:
                    logger.error(
                        f"[GroupChatSummary] Missing required field '{field}' in DAILY_SUMMARY_MODEL_CONFIG"
                    )
                    return None
            return model_config
        except json.JSONDecodeError as e:
            logger.error(
                f"[GroupChatSummary] Invalid JSON in DAILY_SUMMARY_MODEL_CONFIG: {e}"
            )
            return None


# Global service instance
_group_chat_summary_service: Optional[GroupChatSummaryService] = None


def get_group_chat_summary_service() -> GroupChatSummaryService:
    """Get the global group chat summary service instance."""
    global _group_chat_summary_service
    if _group_chat_summary_service is None:
        _group_chat_summary_service = GroupChatSummaryService()
    return _group_chat_summary_service
