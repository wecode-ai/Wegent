# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic Channel Message Handler.

This module provides a generic message handler for IM channel integrations
(DingTalk, Feishu, Telegram, etc.) to process incoming messages and
integrate them with the Wegent chat system.

The design follows the Template Method pattern, allowing each channel to
implement channel-specific message parsing while sharing common processing logic.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Dict, Generic, Optional, TypeVar

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
)
from app.services.channels.commands import (
    DEVICE_ITEM_TEMPLATE,
    DEVICES_EMPTY,
    DEVICES_FOOTER,
    DEVICES_HEADER,
    HELP_MESSAGE,
    STATUS_TEMPLATE,
    CommandType,
    parse_command,
)
from app.services.channels.device_selection import (
    DeviceSelection,
    DeviceType,
    device_selection_manager,
)
from app.services.channels.emitter import CompositeEmitter, SyncResponseEmitter

logger = logging.getLogger(__name__)

# Redis key prefix for conversation -> task_id mapping
CHANNEL_CONV_TASK_PREFIX = "channel:conv_task:"
# TTL for conversation-task mapping (7 days)
CHANNEL_CONV_TASK_TTL = 7 * 24 * 60 * 60


@dataclass
class MessageContext:
    """Context for an incoming message.

    Contains all the information needed to process a message,
    regardless of the source channel.
    """

    content: str  # Message text content
    sender_id: str  # Channel-specific sender ID
    sender_name: Optional[str]  # Sender display name
    conversation_id: str  # Channel-specific conversation/chat ID
    conversation_type: str  # "private" or "group"
    is_mention: bool  # Whether the bot was mentioned (for group chats)
    raw_message: Any  # Original message object from the channel SDK
    extra_data: Dict[str, Any]  # Channel-specific extra data


@dataclass
class UserMappingConfig:
    """Configuration for user mapping."""

    mode: str  # "select_user", "staff_id", "email", etc.
    config: Optional[Dict[str, Any]] = None


# Type variables for generic types
TMessage = TypeVar("TMessage")  # Channel-specific message type
TCallbackInfo = TypeVar("TCallbackInfo", bound=BaseCallbackInfo)


class BaseChannelHandler(ABC, Generic[TMessage, TCallbackInfo]):
    """Abstract base class for channel message handlers.

    Each channel implementation should extend this class and implement
    the abstract methods for channel-specific behavior.

    The handler manages:
    - Parsing incoming messages
    - Resolving users
    - Processing commands
    - Routing messages to appropriate execution modes
    - Sending responses
    """

    def __init__(
        self,
        channel_type: ChannelType,
        channel_id: int,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        """Initialize the handler.

        Args:
            channel_type: The type of channel this handler processes
            channel_id: The channel ID for callback purposes
            get_default_team_id: Callback to get current default_team_id dynamically
            get_default_model_name: Callback to get current default_model_name dynamically
            get_user_mapping_config: Callback to get user mapping configuration dynamically
        """
        self._channel_type = channel_type
        self._channel_id = channel_id
        self._get_default_team_id = get_default_team_id
        self._get_default_model_name = get_default_model_name
        self._get_user_mapping_config = get_user_mapping_config
        self.logger = logging.getLogger(f"{__name__}.{channel_type.value}")

    @property
    def channel_type(self) -> ChannelType:
        """Get the channel type."""
        return self._channel_type

    @property
    def channel_id(self) -> int:
        """Get the channel ID."""
        return self._channel_id

    @property
    def default_team_id(self) -> Optional[int]:
        """Get the current default team ID."""
        if self._get_default_team_id is not None:
            return self._get_default_team_id()
        return None

    @property
    def default_model_name(self) -> Optional[str]:
        """Get the current default model name."""
        if self._get_default_model_name is not None:
            return self._get_default_model_name()
        return None

    @property
    def user_mapping_config(self) -> UserMappingConfig:
        """Get the current user mapping configuration."""
        if self._get_user_mapping_config is not None:
            config = self._get_user_mapping_config()
            return UserMappingConfig(
                mode=config.get("mode", "select_user"),
                config=config.get("config"),
            )
        return UserMappingConfig(mode="select_user")

    # ==================== Abstract Methods ====================

    @abstractmethod
    def parse_message(self, raw_data: Any) -> MessageContext:
        """Parse raw message data into MessageContext.

        This method should be implemented by each channel to parse
        channel-specific message format.

        Args:
            raw_data: Raw message data from the channel SDK

        Returns:
            MessageContext with parsed message information
        """
        pass

    @abstractmethod
    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> Optional[User]:
        """Resolve channel user to Wegent user.

        This method should be implemented by each channel to handle
        channel-specific user resolution logic.

        Args:
            db: Database session
            message_context: Parsed message context

        Returns:
            Wegent User or None if not found
        """
        pass

    @abstractmethod
    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        """Send a text reply to the channel.

        This method should be implemented by each channel to send
        messages using the channel's API.

        Args:
            message_context: Original message context
            text: Text to send

        Returns:
            True if sent successfully, False otherwise
        """
        pass

    @abstractmethod
    def create_callback_info(self, message_context: MessageContext) -> TCallbackInfo:
        """Create callback info for task completion notification.

        This method should be implemented by each channel to create
        channel-specific callback information.

        Args:
            message_context: Message context

        Returns:
            Channel-specific CallbackInfo instance
        """
        pass

    @abstractmethod
    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        """Get the callback service for this channel.

        This method should be implemented by each channel to return
        the appropriate callback service instance.

        Returns:
            Channel callback service or None
        """
        pass

    @abstractmethod
    async def create_streaming_emitter(
        self, message_context: MessageContext
    ) -> Optional[Any]:
        """Create a streaming emitter for real-time updates.

        This method should be implemented by each channel to create
        the appropriate streaming emitter.

        Args:
            message_context: Message context

        Returns:
            Streaming emitter or None if not supported
        """
        pass

    # ==================== Common Methods ====================

    async def _get_conversation_task_id(
        self, conversation_id: str, user_id: int
    ) -> Optional[int]:
        """Get cached task_id for a conversation and user from Redis.

        Args:
            conversation_id: Channel conversation ID
            user_id: Wegent user ID

        Returns:
            Cached task_id or None if not found
        """
        if not conversation_id:
            return None
        key = f"{CHANNEL_CONV_TASK_PREFIX}{self._channel_type.value}:{conversation_id}:{user_id}"
        task_id = await cache_manager.get(key)
        return int(task_id) if task_id is not None else None

    async def _set_conversation_task_id(
        self, conversation_id: str, user_id: int, task_id: int
    ) -> None:
        """Cache task_id for a conversation and user in Redis.

        Args:
            conversation_id: Channel conversation ID
            user_id: Wegent user ID
            task_id: Task ID to cache
        """
        if not conversation_id:
            return
        key = f"{CHANNEL_CONV_TASK_PREFIX}{self._channel_type.value}:{conversation_id}:{user_id}"
        await cache_manager.set(key, task_id, expire=CHANNEL_CONV_TASK_TTL)

    async def _delete_conversation_task_id(
        self, conversation_id: str, user_id: int
    ) -> None:
        """Delete cached task_id for a conversation and user from Redis.

        Args:
            conversation_id: Channel conversation ID
            user_id: Wegent user ID
        """
        if not conversation_id:
            return
        key = f"{CHANNEL_CONV_TASK_PREFIX}{self._channel_type.value}:{conversation_id}:{user_id}"
        await cache_manager.delete(key)

    def _get_default_team(self, db: Session, user_id: int) -> Optional[Kind]:
        """Get the default team for this channel.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Team Kind object or None
        """
        team_id = self.default_team_id
        if not team_id:
            self.logger.warning(
                f"[{self._channel_type.value}Handler] No default_team_id configured"
            )
            return None

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
                f"[{self._channel_type.value}Handler] Default team not found: id={team_id}"
            )

        return team

    async def handle_message(self, raw_data: Any) -> bool:
        """Handle an incoming message.

        This is the main entry point for processing messages.
        It orchestrates the message processing flow.

        Args:
            raw_data: Raw message data from the channel SDK

        Returns:
            True if handled successfully, False otherwise
        """
        db = SessionLocal()
        try:
            # Parse the message
            message_context = self.parse_message(raw_data)

            self.logger.info(
                f"[{self._channel_type.value}Handler] Received message: "
                f"sender={message_context.sender_name}, "
                f"content_preview={message_context.content[:50] if message_context.content else 'empty'}"
            )

            if not message_context.content:
                self.logger.warning(
                    f"[{self._channel_type.value}Handler] Empty message content, skipping"
                )
                await self.send_text_reply(message_context, "消息内容为空，请重新发送")
                return False

            # Resolve user
            user = await self.resolve_user(db, message_context)
            if not user:
                self.logger.warning(
                    f"[{self._channel_type.value}Handler] User not found: sender_id={message_context.sender_id}"
                )
                await self.send_text_reply(
                    message_context, "用户未注册，请先登录 Wegent 系统"
                )
                return False

            # Check for commands
            parsed_cmd = parse_command(message_context.content)
            if parsed_cmd:
                await self._handle_command(
                    db=db,
                    user=user,
                    command=parsed_cmd,
                    message_context=message_context,
                )
                return True

            # Process as chat message
            await self._process_chat_message(
                db=db,
                user=user,
                message_context=message_context,
            )
            return True

        except Exception as e:
            self.logger.exception(
                f"[{self._channel_type.value}Handler] Error processing message: {e}"
            )
            return False
        finally:
            db.close()

    async def _handle_command(
        self,
        db: Session,
        user: User,
        command: Any,
        message_context: MessageContext,
    ) -> None:
        """Handle slash commands.

        Args:
            db: Database session
            user: Wegent user
            command: Parsed command
            message_context: Message context
        """
        self.logger.info(
            f"[{self._channel_type.value}Handler] Processing command: {command} for user {user.id}"
        )

        if command.command == CommandType.NEW:
            await self._delete_conversation_task_id(
                message_context.conversation_id, user.id
            )
            await self.send_text_reply(
                message_context, "✅ 已开始新对话，请发送您的消息"
            )

        elif command.command == CommandType.HELP:
            await self.send_text_reply(message_context, HELP_MESSAGE)

        elif command.command == CommandType.DEVICES:
            await self._handle_devices_command(db, user, message_context)

        elif command.command == CommandType.USE:
            await self._handle_use_command(db, user, command.argument, message_context)

        elif command.command == CommandType.STATUS:
            await self._handle_status_command(db, user, message_context)

    async def _handle_devices_command(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Handle /devices command - list online devices."""
        from app.services.device_service import device_service

        devices = await device_service.get_all_devices(db, user.id)

        if not devices:
            await self.send_text_reply(message_context, DEVICES_HEADER + DEVICES_EMPTY)
            return

        message = DEVICES_HEADER + "\n"

        online_devices = [d for d in devices if d["status"] != "offline"]
        offline_devices = [d for d in devices if d["status"] == "offline"]

        if online_devices:
            message += "**在线设备:**\n"
            for idx, device in enumerate(online_devices, start=1):
                status_str = ""
                if device["status"] == "busy":
                    status_str = " - 🔴 忙碌"
                elif device.get("is_default"):
                    status_str = " - ⭐ 默认"
                message += DEVICE_ITEM_TEMPLATE.format(
                    index=idx,
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

        await self.send_text_reply(message_context, message)

    async def _handle_use_command(
        self,
        db: Session,
        user: User,
        argument: Optional[str],
        message_context: MessageContext,
    ) -> None:
        """Handle /use command - switch execution device."""
        from app.services.device_service import device_service

        # No argument - switch back to chat mode
        if not argument:
            await device_selection_manager.set_chat_mode(user.id)
            await self.send_text_reply(
                message_context,
                "✅ 已切换到**对话模式**\n\n现在的消息将直接由 AI 回复",
            )
            return

        argument = argument.strip().lower()

        # Cloud executor
        if argument == "cloud":
            await device_selection_manager.set_cloud_executor(user.id)
            await self.send_text_reply(
                message_context,
                "✅ 已切换到**云端执行模式**\n\n现在的消息将在云端容器中执行",
            )
            return

        # Get all devices
        devices = await device_service.get_all_devices(db, user.id)
        online_devices = [d for d in devices if d["status"] != "offline"]

        matched_device = None

        # Check if argument is a number (device index)
        if argument.isdigit():
            device_index = int(argument)
            if 1 <= device_index <= len(online_devices):
                matched_device = online_devices[device_index - 1]
            else:
                await self.send_text_reply(
                    message_context,
                    f"❌ 无效的设备序号: {argument}\n\n"
                    f"当前有 {len(online_devices)} 个在线设备，请使用 `/devices` 查看列表",
                )
                return
        else:
            # Match by name or device_id prefix
            for device in devices:
                if device["name"].lower() == argument or device[
                    "device_id"
                ].lower().startswith(argument):
                    matched_device = device
                    break

        if not matched_device:
            await self.send_text_reply(
                message_context,
                f"❌ 未找到设备: {argument}\n\n使用 `/devices` 查看可用设备列表",
            )
            return

        if matched_device["status"] == "offline":
            await self.send_text_reply(
                message_context,
                f"❌ 设备 **{matched_device['name']}** 已离线\n\n请选择其他设备或等待设备上线",
            )
            return

        await device_selection_manager.set_local_device(
            user.id,
            matched_device["device_id"],
            matched_device["name"],
        )

        await self.send_text_reply(
            message_context,
            f"✅ 已切换到设备 **{matched_device['name']}**\n\n现在的消息将在该设备上执行",
        )

    async def _handle_status_command(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Handle /status command - show current status."""
        selection = await device_selection_manager.get_selection(user.id)

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

        team = self._get_default_team(db, user.id)
        team_name = team.name if team else "未配置"

        message = STATUS_TEMPLATE.format(
            mode=mode,
            device_info=device_info,
            team_name=team_name,
        )

        await self.send_text_reply(message_context, message)

    async def _process_chat_message(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message based on device selection.

        Args:
            db: Database session
            user: Wegent user
            message_context: Message context
        """
        selection = await device_selection_manager.get_selection(user.id)

        if selection.device_type == DeviceType.CHAT:
            await self._process_chat_mode(db, user, message_context)
        elif selection.device_type == DeviceType.LOCAL:
            await self._process_device_mode(db, user, selection, message_context)
        elif selection.device_type == DeviceType.CLOUD:
            await self._process_cloud_mode(db, user, message_context)

    async def _process_chat_mode(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message in Chat Shell mode (direct LLM conversation)."""
        team = self._get_default_team(db, user.id)
        if not team:
            await self.send_text_reply(message_context, "配置错误: 未配置默认智能体")
            return

        response = await self._create_and_process_chat(
            db=db,
            user=user,
            team=team,
            message_context=message_context,
        )

        if response:
            await self.send_text_reply(message_context, response)

    async def _process_device_mode(
        self,
        db: Session,
        user: User,
        device_selection: DeviceSelection,
        message_context: MessageContext,
    ) -> None:
        """Process message for local device execution."""
        from app.services.device_service import device_service

        device_id = device_selection.device_id
        if not device_id:
            await self.send_text_reply(
                message_context,
                "❌ 设备选择无效，请使用 `/use <设备名>` 重新选择",
            )
            return

        device_info = await device_service.get_device_online_info(user.id, device_id)
        if not device_info:
            await self.send_text_reply(
                message_context,
                f"❌ 设备 **{device_selection.device_name}** 已离线\n\n"
                "请使用 `/devices` 查看在线设备或 `/use` 切换回对话模式",
            )
            return

        slot_info = await device_service.get_device_slot_usage_async(
            db, user.id, device_id
        )
        if slot_info["used"] >= slot_info["max"]:
            await self.send_text_reply(
                message_context,
                f"❌ 设备 **{device_selection.device_name}** 槽位已满 "
                f"({slot_info['used']}/{slot_info['max']})\n\n"
                "请等待当前任务完成或选择其他设备",
            )
            return

        team = self._get_default_team(db, user.id)
        if not team:
            await self.send_text_reply(message_context, "配置错误: 未配置默认智能体")
            return

        response = await self._create_and_process_device_task(
            db=db,
            user=user,
            team=team,
            device_id=device_id,
            message_context=message_context,
        )

        if response:
            await self.send_text_reply(message_context, response)

    async def _process_cloud_mode(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message for cloud executor execution."""
        team = self._get_default_team(db, user.id)
        if not team:
            await self.send_text_reply(message_context, "配置错误: 未配置默认智能体")
            return

        response = await self._create_and_process_cloud_task(
            db=db,
            user=user,
            team=team,
            message_context=message_context,
        )

        if response:
            await self.send_text_reply(message_context, response)

    async def _create_and_process_chat(
        self,
        db: Session,
        user: User,
        team: Kind,
        message_context: MessageContext,
    ) -> Optional[str]:
        """Create a chat task and process it through the AI system.

        Args:
            db: Database session
            user: Wegent user
            team: Team Kind object
            message_context: Message context

        Returns:
            Response text for sync mode, or None if streamed successfully
        """
        from app.services.chat.config import should_use_direct_chat
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )

        message = message_context.content
        conversation_id = message_context.conversation_id

        params = TaskCreationParams(
            message=message,
            title=(
                f"{self._channel_type.value}: {message[:30]}..."
                if len(message) > 30
                else f"{self._channel_type.value}: {message}"
            ),
            is_group_chat=False,
            task_type="chat",
        )

        supports_direct_chat = should_use_direct_chat(db, team, user.id)

        if not supports_direct_chat:
            self.logger.warning(
                f"[{self._channel_type.value}Handler] Team {team.namespace}/{team.name} "
                "does not support direct chat"
            )
            return (
                "This team does not support instant chat, please use the web interface"
            )

        # Try to reuse existing task
        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(
                conversation_id, user.id
            )

        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,
            should_trigger_ai=True,
        )

        if not result.assistant_subtask:
            self.logger.error(
                f"[{self._channel_type.value}Handler] Failed to create assistant subtask"
            )
            return None

        if conversation_id:
            await self._set_conversation_task_id(
                conversation_id, user.id, result.task.id
            )

        self.logger.info(
            f"[{self._channel_type.value}Handler] Task created: task_id={result.task.id}, "
            f"subtask_id={result.assistant_subtask.id}"
        )

        # Create emitters
        sync_emitter = SyncResponseEmitter()
        streaming_emitter = await self.create_streaming_emitter(message_context)

        if streaming_emitter:
            response_emitter = CompositeEmitter(streaming_emitter, sync_emitter)
        else:
            response_emitter = sync_emitter

        # Trigger AI response
        from app.services.chat.trigger.core import trigger_ai_response

        task_room = f"task_{result.task.id}"

        await trigger_ai_response(
            task=result.task,
            assistant_subtask=result.assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=self._build_chat_payload(params),
            task_room=task_room,
            supports_direct_chat=True,
            namespace=None,
            user_subtask_id=result.user_subtask.id,
            event_emitter=response_emitter,
        )

        try:
            response = await asyncio.wait_for(
                sync_emitter.wait_for_response(),
                timeout=120.0,
            )

            if (
                streaming_emitter
                and hasattr(streaming_emitter, "_started")
                and streaming_emitter._started
                and hasattr(streaming_emitter, "_finished")
                and streaming_emitter._finished
            ):
                return None
            else:
                return response

        except asyncio.TimeoutError:
            self.logger.warning(
                f"[{self._channel_type.value}Handler] Response timeout for task {result.task.id}"
            )
            return "Response timeout, please try again later"

    def _build_chat_payload(self, params: Any) -> Any:
        """Build a chat payload object for trigger_ai_response."""
        from dataclasses import dataclass

        @dataclass
        class ChatPayload:
            is_group_chat: bool = False
            enable_web_search: bool = False
            search_engine: Optional[str] = None
            force_override_bot_model: Optional[str] = None
            enable_clarification: bool = False
            preload_skills: Optional[list] = None

        return ChatPayload(
            is_group_chat=params.is_group_chat,
            force_override_bot_model=self.default_model_name,
        )

    async def _create_and_process_device_task(
        self,
        db: Session,
        user: User,
        team: Kind,
        device_id: str,
        message_context: MessageContext,
    ) -> Optional[str]:
        """Create a task and route it to a local device for execution."""
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )
        from app.services.device_router import route_task_to_device

        message = message_context.content
        conversation_id = message_context.conversation_id

        params = TaskCreationParams(
            message=message,
            title=(
                f"{self._channel_type.value}: {message[:30]}..."
                if len(message) > 30
                else f"{self._channel_type.value}: {message}"
            ),
            is_group_chat=False,
            task_type="task",
        )

        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(
                conversation_id, user.id
            )

        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,
            should_trigger_ai=True,
        )

        if not result.assistant_subtask:
            return "创建任务失败，请重试"

        if conversation_id:
            await self._set_conversation_task_id(
                conversation_id, user.id, result.task.id
            )

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

            # Save callback info
            callback_service = self.get_callback_service()
            if callback_service:
                callback_info = self.create_callback_info(message_context)
                await callback_service.save_callback_info(
                    task_id=result.task.id,
                    callback_info=callback_info,
                )

            # Send acknowledgment
            streaming_emitter = await self.create_streaming_emitter(message_context)
            if streaming_emitter:
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
                        "💡 任务完成后将自动发送结果。"
                    ),
                    offset=0,
                )
                await streaming_emitter.emit_chat_done(
                    task_id=result.task.id,
                    subtask_id=result.assistant_subtask.id,
                    offset=0,
                )

            return None

        except Exception as e:
            self.logger.exception(
                f"[{self._channel_type.value}Handler] Failed to route task to device: {e}"
            )
            return f"发送任务到设备失败: {str(e)}"

    async def _create_and_process_cloud_task(
        self,
        db: Session,
        user: User,
        team: Kind,
        message_context: MessageContext,
    ) -> Optional[str]:
        """Create a task for cloud executor execution."""
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )
        from app.services.task_dispatcher import task_dispatcher

        message = message_context.content
        conversation_id = message_context.conversation_id

        params = TaskCreationParams(
            message=message,
            title=(
                f"{self._channel_type.value}: {message[:30]}..."
                if len(message) > 30
                else f"{self._channel_type.value}: {message}"
            ),
            is_group_chat=False,
            task_type="task",
        )

        existing_task_id = None
        if conversation_id:
            existing_task_id = await self._get_conversation_task_id(
                conversation_id, user.id
            )

        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=existing_task_id,
            should_trigger_ai=True,
        )

        if not result.assistant_subtask:
            return "创建任务失败，请重试"

        if conversation_id:
            await self._set_conversation_task_id(
                conversation_id, user.id, result.task.id
            )

        task_dispatcher.schedule_dispatch(result.task.id)

        # Send acknowledgment
        streaming_emitter = await self.create_streaming_emitter(message_context)
        if streaming_emitter:
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
            await streaming_emitter.emit_chat_done(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                offset=0,
            )
            return None
        else:
            return (
                f"✅ 任务已提交到云端执行队列\n\n"
                f"任务 ID: {result.task.id}\n"
                "任务完成后将收到通知。"
            )
