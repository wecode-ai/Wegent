# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Stream Chatbot Handler.

This module provides the handler for processing incoming DingTalk messages
and integrating them with the Wegent chat system.

Supports multiple execution modes:
- Chat Shell: Direct LLM conversation (default)
- Local Device: Execute tasks on user's local device
- Cloud Executor: Execute tasks on cloud Docker container
"""

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage, ChatbotMessage

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.dingtalk.commands import (
    DEVICE_ITEM_TEMPLATE,
    DEVICES_EMPTY,
    DEVICES_FOOTER,
    DEVICES_HEADER,
    HELP_MESSAGE,
    STATUS_TEMPLATE,
    CommandType,
    ParsedCommand,
    parse_command,
)
from app.services.channels.dingtalk.device_selection import (
    DeviceSelection,
    DeviceType,
    device_selection_manager,
)
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
        existing chat infrastructure. Supports multiple execution modes:
        - Chat Shell: Direct LLM conversation (default)
        - Local Device: Execute on user's local device
        - Cloud Executor: Execute on cloud Docker container

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
            self.reply_text("消息内容为空，请重新发送", incoming_message)
            return

        # Get database session
        db = SessionLocal()

        try:
            # Resolve DingTalk user to Wegent user first (needed for all operations)
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
                    "用户未注册，请先登录 Wegent 系统",
                    incoming_message,
                )
                return

            # Check if this is a command
            parsed_cmd = parse_command(content)
            if parsed_cmd:
                await self._handle_command(
                    db=db,
                    user=user,
                    command=parsed_cmd,
                    conversation_id=conversation_id,
                    incoming_message=incoming_message,
                )
                return

            # Get user's device selection
            device_selection = await device_selection_manager.get_selection(user.id)

            # Route message based on device selection
            if device_selection.device_type == DeviceType.CHAT:
                # Chat Shell mode (default)
                await self._process_chat_message(
                    db=db,
                    user=user,
                    message=content,
                    message_context=message_context,
                    incoming_message=incoming_message,
                    conversation_id=conversation_id,
                )
            elif device_selection.device_type == DeviceType.LOCAL:
                # Local device execution
                await self._process_device_message(
                    db=db,
                    user=user,
                    message=content,
                    device_selection=device_selection,
                    message_context=message_context,
                    incoming_message=incoming_message,
                    conversation_id=conversation_id,
                )
            elif device_selection.device_type == DeviceType.CLOUD:
                # Cloud executor execution
                await self._process_cloud_message(
                    db=db,
                    user=user,
                    message=content,
                    message_context=message_context,
                    incoming_message=incoming_message,
                    conversation_id=conversation_id,
                )

        except Exception as e:
            self.logger.exception(
                "[DingTalkHandler] Error processing Wegent message: %s", e
            )
            self.reply_text(f"处理消息时出错: {str(e)}", incoming_message)

        finally:
            db.close()

    async def _handle_command(
        self,
        db,
        user: User,
        command: ParsedCommand,
        conversation_id: str,
        incoming_message: ChatbotMessage,
    ) -> None:
        """
        Handle slash commands.

        Args:
            db: Database session
            user: Wegent user
            command: Parsed command
            conversation_id: DingTalk conversation ID
            incoming_message: Original ChatbotMessage for reply
        """
        self.logger.info(
            "[DingTalkHandler] Processing command: %s for user %d",
            command,
            user.id,
        )

        if command.command == CommandType.NEW:
            # Clear conversation task mapping
            if conversation_id:
                await self._delete_conversation_task_id(conversation_id)
            self.reply_text("✅ 已开始新对话，请发送您的消息", incoming_message)

        elif command.command == CommandType.HELP:
            self.reply_text(HELP_MESSAGE, incoming_message)

        elif command.command == CommandType.DEVICES:
            await self._handle_devices_command(db, user, incoming_message)

        elif command.command == CommandType.USE:
            await self._handle_use_command(db, user, command.argument, incoming_message)

        elif command.command == CommandType.STATUS:
            await self._handle_status_command(db, user, incoming_message)

    async def _handle_devices_command(
        self,
        db,
        user: User,
        incoming_message: ChatbotMessage,
    ) -> None:
        """Handle /devices command - list online devices."""
        from app.services.device_service import device_service

        devices = await device_service.get_all_devices(db, user.id)

        if not devices:
            self.reply_text(DEVICES_HEADER + DEVICES_EMPTY, incoming_message)
            return

        # Build device list message
        message = DEVICES_HEADER + "\n"

        online_devices = [d for d in devices if d["status"] != "offline"]
        offline_devices = [d for d in devices if d["status"] == "offline"]

        if online_devices:
            message += "**在线设备:**\n"
            for device in online_devices:
                status_str = ""
                if device["status"] == "busy":
                    status_str = " - 🔴 忙碌"
                elif device.get("is_default"):
                    status_str = " - ⭐ 默认"
                message += DEVICE_ITEM_TEMPLATE.format(
                    name=device["name"],
                    device_id=device["device_id"][:8],
                    status=status_str,
                )

        if offline_devices:
            message += "\n**离线设备:**\n"
            for device in offline_devices:
                message += f"• ~~{device['name']}~~ (离线)\n"

        message += DEVICES_FOOTER
        message += "\n• `/use cloud` 切换到云端执行"

        self.reply_text(message, incoming_message)

    async def _handle_use_command(
        self,
        db,
        user: User,
        argument: Optional[str],
        incoming_message: ChatbotMessage,
    ) -> None:
        """Handle /use command - switch execution device."""
        from app.services.device_service import device_service

        # No argument - switch back to chat mode
        if not argument:
            await device_selection_manager.set_chat_mode(user.id)
            self.reply_text(
                "✅ 已切换到**对话模式**\n\n现在的消息将直接由 AI 回复",
                incoming_message,
            )
            return

        argument = argument.strip().lower()

        # Cloud executor
        if argument == "cloud":
            await device_selection_manager.set_cloud_executor(user.id)
            self.reply_text(
                "✅ 已切换到**云端执行模式**\n\n现在的消息将在云端容器中执行",
                incoming_message,
            )
            return

        # Local device - find by name
        devices = await device_service.get_all_devices(db, user.id)
        matched_device = None

        for device in devices:
            # Match by name (case insensitive) or device_id prefix
            if device["name"].lower() == argument or device[
                "device_id"
            ].lower().startswith(argument):
                matched_device = device
                break

        if not matched_device:
            self.reply_text(
                f"❌ 未找到设备: {argument}\n\n使用 `/devices` 查看可用设备列表",
                incoming_message,
            )
            return

        # Check if device is online
        if matched_device["status"] == "offline":
            self.reply_text(
                f"❌ 设备 **{matched_device['name']}** 已离线\n\n请选择其他设备或等待设备上线",
                incoming_message,
            )
            return

        # Set device selection
        await device_selection_manager.set_local_device(
            user.id,
            matched_device["device_id"],
            matched_device["name"],
        )

        self.reply_text(
            f"✅ 已切换到设备 **{matched_device['name']}**\n\n现在的消息将在该设备上执行",
            incoming_message,
        )

    async def _handle_status_command(
        self,
        db,
        user: User,
        incoming_message: ChatbotMessage,
    ) -> None:
        """Handle /status command - show current status."""
        # Get device selection
        selection = await device_selection_manager.get_selection(user.id)

        # Determine mode display
        if selection.device_type == DeviceType.CHAT:
            mode = "💬 对话模式"
            device_info = ""
        elif selection.device_type == DeviceType.LOCAL:
            mode = "💻 本地设备模式"
            device_info = (
                f"**当前设备**: {selection.device_name or selection.device_id}\n"
            )
        else:
            mode = "☁️ 云端执行模式"
            device_info = ""

        # Get team name
        team = self._get_default_team(db, user.id)
        team_name = team.name if team else "未配置"

        message = STATUS_TEMPLATE.format(
            mode=mode,
            device_info=device_info,
            team_name=team_name,
        )

        self.reply_text(message, incoming_message)

    async def _process_chat_message(
        self,
        db,
        user: User,
        message: str,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
        conversation_id: str,
    ) -> None:
        """Process message in Chat Shell mode (direct LLM conversation)."""
        # Get default team for this channel
        team = self._get_default_team(db, user.id)
        if not team:
            self.logger.warning(
                "[DingTalkHandler] No default team configured for DingTalk bot"
            )
            self.reply_text("配置错误: 未配置默认智能体", incoming_message)
            return

        # Process through chat system
        response = await self._create_and_process_chat(
            db=db,
            user=user,
            team=team,
            message=message,
            message_context=message_context,
            incoming_message=incoming_message,
            conversation_id=conversation_id,
        )

        # Reply with the response (only for sync mode)
        if response:
            self.reply_text(response, incoming_message)

    async def _process_device_message(
        self,
        db,
        user: User,
        message: str,
        device_selection: DeviceSelection,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
        conversation_id: str,
    ) -> None:
        """Process message for local device execution."""
        from app.services.device_service import device_service

        device_id = device_selection.device_id
        if not device_id:
            self.reply_text(
                "❌ 设备选择无效，请使用 `/use <设备名>` 重新选择",
                incoming_message,
            )
            return

        # Check if device is still online
        device_info = await device_service.get_device_online_info(user.id, device_id)
        if not device_info:
            self.reply_text(
                f"❌ 设备 **{device_selection.device_name}** 已离线\n\n"
                "请使用 `/devices` 查看在线设备或 `/use` 切换回对话模式",
                incoming_message,
            )
            return

        # Check device slot availability
        slot_info = await device_service.get_device_slot_usage_async(
            db, user.id, device_id
        )
        if slot_info["used"] >= slot_info["max"]:
            self.reply_text(
                f"❌ 设备 **{device_selection.device_name}** 槽位已满 "
                f"({slot_info['used']}/{slot_info['max']})\n\n"
                "请等待当前任务完成或选择其他设备",
                incoming_message,
            )
            return

        # Get team for device execution (use channel default for now)
        # TODO: Support configurable team for device/cloud mode
        team = self._get_default_team(db, user.id)
        if not team:
            self.reply_text("配置错误: 未配置默认智能体", incoming_message)
            return

        # Create and route task to device
        response = await self._create_and_process_device_task(
            db=db,
            user=user,
            team=team,
            message=message,
            device_id=device_id,
            message_context=message_context,
            incoming_message=incoming_message,
            conversation_id=conversation_id,
        )

        if response:
            self.reply_text(response, incoming_message)

    async def _process_cloud_message(
        self,
        db,
        user: User,
        message: str,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
        conversation_id: str,
    ) -> None:
        """Process message for cloud executor execution."""
        # Get team for cloud execution
        team = self._get_default_team(db, user.id)
        if not team:
            self.reply_text("配置错误: 未配置默认智能体", incoming_message)
            return

        # Create task for cloud execution
        response = await self._create_and_process_cloud_task(
            db=db,
            user=user,
            team=team,
            message=message,
            message_context=message_context,
            incoming_message=incoming_message,
            conversation_id=conversation_id,
        )

        if response:
            self.reply_text(response, incoming_message)

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

    async def _create_and_process_device_task(
        self,
        db,
        user: User,
        team: Kind,
        message: str,
        device_id: str,
        message_context: Dict[str, Any],
        incoming_message: ChatbotMessage,
        conversation_id: str = "",
    ) -> Optional[str]:
        """
        Create a task and route it to a local device for execution.

        The response is streamed back via AI Card if available.

        Args:
            db: Database session
            user: Wegent user
            team: Team Kind object
            message: User message content
            device_id: Target device ID
            message_context: Full message context
            incoming_message: Original ChatbotMessage for reply
            conversation_id: DingTalk conversation ID for task reuse

        Returns:
            Error message if failed, None if task routed successfully
        """
        from app.services.channels.dingtalk.emitter import (
            StreamingResponseEmitter,
            SyncResponseEmitter,
        )
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )
        from app.services.device_router import route_task_to_device

        # Create task creation parameters for device task
        params = TaskCreationParams(
            message=message,
            title=(
                f"DingTalk: {message[:30]}..."
                if len(message) > 30
                else f"DingTalk: {message}"
            ),
            is_group_chat=False,
            task_type="task",  # Device task type
        )

        # Try to reuse existing task for this conversation
        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(conversation_id)
            if existing_task_id:
                self.logger.info(
                    "[DingTalkHandler] Reusing task %d for device conversation %s",
                    existing_task_id,
                    conversation_id,
                )

        # Create task and subtasks (don't trigger AI yet - device will handle it)
        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,
            should_trigger_ai=False,  # Device will trigger AI
        )

        if not result.assistant_subtask:
            self.logger.error(
                "[DingTalkHandler] Failed to create assistant subtask for device task"
            )
            return "创建任务失败，请重试"

        # Cache the task_id for this conversation
        if conversation_id:
            await self._set_conversation_task_id(conversation_id, result.task.id)

        self.logger.info(
            "[DingTalkHandler] Device task created: task_id=%d, subtask_id=%d, device_id=%s",
            result.task.id,
            result.assistant_subtask.id,
            device_id,
        )

        # Route task to device
        try:
            await route_task_to_device(
                db=db,
                user_id=user.id,
                device_id=device_id,
                task=result.task,
                subtask=result.assistant_subtask,
                team=team,
                user=user,
                user_subtask=result.user_subtask,
            )

            self.logger.info(
                "[DingTalkHandler] Task routed to device: task_id=%d, device_id=%s",
                result.task.id,
                device_id,
            )

            # Send acknowledgment message for device execution
            # Device tasks are executed asynchronously, so we send a complete
            # acknowledgment message. The actual response will be handled by
            # the device and can be viewed in the web interface.
            if self._dingtalk_client and self._use_ai_card:
                # Use streaming emitter to send a complete acknowledgment
                streaming_emitter = StreamingResponseEmitter(
                    dingtalk_client=self._dingtalk_client,
                    incoming_message=incoming_message,
                )
                await streaming_emitter.emit_chat_start(
                    task_id=result.task.id,
                    subtask_id=result.assistant_subtask.id,
                    shell_type="ClaudeCode",
                )
                await streaming_emitter.emit_chat_chunk(
                    task_id=result.task.id,
                    subtask_id=result.assistant_subtask.id,
                    content=(
                        f"✅ 任务已发送到设备 **{device_id[:8]}**\n\n"
                        f"任务 ID: {result.task.id}\n"
                        "状态: 正在执行\n\n"
                        "💡 您可以在 Wegent 网页端查看执行进度和结果。"
                    ),
                    offset=0,
                )
                # Finalize the card to prevent it from staying in streaming state
                await streaming_emitter.emit_chat_done(
                    task_id=result.task.id,
                    subtask_id=result.assistant_subtask.id,
                    offset=0,
                )

            return None  # Success - no error message

        except Exception as e:
            self.logger.exception(
                "[DingTalkHandler] Failed to route task to device: %s", e
            )
            return f"发送任务到设备失败: {str(e)}"

    async def _create_and_process_cloud_task(
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
        Create a task for cloud executor execution.

        The task is created in PENDING status and will be picked up
        by executor_manager for execution.

        Args:
            db: Database session
            user: Wegent user
            team: Team Kind object
            message: User message content
            message_context: Full message context
            incoming_message: Original ChatbotMessage for reply
            conversation_id: DingTalk conversation ID for task reuse

        Returns:
            Acknowledgment message or error message
        """
        from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )
        from app.services.task_dispatcher import task_dispatcher

        # Create task creation parameters for cloud task
        params = TaskCreationParams(
            message=message,
            title=(
                f"DingTalk: {message[:30]}..."
                if len(message) > 30
                else f"DingTalk: {message}"
            ),
            is_group_chat=False,
            task_type="task",  # Cloud executor task type
        )

        # Try to reuse existing task for this conversation
        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(conversation_id)
            if existing_task_id:
                self.logger.info(
                    "[DingTalkHandler] Reusing task %d for cloud conversation %s",
                    existing_task_id,
                    conversation_id,
                )

        # Create task and subtasks (don't trigger AI - executor_manager will handle it)
        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,
            should_trigger_ai=False,  # Executor manager will trigger AI
        )

        if not result.assistant_subtask:
            self.logger.error(
                "[DingTalkHandler] Failed to create assistant subtask for cloud task"
            )
            return "创建任务失败，请重试"

        # Cache the task_id for this conversation
        if conversation_id:
            await self._set_conversation_task_id(conversation_id, result.task.id)

        self.logger.info(
            "[DingTalkHandler] Cloud task created: task_id=%d, subtask_id=%d",
            result.task.id,
            result.assistant_subtask.id,
        )

        # Dispatch task to executor_manager if push mode is enabled
        # Otherwise, executor_manager will poll for PENDING tasks
        task_dispatcher.schedule_dispatch(result.task.id)

        # Send acknowledgment via AI Card
        if self._dingtalk_client and self._use_ai_card:
            streaming_emitter = StreamingResponseEmitter(
                dingtalk_client=self._dingtalk_client,
                incoming_message=incoming_message,
            )
            await streaming_emitter.emit_chat_start(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                shell_type="ClaudeCode",
            )
            await streaming_emitter.emit_chat_chunk(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                content=(
                    "⏳ 任务已提交到云端执行队列\n\n"
                    f"任务 ID: {result.task.id}\n"
                    "状态: 等待执行\n\n"
                    "任务完成后将收到通知。"
                ),
                offset=0,
            )
            # Finish the card since cloud execution is async
            await streaming_emitter.emit_chat_done(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                offset=0,
            )
            return None
        else:
            # Sync response
            return (
                f"✅ 任务已提交到云端执行队列\n\n"
                f"任务 ID: {result.task.id}\n"
                "任务完成后将收到通知。"
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
