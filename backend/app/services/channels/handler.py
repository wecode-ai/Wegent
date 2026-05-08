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
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Generic, List, Optional, TypeVar

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
)
from app.services.channels.commands import (
    AGENT_ITEM_TEMPLATE,
    AGENTS_EMPTY,
    AGENTS_FOOTER,
    AGENTS_HEADER,
    DEVICE_ITEM_TEMPLATE,
    DEVICES_EMPTY,
    DEVICES_FOOTER,
    DEVICES_HEADER,
    HELP_MESSAGE,
    IM_CHANNEL_CONTEXT_HINT,
    MODEL_ITEM_TEMPLATE,
    MODELS_EMPTY,
    MODELS_FOOTER,
    MODELS_HEADER,
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
from app.services.channels.model_selection import (
    ModelSelection,
    is_claude_provider,
    model_selection_manager,
)
from app.services.readers.kinds import KindType, kindReader

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
    images: List[Dict[str, str]] = field(default_factory=list)
    # Each image dict: {"mime_type": "image/png", "base64_data": "iVBOR..."}
    files: List[Dict[str, Any]] = field(default_factory=list)
    # Each file dict: {"filename": "doc.pdf", "binary_data": b"...", "file_size": 12345}


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
    ) -> tuple[Optional[int], bool]:
        """Get cached task_id for a conversation and user from Redis.

        Also checks conversation timeout by querying task's updated_at from database.
        If the task was updated more than IM_CHANNEL_CONVERSATION_TIMEOUT_MINUTES ago,
        returns None and sets auto_new_conversation flag.

        Args:
            conversation_id: Channel conversation ID
            user_id: Wegent user ID

        Returns:
            Tuple of (task_id, auto_new_conversation):
            - task_id: Cached task_id or None if not found or timeout
            - auto_new_conversation: True if new conversation was started due to timeout
        """
        from app.core.config import settings
        from app.models.task import TaskResource

        if not conversation_id:
            return None, False

        key = f"{CHANNEL_CONV_TASK_PREFIX}{self._channel_type.value}:{conversation_id}:{user_id}"
        cached_task_id = await cache_manager.get(key)

        if cached_task_id is None:
            return None, False

        task_id = int(cached_task_id)

        # Check timeout if configured
        timeout_minutes = settings.IM_CHANNEL_CONVERSATION_TIMEOUT_MINUTES
        if timeout_minutes > 0:
            # Query task's updated_at from database
            db = SessionLocal()
            try:
                task = db.query(TaskResource).filter(TaskResource.id == task_id).first()
                if task and task.updated_at:
                    now = datetime.now()
                    elapsed_minutes = (now - task.updated_at).total_seconds() / 60
                    if elapsed_minutes > timeout_minutes:
                        # Timeout exceeded, delete old conversation and return None
                        await cache_manager.delete(key)
                        self.logger.info(
                            f"[{self._channel_type.value}Handler] Conversation timeout for user {user_id}: "
                            f"elapsed={elapsed_minutes:.1f}min, timeout={timeout_minutes}min"
                        )
                        return None, True  # auto_new_conversation = True
            finally:
                db.close()

        return task_id, False

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

    def _get_task_mode_team(self, db: Session, user_id: int) -> Optional[Kind]:
        """Get the default team for task mode (device/cloud execution).

        Uses the DEFAULT_TEAM_TASK config (e.g. "wegent-wework#default") to look up
        the team by name and namespace, matching the behavior of the PC/Web frontend.
        Falls back to the channel's default_team_id if not configured.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Team Kind object or None
        """
        config_value = settings.DEFAULT_TEAM_TASK
        if not config_value or not config_value.strip():
            return self._get_default_team(db, user_id)

        parts = config_value.strip().split("#", 1)
        name = parts[0].strip()
        namespace = parts[1].strip() if len(parts) > 1 else "default"

        if not name:
            return self._get_default_team(db, user_id)

        team = kindReader.get_by_name_and_namespace(
            db, user_id, KindType.TEAM, namespace, name
        )

        if not team:
            self.logger.warning(
                f"[{self._channel_type.value}Handler] Task mode team not found: "
                f"name={name}, namespace={namespace}, user_id={user_id}. "
                f"Falling back to channel default team."
            )
            return self._get_default_team(db, user_id)

        return team

    async def _get_selected_or_default_team(
        self, db: Session, user_id: int
    ) -> Optional[Kind]:
        """Get user's selected team or fall back to default team.

        This method checks if the user has manually selected a team via /agents
        command. If so, returns that team. Otherwise, falls back to the
        channel's configured default team.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Team Kind object or None
        """
        from app.services.channels.team_selection import team_selection_manager

        # Check if user has a manually selected team
        selection = await team_selection_manager.get_selection(user_id)
        if selection:
            team = (
                db.query(Kind)
                .filter(
                    Kind.id == selection.team_id,
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .first()
            )
            if team:
                self.logger.info(
                    f"[{self._channel_type.value}Handler] Using user-selected team: "
                    f"{team.name} (id={team.id})"
                )
                return team
            else:
                self.logger.warning(
                    f"[{self._channel_type.value}Handler] User-selected team not found "
                    f"or inactive: id={selection.team_id}, clearing selection"
                )
                await team_selection_manager.clear_selection(user_id)

        # Fall back to default team
        return self._get_default_team(db, user_id)

    async def _get_user_model_override(
        self, user_id: int
    ) -> tuple[Optional[str], Optional[str]]:
        """Get user's model selection for override.

        Returns model name and type from user's selection in Redis,
        or falls back to channel's default model.

        Args:
            user_id: Wegent user ID

        Returns:
            Tuple of (model_name, model_type) or (None, None) if no override
        """
        model_selection = await model_selection_manager.get_selection(user_id)
        if model_selection:
            return model_selection.model_name, model_selection.model_type

        # Fall back to channel's default model
        if self.default_model_name:
            return self.default_model_name, None

        return None, None

    async def _get_device_mode_model_override(
        self, db: Session, user: User
    ) -> tuple[Optional[str], Optional[str]]:
        """Get model override for device mode.

        For device mode, if user hasn't selected a Claude model,
        use the configured default device model instead.

        Args:
            db: Database session
            user: Wegent user

        Returns:
            Tuple of (model_name, model_type) or (None, None) if no override
        """
        from app.core.config import settings
        from app.services.model_aggregation_service import model_aggregation_service

        model_selection = await model_selection_manager.get_selection(user.id)

        # Get all available models to check provider accurately
        all_models = model_aggregation_service.list_available_models(
            db=db,
            current_user=user,
            shell_type=None,
            include_config=False,
            scope="personal",
            model_category_type="llm",
        )

        # If user has selected a model, check if it's Claude from the model list
        if model_selection:
            for model in all_models:
                if model.get("name") == model_selection.model_name:
                    if is_claude_provider(model.get("provider")):
                        # User selected a Claude model, use it
                        return model_selection.model_name, model_selection.model_type
                    break  # Found the model but it's not Claude

        # User hasn't selected a Claude model, check if there's a default device model
        default_model_name = settings.IM_CHANNEL_DEVICE_DEFAULT_MODEL.strip()
        if default_model_name:
            for model in all_models:
                m_name = model.get("name", "")
                m_display = model.get("displayName") or ""
                if (
                    m_name == default_model_name or m_display == default_model_name
                ) and is_claude_provider(model.get("provider")):
                    self.logger.info(
                        f"[{self._channel_type.value}Handler] Using default device model "
                        f"for user {user.id}: {default_model_name}"
                    )
                    return model.get("name"), model.get("type", "public")

        # Fall back to user's selection (even if not Claude)
        if model_selection:
            return model_selection.model_name, model_selection.model_type

        return None, None

    async def handle_message(self, raw_data: Any) -> bool:
        """Handle an incoming message.

        This is the main entry point for processing messages.
        It orchestrates the message processing flow.

        Args:
            raw_data: Raw message data from the channel SDK

        Returns:
            True if handled successfully, False otherwise
        """
        # Parse the message first (no db needed)
        message_context = self.parse_message(raw_data)

        self.logger.info(
            f"[{self._channel_type.value}Handler] Received message: "
            f"sender={message_context.sender_name}, "
            f"content_preview={message_context.content[:50] if message_context.content else 'empty'}"
        )

        if (
            not message_context.content
            and not message_context.images
            and not message_context.files
        ):
            self.logger.warning(
                f"[{self._channel_type.value}Handler] Empty message content, skipping"
            )
            await self.send_text_reply(message_context, "消息内容为空，请重新发送")
            return False

        # Resolve user with a short-lived db session
        db = SessionLocal()
        try:
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
        except Exception as e:
            self.logger.exception(
                f"[{self._channel_type.value}Handler] Error resolving user or handling command: {e}"
            )
            return False
        finally:
            db.close()

        # Process as chat message (uses its own db sessions for short operations)
        try:
            await self._process_chat_message(
                user=user,
                message_context=message_context,
            )
            return True
        except Exception as e:
            self.logger.exception(
                f"[{self._channel_type.value}Handler] Error processing chat message: {e}"
            )
            return False

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
            await self._handle_devices_command(
                db, user, command.argument, message_context
            )

        elif command.command == CommandType.USE:
            await self._handle_use_command(db, user, command.argument, message_context)

        elif command.command == CommandType.STATUS:
            await self._handle_status_command(db, user, message_context)

        elif command.command == CommandType.MODELS:
            await self._handle_model_command(
                db, user, command.argument, message_context
            )

        elif command.command == CommandType.AGENTS:
            await self._handle_agent_command(
                db, user, command.argument, message_context
            )

    async def _handle_devices_command(
        self,
        db: Session,
        user: User,
        argument: Optional[str],
        message_context: MessageContext,
    ) -> None:
        """Handle /devices command - list devices or switch to a device."""
        from app.services.device_service import device_service

        devices = await device_service.get_all_devices(db, user.id)
        online_devices = [d for d in devices if d["status"] != "offline"]

        # With argument - switch to specified device
        if argument:
            argument = argument.strip()

            if not devices:
                await self.send_text_reply(
                    message_context,
                    "❌ 暂无可用设备\n\n💡 在本地运行 Executor 后设备会自动出现",
                )
                return

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
                argument_lower = argument.lower()
                for device in devices:
                    if device["name"].lower() == argument_lower or device[
                        "device_id"
                    ].lower().startswith(argument_lower):
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

            # Get model for device mode (uses default Claude if user hasn't selected one)
            override_model_name, _ = await self._get_device_mode_model_override(
                db, user
            )

            # Check if we have a valid Claude model for device mode
            if not override_model_name:
                model_selection = await model_selection_manager.get_selection(user.id)
                if model_selection and not model_selection.is_claude_model():
                    model_display = (
                        model_selection.display_name or model_selection.model_name
                    )
                    await self.send_text_reply(
                        message_context,
                        f"⚠️ 当前模型 **{model_display}** 不支持设备模式\n\n"
                        "设备模式仅支持 Claude 模型，请先使用 `/models` 切换到 Claude 模型",
                    )
                    return

            # Get display name for the model
            from app.services.model_aggregation_service import model_aggregation_service

            model_display_name = override_model_name or "默认模型"
            if override_model_name:
                all_models = model_aggregation_service.list_available_models(
                    db=db,
                    current_user=user,
                    shell_type=None,
                    include_config=False,
                    scope="personal",
                    model_category_type="llm",
                )
                for m in all_models:
                    if m.get("name") == override_model_name:
                        model_display_name = m.get("displayName") or override_model_name
                        break

            # Clear conversation cache if switching mode or device
            current_selection = await device_selection_manager.get_selection(user.id)
            if (
                current_selection.device_type != DeviceType.LOCAL
                or current_selection.device_id != matched_device["device_id"]
            ):
                await self._delete_conversation_task_id(
                    message_context.conversation_id, user.id
                )

            await device_selection_manager.set_local_device(
                user.id,
                matched_device["device_id"],
                matched_device["name"],
            )

            await self.send_text_reply(
                message_context,
                f"✅ 已切换到设备 **{matched_device['name']}**\n\n"
                f"当前模型: **{model_display_name}**\n"
                "现在的消息将在该设备上执行",
            )
            return

        # No argument - list devices
        if not devices:
            await self.send_text_reply(message_context, DEVICES_HEADER + DEVICES_EMPTY)
            return

        # Get current device selection
        current_selection = await device_selection_manager.get_selection(user.id)
        current_device_id = (
            current_selection.device_id
            if current_selection.device_type == DeviceType.LOCAL
            else None
        )

        message = DEVICES_HEADER + "\n"
        offline_devices = [d for d in devices if d["status"] == "offline"]

        if online_devices:
            message += "**在线设备:**\n"
            for idx, device in enumerate(online_devices, start=1):
                status_str = ""
                if device["device_id"] == current_device_id:
                    status_str = " - ⭐ 当前"
                elif device["status"] == "busy":
                    status_str = " - 🔴 忙碌"
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

        # Only show switch hint if there are online devices
        if online_devices:
            message += DEVICES_FOOTER
        else:
            message += "\n💡 在本地运行 Executor 后设备会自动上线"

        await self.send_text_reply(message_context, message)

    async def _handle_use_command(
        self,
        db: Session,
        user: User,
        argument: Optional[str],
        message_context: MessageContext,
    ) -> None:
        """Handle /use command - show status or switch execution mode."""
        # No argument - show current status with mode switching tips
        if not argument:
            await self._handle_status_command(db, user, message_context)
            return

        argument = argument.strip().lower()

        # Check if mode is changing; if so, clear conversation cache
        # so the next message creates a new task with the correct team
        current_selection = await device_selection_manager.get_selection(user.id)
        current_mode = current_selection.device_type
        target_mode_map = {
            "chat": DeviceType.CHAT,
            "cloud": DeviceType.CLOUD,
            "device": DeviceType.LOCAL,
        }
        target_mode = target_mode_map.get(argument)
        if target_mode and target_mode != current_mode:
            await self._delete_conversation_task_id(
                message_context.conversation_id, user.id
            )

        # Helper to get current model display name
        async def get_model_display() -> str:
            model_selection = await model_selection_manager.get_selection(user.id)
            if model_selection:
                return model_selection.display_name or model_selection.model_name
            return self.default_model_name or "默认模型"

        # Chat mode
        if argument == "chat":
            await device_selection_manager.set_chat_mode(user.id)
            model_name = await get_model_display()
            await self.send_text_reply(
                message_context,
                f"✅ 已切换到**对话模式**\n\n"
                f"当前模型: **{model_name}**\n"
                "现在的消息将直接由 AI 回复",
            )
            return

        # Cloud executor
        if argument == "cloud":
            await device_selection_manager.set_cloud_executor(user.id)
            model_name = await get_model_display()
            await self.send_text_reply(
                message_context,
                f"✅ 已切换到**云端执行模式**\n\n"
                f"当前模型: **{model_name}**\n"
                "现在的消息将在云端容器中执行",
            )
            return

        # Device mode - use last selected device
        if argument == "device":
            await self._handle_use_device_mode(db, user, message_context)
            return

        # Unknown argument
        await self.send_text_reply(
            message_context,
            f"❌ 未知的执行模式: {argument}\n\n"
            "可用模式:\n"
            "• `/use chat` - 对话模式\n"
            "• `/use cloud` - 云端模式\n"
            "• `/use device` - 设备模式",
        )

    async def _handle_use_device_mode(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Handle /use device - switch to last selected device."""
        from app.core.config import settings
        from app.services.device_service import device_service
        from app.services.model_aggregation_service import model_aggregation_service

        # Check if current model is Claude (required for device mode)
        model_selection = await model_selection_manager.get_selection(user.id)
        is_claude = model_selection and model_selection.is_claude_model()

        # Model to display in success message
        # Will be updated if we use default device model
        device_model_display = None

        # If not Claude, check if there's a default device model to use temporarily
        if not is_claude:
            current_model_display = (
                model_selection.display_name or model_selection.model_name
                if model_selection
                else self.default_model_name or "默认模型"
            )

            # Check if there's a default device mode model configured
            default_model_name = settings.IM_CHANNEL_DEVICE_DEFAULT_MODEL.strip()
            if default_model_name:
                # Try to find the default model in available models
                all_models = model_aggregation_service.list_available_models(
                    db=db,
                    current_user=user,
                    shell_type=None,
                    include_config=False,
                    scope="personal",
                    model_category_type="llm",
                )
                default_model = None
                for model in all_models:
                    m_name = model.get("name", "")
                    m_display = model.get("displayName") or ""
                    if (
                        m_name == default_model_name or m_display == default_model_name
                    ) and is_claude_provider(model.get("provider")):
                        default_model = model
                        break

                if default_model:
                    # Use default model for device mode (don't save to user selection)
                    # This way, switching back to chat mode will use channel's default model
                    device_model_display = default_model.get(
                        "displayName"
                    ) or default_model.get("name")
                    is_claude = True
                    self.logger.info(
                        f"[{self._channel_type.value}Handler] Using default device model "
                        f"for user {user.id}: {default_model_name}"
                    )
                else:
                    self.logger.warning(
                        f"[{self._channel_type.value}Handler] Default device model "
                        f"'{default_model_name}' not found or not a Claude model"
                    )

            # If still not Claude, show available options
            if not is_claude:
                all_models = model_aggregation_service.list_available_models(
                    db=db,
                    current_user=user,
                    shell_type=None,
                    include_config=False,
                    scope="personal",
                    model_category_type="llm",
                )
                claude_models = [
                    m for m in all_models if is_claude_provider(m.get("provider"))
                ]

                if claude_models:
                    message = (
                        f"⚠️ 当前模型 **{current_model_display}** 不支持设备模式\n\n"
                        "设备模式仅支持 Claude 模型，请使用 `/models <序号>` 切换:\n\n"
                    )
                    # Show Claude models with their real index in full list
                    for idx, model in enumerate(all_models, start=1):
                        if is_claude_provider(model.get("provider")):
                            display_name = model.get("displayName") or model.get(
                                "name", ""
                            )
                            provider = model.get("provider", "")
                            message += f"**{idx}.** {display_name} ({provider})\n"
                else:
                    message = (
                        f"⚠️ 当前模型 **{current_model_display}** 不支持设备模式\n\n"
                        "设备模式仅支持 Claude 模型，但暂无可用的 Claude 模型\n"
                        "💡 请联系管理员配置 Claude 模型"
                    )

                await self.send_text_reply(message_context, message)
                return

        # Get model display name for success messages
        # Use device_model_display if we're using default device model,
        # otherwise use user's selected Claude model
        if device_model_display:
            model_name = device_model_display
        elif model_selection:
            model_name = model_selection.display_name or model_selection.model_name
        else:
            model_name = "默认模型"

        # Check if user has a previously selected device
        selection = await device_selection_manager.get_selection(user.id)

        if selection.device_type == DeviceType.LOCAL and selection.device_id:
            # Verify device is still online
            device_info = await device_service.get_device_online_info(
                user.id, selection.device_id
            )
            if device_info:
                await self.send_text_reply(
                    message_context,
                    f"✅ 已切换到**设备模式**\n\n"
                    f"当前设备: **{selection.device_name or selection.device_id[:8]}**\n"
                    f"当前模型: **{model_name}**",
                )
                return
            else:
                await self.send_text_reply(
                    message_context,
                    f"❌ 上次选择的设备 **{selection.device_name}** 已离线\n\n"
                    "请使用 `/devices` 选择其他设备",
                )
                return

        # No previous device selection - check if there's only one online device
        devices = await device_service.get_all_devices(db, user.id)
        online_devices = [d for d in devices if d["status"] != "offline"]

        if len(online_devices) == 1:
            # Auto-select the only online device
            device = online_devices[0]
            await device_selection_manager.set_local_device(
                user.id,
                device["device_id"],
                device["name"],
            )
            await self.send_text_reply(
                message_context,
                f"✅ 已自动切换到**设备模式**\n\n"
                f"当前设备: **{device['name']}** (唯一在线设备)\n"
                f"当前模型: **{model_name}**",
            )
            return

        # No online devices or multiple devices - check and prompt accordingly
        if len(online_devices) == 0:
            await self.send_text_reply(
                message_context,
                "❌ 暂无在线设备\n\n💡 在本地运行 Executor 后设备会自动出现",
            )
        else:
            # Multiple online devices, prompt user to select one
            await self.send_text_reply(
                message_context,
                f"❌ 尚未选择设备，当前有 {len(online_devices)} 个在线设备\n\n"
                "请使用 `/devices <序号>` 选择一个设备",
            )

    async def _handle_status_command(
        self,
        db: Session,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Handle /status command - show current status."""
        from app.services.device_service import device_service

        selection = await device_selection_manager.get_selection(user.id)

        if selection.device_type == DeviceType.CHAT:
            mode = "💬 对话模式"
            device_info = ""
        elif selection.device_type == DeviceType.LOCAL:
            mode = "💻 本地设备模式"
            # Check device online status
            device_name = selection.device_name or selection.device_id[:8]
            if selection.device_id:
                online_info = await device_service.get_device_online_info(
                    user.id, selection.device_id
                )
                if online_info:
                    status_icon = "🟢" if online_info.get("status") != "busy" else "🔴"
                    device_info = f"**当前设备**: {device_name} ({status_icon} 在线)\n"
                else:
                    device_info = f"**当前设备**: {device_name} (⚫ 离线)\n"
            else:
                device_info = f"**当前设备**: {device_name}\n"
        else:
            mode = "☁️ 云端执行模式"
            device_info = ""

        # Get team - prioritize user selection over default
        from app.services.channels.team_selection import team_selection_manager

        team_selection = await team_selection_manager.get_selection(user.id)
        if team_selection:
            team = (
                db.query(Kind)
                .filter(
                    Kind.id == team_selection.team_id,
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .first()
            )
            if team:
                team_json = team.json or {}
                team_spec = team_json.get("spec", {})
                display = team_spec.get("displayName") or team.name
                team_name = f"{display} (用户选择)"
            else:
                # Selected team no longer exists, clear it
                await team_selection_manager.clear_selection(user.id)
                team = self._get_default_team(db, user.id)
                if team:
                    team_json = team.json or {}
                    team_spec = team_json.get("spec", {})
                    team_name = team_spec.get("displayName") or team.name
                else:
                    team_name = "未配置"
        else:
            team = self._get_default_team(db, user.id)
            if team:
                team_json = team.json or {}
                team_spec = team_json.get("spec", {})
                team_name = team_spec.get("displayName") or team.name
            else:
                team_name = "未配置"

        # Get model selection
        # For device mode, show the actual model that will be used (may be default device model)
        model_selection = await model_selection_manager.get_selection(user.id)
        if selection.device_type == DeviceType.LOCAL:
            # In device mode, use _get_device_mode_model_override to get the actual model
            override_model_name, _ = await self._get_device_mode_model_override(
                db, user
            )
            if override_model_name:
                # Find the display name for this model
                from app.services.model_aggregation_service import (
                    model_aggregation_service,
                )

                all_models = model_aggregation_service.list_available_models(
                    db=db,
                    current_user=user,
                    shell_type=None,
                    include_config=False,
                    scope="personal",
                    model_category_type="llm",
                )
                model_name = override_model_name
                for m in all_models:
                    if m.get("name") == override_model_name:
                        model_name = m.get("displayName") or override_model_name
                        break
            elif model_selection:
                model_name = model_selection.display_name or model_selection.model_name
            else:
                model_name = self.default_model_name or "默认模型"
        elif model_selection:
            model_name = model_selection.display_name or model_selection.model_name
        else:
            model_name = self.default_model_name or "默认模型"

        message = STATUS_TEMPLATE.format(
            mode=mode,
            device_info=device_info,
            model_name=model_name,
            team_name=team_name,
        )

        await self.send_text_reply(message_context, message)

    async def _handle_model_command(
        self,
        db: Session,
        user: User,
        argument: Optional[str],
        message_context: MessageContext,
    ) -> None:
        """Handle /models command - list/switch models.

        In device mode, only Claude models are shown since device execution
        requires Claude Code which only supports Claude/Anthropic models.
        """
        from app.services.model_aggregation_service import model_aggregation_service

        # Check current execution mode
        selection = await device_selection_manager.get_selection(user.id)
        is_device_mode = selection.device_type == DeviceType.LOCAL

        # Get available models
        all_models = model_aggregation_service.list_available_models(
            db=db,
            current_user=user,
            shell_type=None,  # No shell type filter for IM channels
            include_config=False,
            scope="personal",
            model_category_type="llm",  # Only list LLM models
        )

        if not all_models:
            await self.send_text_reply(message_context, MODELS_HEADER + MODELS_EMPTY)
            return

        # Check if there are available models for current mode
        if is_device_mode:
            claude_models = [
                m for m in all_models if is_claude_provider(m.get("provider"))
            ]
            if not claude_models:
                await self.send_text_reply(
                    message_context,
                    MODELS_HEADER + "\n暂无可用的 Claude 模型\n\n"
                    "💡 设备模式仅支持 Claude 模型，请联系管理员配置",
                )
                return
            mode_hint = "\n\n⚠️ 设备模式仅支持 Claude 模型"
        else:
            mode_hint = ""

        # No argument - list models
        if not argument:
            message = MODELS_HEADER + mode_hint + "\n\n"

            # Get current selection to mark it
            current_selection = await model_selection_manager.get_selection(user.id)
            current_model_name = (
                current_selection.model_name if current_selection else None
            )

            # In device mode, show real index from full list for consistency
            # In other modes, show sequential index
            for idx, model in enumerate(all_models, start=1):
                # In device mode, skip non-Claude models
                if is_device_mode and not is_claude_provider(model.get("provider")):
                    continue

                model_name = model.get("name", "")
                display_name = model.get("displayName") or model_name
                provider = model.get("provider", "")
                model_type = model.get("type", "")

                # Mark current selection
                status_str = ""
                if model_name == current_model_name:
                    status_str = " - ⭐ 当前"
                elif model_type == "public":
                    status_str = " [公共]"
                elif model_type == "group":
                    status_str = " [群组]"

                message += MODEL_ITEM_TEMPLATE.format(
                    index=idx,
                    name=display_name,
                    provider=provider or "未知",
                    status=status_str,
                )

            message += MODELS_FOOTER
            await self.send_text_reply(message_context, message)
            return

        # With argument - select model
        argument = argument.strip()
        matched_model = None

        # Check if argument is a number (model index)
        # Always use full list index for consistency
        if argument.isdigit():
            model_index = int(argument)
            if 1 <= model_index <= len(all_models):
                selected = all_models[model_index - 1]
                # In device mode, verify it's a Claude model
                if is_device_mode and not is_claude_provider(selected.get("provider")):
                    await self.send_text_reply(
                        message_context,
                        f"❌ 模型 **{selected.get('displayName') or selected.get('name')}** "
                        "不支持设备模式\n\n设备模式仅支持 Claude 模型，请选择其他模型",
                    )
                    return
                matched_model = selected
            else:
                await self.send_text_reply(
                    message_context,
                    f"❌ 无效的模型序号: {argument}\n\n"
                    f"当前有 {len(all_models)} 个模型，请使用 `/models` 查看列表",
                )
                return
        else:
            # Match by name (case-insensitive) - search in full list
            argument_lower = argument.lower()
            for model in all_models:
                model_name = model.get("name", "")
                display_name = model.get("displayName") or ""
                if (
                    model_name.lower() == argument_lower
                    or display_name.lower() == argument_lower
                ):
                    # In device mode, verify it's a Claude model
                    if is_device_mode and not is_claude_provider(model.get("provider")):
                        await self.send_text_reply(
                            message_context,
                            f"❌ 模型 **{display_name or model_name}** 不支持设备模式\n\n"
                            "设备模式仅支持 Claude 模型，请选择其他模型",
                        )
                        return
                    matched_model = model
                    break

        if not matched_model:
            await self.send_text_reply(
                message_context,
                f"❌ 未找到模型: {argument}\n\n使用 `/models` 查看可用模型列表",
            )
            return

        # Save selection to Redis
        new_selection = ModelSelection(
            model_name=matched_model.get("name", ""),
            model_type=matched_model.get("type", "public"),
            display_name=matched_model.get("displayName"),
            provider=matched_model.get("provider"),
        )
        await model_selection_manager.set_selection(user.id, new_selection)

        display_name = new_selection.display_name or new_selection.model_name
        await self.send_text_reply(
            message_context,
            f"✅ 已切换到模型 **{display_name}**\n\n现在的对话将使用该模型",
        )

    async def _handle_agent_command(
        self,
        db: Session,
        user: User,
        argument: Optional[str],
        message_context: MessageContext,
    ) -> None:
        """Handle /agents command - list teams or switch to a team.

        This command allows users to view and select from their available
        teams/agents. Users can switch between personal teams, shared teams,
        and system teams at any time during the conversation.

        Args:
            db: Database session
            user: Wegent user
            argument: Optional argument (team index, name, or 'default')
            message_context: Message context
        """
        from app.services.adapters.team_kinds import team_kinds_service
        from app.services.channels.team_selection import (
            TeamSelection,
            team_selection_manager,
        )

        # Get all user's teams (personal + shared + system)
        teams = team_kinds_service.get_user_teams(
            db=db,
            user_id=user.id,
            scope="all",
        )

        if not teams:
            await self.send_text_reply(
                message_context,
                AGENTS_HEADER
                + AGENTS_EMPTY
                + "\n\n💡 您也可以尝试使用 `/agents default` 使用系统默认智能体",
            )
            return

        # With argument - switch to specified team
        if argument:
            argument = argument.strip().lower()

            # Support "default" to revert to system default
            if argument == "default":
                await team_selection_manager.clear_selection(user.id)
                await self._delete_conversation_task_id(
                    message_context.conversation_id, user.id
                )

                default_team = self._get_default_team(db, user.id)
                if default_team:
                    team_json = default_team.json or {}
                    team_spec = team_json.get("spec", {})
                    display_name = team_spec.get("displayName") or default_team.name
                    await self.send_text_reply(
                        message_context,
                        f"✅ 已恢复使用系统默认智能体: **{display_name}**\n\n"
                        "💡 现在开始使用系统配置的智能体进行对话",
                    )
                else:
                    await self.send_text_reply(
                        message_context,
                        "✅ 已清除智能体选择\n\n"
                        "⚠️ 注意: 系统未配置默认智能体，请先使用 `/agents <序号>` 选择智能体",
                    )
                return

            matched_team = None

            # Check if argument is a number (team index)
            if argument.isdigit():
                team_index = int(argument)
                if 1 <= team_index <= len(teams):
                    matched_team = teams[team_index - 1]
                else:
                    await self.send_text_reply(
                        message_context,
                        f"❌ 无效的智能体序号: {argument}\n\n"
                        f"当前有 {len(teams)} 个智能体，请使用 `/agents` 查看列表",
                    )
                    return
            else:
                # Match by name (case-insensitive)
                argument_lower = argument.lower()
                for team in teams:
                    team_name = team.get("name", "").lower()
                    if team_name == argument_lower:
                        matched_team = team
                        break

            if not matched_team:
                await self.send_text_reply(
                    message_context,
                    f"❌ 未找到智能体: `{argument}`\n\n使用 `/agents` 查看可用智能体列表",
                )
                return

            # Save selection to Redis
            # matched_team is a dictionary from team_kinds_service.get_user_teams()
            display_name = matched_team.get("name") or "Unnamed"
            matched_team_id = matched_team.get("id")
            matched_team_name = matched_team.get("name") or "Unnamed"
            matched_team_namespace = matched_team.get("namespace") or "default"

            await team_selection_manager.set_selection(
                user.id,
                TeamSelection(
                    team_id=matched_team_id,
                    team_name=matched_team_name,
                    team_namespace=matched_team_namespace,
                    display_name=display_name,
                ),
            )

            # Clear conversation cache to start fresh with new team
            await self._delete_conversation_task_id(
                message_context.conversation_id, user.id
            )

            await self.send_text_reply(
                message_context,
                f"✅ 已切换到智能体: **{display_name}**\n\n"
                f"命名空间: `{matched_team_namespace}`\n"
                f"💡 现在开始使用新智能体进行对话",
            )
            return

        # No argument - list teams
        current_selection = await team_selection_manager.get_selection(user.id)
        current_team_id = current_selection.team_id if current_selection else None

        message = AGENTS_HEADER + "\n"

        for idx, team in enumerate(teams, start=1):
            # team is a dictionary from team_kinds_service.get_user_teams()
            display_name = team.get("name") or "Unnamed"
            namespace = team.get("namespace") or "default"
            team_id = team.get("id")

            # Build status string
            status_parts = []
            if team_id == current_team_id:
                status_parts.append("⭐ 当前")
            if team_id == self.default_team_id:
                status_parts.append("系统默认")

            status_str = " - " + ", ".join(status_parts) if status_parts else ""

            message += AGENT_ITEM_TEMPLATE.format(
                index=idx,
                name=display_name,
                namespace=namespace,
                status=status_str,
            )

        message += AGENTS_FOOTER
        await self.send_text_reply(message_context, message)

    async def _process_chat_message(
        self,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message based on device selection.

        Note: This method manages its own db sessions internally
        to avoid holding long-lived transactions during streaming.

        Args:
            user: Wegent user
            message_context: Message context
        """
        selection = await device_selection_manager.get_selection(user.id)

        if selection.device_type == DeviceType.CHAT:
            await self._process_chat_mode(user, message_context)
        elif selection.device_type == DeviceType.LOCAL:
            await self._process_device_mode(user, selection, message_context)
        elif selection.device_type == DeviceType.CLOUD:
            await self._process_cloud_mode(user, message_context)

    async def _process_chat_mode(
        self,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message in Chat Shell mode (direct LLM conversation)."""
        response = await self._create_and_process_chat(
            user=user,
            message_context=message_context,
        )

        if response:
            await self.send_text_reply(message_context, response)

    async def _process_device_mode(
        self,
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

        # Use short-lived db session for database operations
        db = SessionLocal()
        try:
            team = self._get_task_mode_team(db, user.id)
            if not team:
                await self.send_text_reply(
                    message_context, "配置错误: 未配置默认智能体"
                )
                return

            response = await self._create_and_process_device_task(
                db=db,
                user=user,
                team=team,
                device_id=device_id,
                message_context=message_context,
            )
        finally:
            db.close()

        if response:
            await self.send_text_reply(message_context, response)

    async def _process_cloud_mode(
        self,
        user: User,
        message_context: MessageContext,
    ) -> None:
        """Process message for cloud executor execution."""
        # Use short-lived db session for database operations
        db = SessionLocal()
        try:
            team = self._get_task_mode_team(db, user.id)
            if not team:
                await self.send_text_reply(
                    message_context, "配置错误: 未配置默认智能体"
                )
                return

            response = await self._create_and_process_cloud_task(
                db=db,
                user=user,
                team=team,
                message_context=message_context,
            )
        finally:
            db.close()

        if response:
            await self.send_text_reply(message_context, response)

    # Mapping from MIME type to file extension for IM channel images
    _MIME_TO_EXT = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
        "image/webp": ".webp",
    }

    def _get_display_text(self, message_context: MessageContext) -> str:
        """Get display text for DB storage, with fallbacks for media-only messages."""
        if message_context.content:
            return message_context.content
        if message_context.files:
            filenames = ", ".join(f["filename"] for f in message_context.files)
            return f"[文件] {filenames}"
        if message_context.images:
            return "[图片]"
        return ""

    def _persist_im_files_as_attachments(
        self,
        db: Session,
        user_id: int,
        subtask_id: int,
        files: List[Dict[str, Any]],
    ) -> List[int]:
        """Persist IM channel files as SubtaskContext attachments.

        Downloads from IM channels (DingTalk, Feishu, etc.) provide files as
        binary data. This method saves them into the subtask_contexts table
        so they are processed (text extraction) and available for the AI.

        Args:
            db: Database session (must be open, caller handles commit)
            user_id: Owner user ID
            subtask_id: User subtask ID to link the files to
            files: List of file dicts with filename and binary_data

        Returns:
            List of attachment metadata dicts for executor (id, original_filename)
        """
        from app.services.context.context_service import ContextService

        context_service = ContextService()
        attachment_metas: List[Dict[str, Any]] = []

        for file_info in files:
            try:
                context, _ = context_service.upload_attachment(
                    db=db,
                    user_id=user_id,
                    filename=file_info["filename"],
                    binary_data=file_info["binary_data"],
                    subtask_id=subtask_id,
                )
                attachment_metas.append(
                    {
                        "id": context.id,
                        "original_filename": file_info["filename"],
                    }
                )
                self.logger.info(
                    "[%sHandler] Persisted IM file as attachment: "
                    "context_id=%d, subtask_id=%d, filename=%s, size=%d bytes",
                    self._channel_type.value,
                    context.id,
                    subtask_id,
                    file_info["filename"],
                    len(file_info["binary_data"]),
                )
            except Exception as e:
                self.logger.error(
                    "[%sHandler] Failed to persist IM file %s: %s",
                    self._channel_type.value,
                    file_info.get("filename", "unknown"),
                    e,
                )
                continue

        return attachment_metas

    def _persist_im_images_as_attachments(
        self,
        db: Session,
        user_id: int,
        subtask_id: int,
        images: List[Dict[str, str]],
    ) -> List[int]:
        """Persist IM channel images as SubtaskContext attachments.

        Downloads from IM channels (DingTalk, Feishu, etc.) provide images as
        base64-encoded data. This method saves them into the subtask_contexts
        table so they can be displayed when viewing the task on PC/Web.

        Args:
            db: Database session (must be open, caller handles commit)
            user_id: Owner user ID
            subtask_id: User subtask ID to link the images to
            images: List of image dicts with mime_type and base64_data

        Returns:
            List of created SubtaskContext IDs
        """
        import base64

        from app.services.context.context_service import ContextService

        context_service = ContextService()
        created_ids: List[int] = []

        for idx, img in enumerate(images):
            try:
                binary_data = base64.b64decode(img["base64_data"])
                mime_type = img.get("mime_type", "image/png")
                ext = self._MIME_TO_EXT.get(mime_type, ".png")
                filename = f"im_image_{idx + 1}{ext}"

                context, _ = context_service.upload_attachment(
                    db=db,
                    user_id=user_id,
                    filename=filename,
                    binary_data=binary_data,
                    subtask_id=subtask_id,
                )
                created_ids.append(context.id)
                self.logger.info(
                    "[%sHandler] Persisted IM image as attachment: "
                    "context_id=%d, subtask_id=%d, size=%d bytes",
                    self._channel_type.value,
                    context.id,
                    subtask_id,
                    len(binary_data),
                )
            except Exception as e:
                self.logger.error(
                    "[%sHandler] Failed to persist IM image %d: %s",
                    self._channel_type.value,
                    idx,
                    e,
                )
                continue

        return created_ids

    @staticmethod
    def _build_vision_content(
        text: str, images: List[Dict[str, str]]
    ) -> list[dict[str, Any]]:
        """Build OpenAI Responses API vision content from text and images.

        Args:
            text: Text content (may be empty for image-only messages)
            images: List of image dicts with mime_type and base64_data

        Returns:
            List of content items in OpenAI Responses API vision format
        """
        content: list[dict[str, Any]] = []
        if text:
            content.append({"type": "input_text", "text": text})
        for img in images:
            data_uri = f"data:{img['mime_type']};base64,{img['base64_data']}"
            content.append({"type": "input_image", "image_url": data_uri})
        return content

    async def _create_and_process_chat(
        self,
        user: User,
        message_context: MessageContext,
    ) -> Optional[str]:
        """Create a chat task and process it through the AI system.

        This method uses a short-lived db session for database operations
        and closes it before waiting for the AI response to avoid
        holding long-lived database transactions during streaming.

        Args:
            user: Wegent user
            message_context: Message context

        Returns:
            Response text for sync mode, or None if streamed successfully
        """
        from app.services.chat.storage.task_manager import (
            TaskCreationParams,
            create_task_and_subtasks,
        )

        message = message_context.content
        conversation_id = message_context.conversation_id

        display_text = self._get_display_text(message_context)

        # Get user's model selection (type not needed for chat mode)
        override_model_name, _ = await self._get_user_model_override(user.id)

        params = TaskCreationParams(
            message=display_text,
            title=(
                f"{self._channel_type.value}: {display_text[:30]}..."
                if len(display_text) > 30
                else f"{self._channel_type.value}: {display_text}"
            ),
            is_group_chat=False,
            task_type="chat",
            model_id=override_model_name,
            force_override_bot_model=override_model_name is not None,
        )

        # Try to reuse existing task
        existing_task_id = None
        auto_new_conversation = False
        if conversation_id:
            existing_task_id, auto_new_conversation = (
                await self._get_conversation_task_id(conversation_id, user.id)
            )

        # Use short-lived db session for database operations only
        db = SessionLocal()
        # Prevent attribute expiration after commit so ORM objects remain usable
        db.expire_on_commit = False
        try:
            team = await self._get_selected_or_default_team(db, user.id)
            if not team:
                return "配置错误: 未配置默认智能体"

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

            # Persist IM channel images as attachments for PC/Web display
            if message_context.images:
                self._persist_im_images_as_attachments(
                    db=db,
                    user_id=user.id,
                    subtask_id=result.user_subtask.id,
                    images=message_context.images,
                )

            # Persist IM channel files as attachments
            if message_context.files:
                self._persist_im_files_as_attachments(
                    db=db,
                    user_id=user.id,
                    subtask_id=result.user_subtask.id,
                    files=message_context.files,
                )

            # Extract needed data from ORM objects before closing session
            task_id = result.task.id
            user_subtask_id = result.user_subtask.id

            # Commit and detach ORM objects before closing session
            # expire_on_commit=False ensures attributes remain accessible
            db.commit()

            # Detach objects from session so they can be used after close
            db.expunge_all()

            # Store detached ORM objects for use after session close
            trigger_data = {
                "task": result.task,
                "assistant_subtask": result.assistant_subtask,
                "team": team,
                "user": user,
                "user_subtask_id": user_subtask_id,
            }
        finally:
            db.close()

        # Create emitters (outside db session)
        sync_emitter = SyncResponseEmitter()
        streaming_emitter = await self.create_streaming_emitter(message_context)

        if streaming_emitter:
            response_emitter = CompositeEmitter(streaming_emitter, sync_emitter)
        else:
            response_emitter = sync_emitter

        # Notify user if auto-starting new conversation due to timeout
        if auto_new_conversation:
            from app.core.config import settings

            timeout_minutes = settings.IM_CHANNEL_CONVERSATION_TIMEOUT_MINUTES
            await self.send_text_reply(
                message_context,
                f"⏰ 距离上次对话已超过 {timeout_minutes} 分钟，已自动开始新对话",
            )

        # Trigger AI response using unified dispatcher
        # ExecutionDispatcher automatically selects communication mode based on shell_type
        from app.services.chat.trigger import trigger_ai_response_unified

        task_room = f"task_{task_id}"

        # Build message for AI: always use plain text here.
        # When images exist, they've been persisted as SubtaskContext attachments
        # above. prepare_contexts_for_chat (called inside trigger_ai_response_unified)
        # will read them from the DB and inject as vision content automatically,
        # following the same path as PC-uploaded image attachments.
        ai_message = (message or "") + IM_CHANNEL_CONTEXT_HINT

        await trigger_ai_response_unified(
            task=trigger_data["task"],
            assistant_subtask=trigger_data["assistant_subtask"],
            team=trigger_data["team"],
            user=trigger_data["user"],
            message=ai_message,
            payload=self._build_chat_payload(params, override_model_name),
            task_room=task_room,
            namespace=None,
            user_subtask_id=trigger_data["user_subtask_id"],
            result_emitter=response_emitter,
        )

        # Wait for AI response (no db session held)
        try:
            response = await asyncio.wait_for(
                sync_emitter.wait_for_response(),
                timeout=600.0,
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
                f"[{self._channel_type.value}Handler] Response timeout for task {task_id}"
            )
            return "Response timeout, please try again later"

    def _build_chat_payload(
        self, params: Any, override_model_name: Optional[str] = None
    ) -> Any:
        """Build a chat payload object for trigger_ai_response.

        Args:
            params: Task creation params
            override_model_name: Optional model name to use (from user selection)
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

        return ChatPayload(
            is_group_chat=params.is_group_chat,
            force_override_bot_model=override_model_name,
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

        display_text = self._get_display_text(message_context)

        # Get model for device mode (uses default Claude if user hasn't selected one)
        override_model_name, override_model_type = (
            await self._get_device_mode_model_override(db, user)
        )

        params = TaskCreationParams(
            message=display_text,
            title=(
                f"{self._channel_type.value}: {display_text[:30]}..."
                if len(display_text) > 30
                else f"{self._channel_type.value}: {display_text}"
            ),
            is_group_chat=False,
            task_type="task",
            force_override_bot_model=override_model_name is not None,
            force_override_bot_model_type=override_model_type,
            model_id=override_model_name,
        )

        existing_task_id = None
        auto_new_conversation = False
        if conversation_id:
            existing_task_id, auto_new_conversation = (
                await self._get_conversation_task_id(conversation_id, user.id)
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

        # Persist IM channel images as attachments for PC/Web display
        if message_context.images:
            self._persist_im_images_as_attachments(
                db=db,
                user_id=user.id,
                subtask_id=result.user_subtask.id,
                images=message_context.images,
            )

        # Persist IM channel files as attachments
        file_attachment_metas: List[Dict[str, Any]] = []
        if message_context.files:
            file_attachment_metas = self._persist_im_files_as_attachments(
                db=db,
                user_id=user.id,
                subtask_id=result.user_subtask.id,
                files=message_context.files,
            )

        if conversation_id:
            await self._set_conversation_task_id(
                conversation_id, user.id, result.task.id
            )

        # Notify user if auto-starting new conversation due to timeout
        if auto_new_conversation:
            from app.core.config import settings

            timeout_minutes = settings.IM_CHANNEL_CONVERSATION_TIMEOUT_MINUTES
            await self.send_text_reply(
                message_context,
                f"⏰ 距离上次对话已超过 {timeout_minutes} 分钟，已自动开始新对话",
            )

        # Send acknowledgment BEFORE routing to device
        # This ensures the "task sent" card appears before the result card
        streaming_emitter = await self.create_streaming_emitter(message_context)
        if streaming_emitter:
            await streaming_emitter.emit_start(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                shell_type="ClaudeCode",
            )
            await streaming_emitter.emit_chunk(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                content=(
                    f"任务已发送到设备 **{device_id[:8]}**\n\n"
                    f"任务 ID: {result.task.id}\n"
                    "状态: 正在执行\n\n"
                    "任务完成后将自动发送结果。"
                ),
                offset=0,
            )
            await streaming_emitter.emit_done(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                offset=0,
            )

        # Build message for device: vision content if images present
        if message_context.images:
            device_message = self._build_vision_content(
                message or "", message_context.images
            )
        else:
            device_message = None  # Let route_task_to_device use subtask.prompt

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
                message=device_message,
                attachments=file_attachment_metas or None,
            )

            # Save callback info
            callback_service = self.get_callback_service()
            if callback_service:
                callback_info = self.create_callback_info(message_context)
                await callback_service.save_callback_info(
                    task_id=result.task.id,
                    callback_info=callback_info,
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
        from app.services.execution import schedule_dispatch

        message = message_context.content
        conversation_id = message_context.conversation_id

        display_text = self._get_display_text(message_context)

        # Get user's model selection
        override_model_name, override_model_type = await self._get_user_model_override(
            user.id
        )

        params = TaskCreationParams(
            message=display_text,
            title=(
                f"{self._channel_type.value}: {display_text[:30]}..."
                if len(display_text) > 30
                else f"{self._channel_type.value}: {display_text}"
            ),
            is_group_chat=False,
            task_type="task",
            force_override_bot_model=override_model_name is not None,
            force_override_bot_model_type=override_model_type,
            model_id=override_model_name,
        )

        existing_task_id = None
        auto_new_conversation = False
        if conversation_id:
            existing_task_id, auto_new_conversation = (
                await self._get_conversation_task_id(conversation_id, user.id)
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

        # Persist IM channel images as attachments for PC/Web display
        if message_context.images:
            self._persist_im_images_as_attachments(
                db=db,
                user_id=user.id,
                subtask_id=result.user_subtask.id,
                images=message_context.images,
            )

        # Persist IM channel files as attachments
        if message_context.files:
            self._persist_im_files_as_attachments(
                db=db,
                user_id=user.id,
                subtask_id=result.user_subtask.id,
                files=message_context.files,
            )

        if conversation_id:
            await self._set_conversation_task_id(
                conversation_id, user.id, result.task.id
            )

        # Notify user if auto-starting new conversation due to timeout
        if auto_new_conversation:
            from app.core.config import settings

            timeout_minutes = settings.IM_CHANNEL_CONVERSATION_TIMEOUT_MINUTES
            await self.send_text_reply(
                message_context,
                f"⏰ 距离上次对话已超过 {timeout_minutes} 分钟，已自动开始新对话",
            )

        schedule_dispatch(result.task.id)

        # Send acknowledgment
        # Send acknowledgment
        streaming_emitter = await self.create_streaming_emitter(message_context)
        if streaming_emitter:
            await streaming_emitter.emit_start(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                shell_type="ClaudeCode",
            )
            await streaming_emitter.emit_chunk(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                content=(
                    "⏳ 任务已提交到云端执行队列\n\n"
                    f"任务 ID: {result.task.id}\n"
                    "状态: 等待执行\n\n"
                    "任务完成后��收到通知。"
                ),
                offset=0,
            )
            await streaming_emitter.emit_done(
                task_id=result.task.id,
                subtask_id=result.assistant_subtask.id,
                offset=0,
            )
        else:
            return (
                f"✅ 任务已提交到云端执行队列\n\n"
                f"任务 ID: {result.task.id}\n"
                "任务完成后将收到通知。"
            )
