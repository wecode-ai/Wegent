# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Stream Chatbot Handler.

This module provides the handler for processing incoming DingTalk messages
and integrating them with the Wegent chat system.
"""

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage, ChatbotMessage

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.dingtalk.user_resolver import DingTalkUserResolver

if TYPE_CHECKING:
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)

# Redis key prefix for DingTalk conversation -> task_id mapping
DINGTALK_CONV_TASK_PREFIX = "dingtalk:conv_task:"
# TTL for conversation-task mapping (7 days)
DINGTALK_CONV_TASK_TTL = 7 * 24 * 60 * 60


class WegentChatbotHandler(dingtalk_stream.ChatbotHandler):
    """
    Handler for DingTalk Stream chatbot messages.

    This handler receives messages from DingTalk via the Stream protocol
    and processes them through the Wegent chat system.
    """

    def __init__(
        self,
        dingtalk_client: Optional["DingTalkStreamClient"] = None,
        default_team_id: Optional[int] = None,
        use_ai_card: bool = True,
        on_message: Optional[Callable[[Dict[str, Any]], asyncio.Future]] = None,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
    ):
        """
        Initialize the handler.

        Args:
            dingtalk_client: DingTalk stream client for sending responses.
                            Required for streaming mode.
            default_team_id: Default team ID for this channel (deprecated, use get_default_team_id)
            use_ai_card: Whether to use AI Card for streaming responses
            on_message: Optional callback for message processing.
                        If not provided, uses default Wegent chat processing.
            get_default_team_id: Callback to get current default_team_id dynamically.
                                If provided, this takes precedence over default_team_id.
            get_default_model_name: Callback to get current default_model_name dynamically.
                                   Used to override bot's model configuration.
        """
        super(dingtalk_stream.ChatbotHandler, self).__init__()
        self._dingtalk_client = dingtalk_client
        self._default_team_id = default_team_id
        self._get_default_team_id = get_default_team_id
        self._get_default_model_name = get_default_model_name
        self._use_ai_card = use_ai_card
        self._on_message = on_message
        self.logger = logging.getLogger(__name__)

    @property
    def default_team_id(self) -> Optional[int]:
        """Get the current default team ID, preferring dynamic callback."""
        if self._get_default_team_id is not None:
            return self._get_default_team_id()
        return self._default_team_id

    @property
    def default_model_name(self) -> Optional[str]:
        """Get the current default model name from dynamic callback."""
        if self._get_default_model_name is not None:
            return self._get_default_model_name()
        return None

    async def _get_conversation_task_id(self, conversation_id: str) -> Optional[int]:
        """Get cached task_id for a conversation from Redis."""
        if not conversation_id:
            return None
        key = f"{DINGTALK_CONV_TASK_PREFIX}{conversation_id}"
        task_id = await cache_manager.get(key)
        return int(task_id) if task_id is not None else None

    async def _set_conversation_task_id(
        self, conversation_id: str, task_id: int
    ) -> None:
        """Cache task_id for a conversation in Redis."""
        if not conversation_id:
            return
        key = f"{DINGTALK_CONV_TASK_PREFIX}{conversation_id}"
        await cache_manager.set(key, task_id, expire=DINGTALK_CONV_TASK_TTL)

    async def _delete_conversation_task_id(self, conversation_id: str) -> None:
        """Delete cached task_id for a conversation from Redis."""
        if not conversation_id:
            return
        key = f"{DINGTALK_CONV_TASK_PREFIX}{conversation_id}"
        await cache_manager.delete(key)

    async def process(self, callback: CallbackMessage) -> tuple[str, str]:
        """
        Process incoming DingTalk chatbot message.

        This method is called by the DingTalk Stream SDK when a message
        is received from the chatbot.

        Args:
            callback: Callback message containing the chat data

        Returns:
            Tuple of (status, message) for acknowledgment
        """
        try:
            # Parse the incoming message
            incoming_message = ChatbotMessage.from_dict(callback.data)

            # Extract message details
            message_content = self._extract_message_content(incoming_message)
            sender_info = self._extract_sender_info(incoming_message)
            conversation_info = self._extract_conversation_info(incoming_message)

            self.logger.info(
                "[DingTalkHandler] Received message: sender=%s, content_preview=%s, "
                "conversation_type=%s",
                sender_info.get("sender_nick", "unknown"),
                message_content[:50] if message_content else "empty",
                conversation_info.get("conversation_type", "unknown"),
            )

            # Build message context for processing
            message_context = {
                "content": message_content,
                "sender": sender_info,
                "conversation": conversation_info,
                "raw_message": incoming_message,
                "callback_data": callback.data,
            }

            # Process through custom callback or default handler
            if self._on_message:
                await self._on_message(message_context)
            else:
                await self._process_wegent_message(message_context, incoming_message)

            return AckMessage.STATUS_OK, "OK"

        except Exception as e:
            self.logger.exception("[DingTalkHandler] Error processing message: %s", e)
            return AckMessage.STATUS_SYSTEM_EXCEPTION, str(e)

    def _extract_message_content(self, message: ChatbotMessage) -> str:
        """
        Extract text content from the message.

        Args:
            message: ChatbotMessage object

        Returns:
            Extracted text content
        """
        if hasattr(message, "text") and message.text:
            return message.text.content.strip() if message.text.content else ""
        return ""

    def _extract_sender_info(self, message: ChatbotMessage) -> Dict[str, Any]:
        """
        Extract sender information from the message.

        Args:
            message: ChatbotMessage object

        Returns:
            Dictionary containing sender information
        """
        return {
            "sender_id": getattr(message, "sender_id", None),
            "sender_nick": getattr(message, "sender_nick", None),
            "sender_staff_id": getattr(message, "sender_staff_id", None),
            "sender_corp_id": getattr(message, "sender_corp_id", None),
        }

    def _extract_conversation_info(self, message: ChatbotMessage) -> Dict[str, Any]:
        """
        Extract conversation information from the message.

        Args:
            message: ChatbotMessage object

        Returns:
            Dictionary containing conversation information
        """
        return {
            "conversation_id": getattr(message, "conversation_id", None),
            "conversation_type": getattr(message, "conversation_type", None),
            "conversation_title": getattr(message, "conversation_title", None),
            "chatbot_user_id": getattr(message, "chatbot_user_id", None),
            "at_users": getattr(message, "at_users", []),
            "is_in_at_list": getattr(message, "is_in_at_list", False),
        }

    async def _process_wegent_message(
        self,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
    ) -> None:
        """
        Process message through Wegent chat system.

        This creates a task and triggers AI response through the
        existing chat infrastructure. When streaming mode is enabled,
        the response is sent via AI Card for real-time updates.

        Args:
            message_context: Parsed message context
            incoming_message: Original ChatbotMessage for reply
        """
        content = message_context["content"]
        sender = message_context["sender"]
        conversation = message_context["conversation"]
        conversation_id = conversation.get("conversation_id", "")

        if not content:
            self.logger.warning("[DingTalkHandler] Empty message content, skipping")
            self.reply_text("Message content is empty, please resend", incoming_message)
            return

        # Handle /new command - create new conversation
        if content.strip().lower() == "/new":
            if conversation_id:
                await self._delete_conversation_task_id(conversation_id)
                self.logger.info(
                    "[DingTalkHandler] Cleared task cache for conversation: %s",
                    conversation_id,
                )
            self.reply_text(
                "New conversation started, please send your message", incoming_message
            )
            return

        # Get database session
        db = SessionLocal()

        try:
            # Resolve DingTalk user to Wegent user
            user_resolver = DingTalkUserResolver(db)
            user = await user_resolver.resolve_user(
                sender_id=sender.get("sender_id", ""),
                sender_nick=sender.get("sender_nick"),
                sender_staff_id=sender.get("sender_staff_id"),
            )

            if not user:
                self.logger.warning(
                    "[DingTalkHandler] User not found: sender_id=%s, staff_id=%s",
                    sender.get("sender_id"),
                    sender.get("sender_staff_id"),
                )
                self.reply_text(
                    "User not registered in the system, please login to Wegent first",
                    incoming_message,
                )
                return

            # Get default team for this channel
            team = self._get_default_team(db, user.id)
            if not team:
                self.logger.warning(
                    "[DingTalkHandler] No default team configured for DingTalk bot"
                )
                self.reply_text(
                    "Configuration error: no default team configured", incoming_message
                )
                return

            # Process through chat system
            response = await self._create_and_process_chat(
                db=db,
                user=user,
                team=team,
                message=content,
                message_context=message_context,
                incoming_message=incoming_message,
                conversation_id=conversation_id,
            )

            # Reply with the response (only for sync mode)
            # In streaming mode, response is None as it's already sent via AI Card
            if response:
                self.reply_text(response, incoming_message)
            # Note: Don't send error message in streaming mode
            # because the response was already streamed via AI Card

        except Exception as e:
            self.logger.exception(
                "[DingTalkHandler] Error processing Wegent message: %s", e
            )
            self.reply_text(f"Error processing message: {str(e)}", incoming_message)

        finally:
            db.close()

    def _get_default_team(self, db, user_id: int) -> Optional[Kind]:
        """
        Get the default team for DingTalk bot messages.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Team Kind object or None
        """
        team_id = self.default_team_id
        if not team_id:
            self.logger.warning(
                "[DingTalkHandler] No default_team_id configured for this channel"
            )
            return None

        # Query for the team by ID
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            self.logger.warning(
                "[DingTalkHandler] Default team not found: id=%d",
                team_id,
            )

        return team

    async def _create_and_process_chat(
        self,
        db,
        user: User,
        team: Kind,
        message: str,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
        conversation_id: str = "",
    ) -> Optional[str]:
        """
        Create a chat task and process it through the AI system.

        This method creates a task, triggers AI response, and streams
        the response back to DingTalk using AI Card for real-time updates.
        Falls back to sync mode with text reply if streaming fails.

        Args:
            db: Database session
            user: Wegent user
            team: Team Kind object
            message: User message content
            message_context: Full message context
            incoming_message: Original ChatbotMessage for reply
            conversation_id: DingTalk conversation ID for task reuse

        Returns:
            Response text for sync mode, or None if streamed successfully
        """
        from app.services.channels.dingtalk.emitter import (
            StreamingResponseEmitter,
            SyncResponseEmitter,
        )
        from app.services.chat.config import should_use_direct_chat
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )

        # Create task creation parameters
        params = TaskCreationParams(
            message=message,
            title=(
                f"DingTalk: {message[:30]}..."
                if len(message) > 30
                else f"DingTalk: {message}"
            ),
            is_group_chat=False,
            task_type="chat",
        )

        # Check if team supports direct chat
        supports_direct_chat = should_use_direct_chat(db, team, user.id)

        if not supports_direct_chat:
            self.logger.warning(
                "[DingTalkHandler] Team %s/%s does not support direct chat",
                team.namespace,
                team.name,
            )
            return (
                "This team does not support instant chat, please use the web interface"
            )

        # Try to reuse existing task for this conversation
        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(conversation_id)
            if existing_task_id:
                self.logger.info(
                    "[DingTalkHandler] Reusing task %d for conversation %s",
                    existing_task_id,
                    conversation_id,
                )

        # Create task and subtasks
        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,  # Reuse task if available
            should_trigger_ai=True,
        )

        if not result.assistant_subtask:
            self.logger.error("[DingTalkHandler] Failed to create assistant subtask")
            return None

        # Cache the task_id for this conversation
        if conversation_id:
            await self._set_conversation_task_id(conversation_id, result.task.id)

        self.logger.info(
            "[DingTalkHandler] Task created: task_id=%d, subtask_id=%d, reused=%s",
            result.task.id,
            result.assistant_subtask.id,
            existing_task_id is not None,
        )

        # Check if streaming mode is enabled and client is available
        use_streaming = self._dingtalk_client is not None and self._use_ai_card

        # Always create a SyncResponseEmitter to collect the response
        # This ensures we have the content even if streaming fails
        sync_emitter = SyncResponseEmitter()

        if use_streaming:
            # Use StreamingResponseEmitter for real-time updates
            streaming_emitter = StreamingResponseEmitter(
                dingtalk_client=self._dingtalk_client,
                incoming_message=incoming_message,
            )
            # Use a composite emitter that sends to both
            response_emitter = _CompositeEmitter(streaming_emitter, sync_emitter)
        else:
            response_emitter = sync_emitter

        # Trigger AI response
        from app.services.chat.trigger.core import trigger_ai_response

        task_room = f"task_{result.task.id}"

        self.logger.info("[DingTalkHandler] Triggering AI response...")

        await trigger_ai_response(
            task=result.task,
            assistant_subtask=result.assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=self._build_chat_payload(params),
            task_room=task_room,
            supports_direct_chat=True,
            namespace=None,  # No WebSocket namespace for DingTalk
            user_subtask_id=result.user_subtask.id,
            event_emitter=response_emitter,
        )

        # Wait for the response to complete
        try:
            response = await asyncio.wait_for(
                sync_emitter.wait_for_response(),
                timeout=120.0,  # 2 minutes timeout
            )

            self.logger.info(
                "[DingTalkHandler] Response completed for task %d, length=%d",
                result.task.id,
                len(response) if response else 0,
            )

            if (
                use_streaming
                and streaming_emitter._started
                and streaming_emitter._finished
            ):
                # Streaming succeeded, don't return text response
                return None
            else:
                # Streaming failed or not used, return text response
                return response

        except asyncio.TimeoutError:
            self.logger.warning(
                "[DingTalkHandler] Response timeout for task %d", result.task.id
            )
            return "Response timeout, please try again later"

    def _build_chat_payload(self, params: Any):
        """
        Build a chat payload object for trigger_ai_response.

        Args:
            params: Task creation parameters (TaskCreationParams)

        Returns:
            Payload object with required attributes
        """
        from dataclasses import dataclass

        @dataclass
        class ChatPayload:
            is_group_chat: bool = False
            enable_web_search: bool = False
            search_engine: Optional[str] = None
            force_override_bot_model: Optional[str] = None
            enable_clarification: bool = False
            preload_skills: Optional[list] = None

        # Use default_model_name from channel config to override bot's model
        return ChatPayload(
            is_group_chat=params.is_group_chat,
            force_override_bot_model=self.default_model_name,
        )


class _CompositeEmitter:
    """Composite emitter that forwards events to multiple emitters.

    This allows collecting response content while also streaming
    updates to the user.
    """

    def __init__(self, *emitters):
        """Initialize with multiple emitters."""
        self._emitters = emitters

    async def emit_chat_start(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_start(*args, **kwargs)

    async def emit_chat_chunk(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_chunk(*args, **kwargs)

    async def emit_chat_done(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_done(*args, **kwargs)

    async def emit_chat_error(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_error(*args, **kwargs)

    async def emit_chat_cancelled(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_cancelled(*args, **kwargs)

    async def emit_chat_bot_complete(self, *args, **kwargs):
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_bot_complete(*args, **kwargs)
