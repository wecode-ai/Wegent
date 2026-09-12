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

Architecture:
- DingTalkChannelHandler: Implements BaseChannelHandler for DingTalk-specific logic
- WegentChatbotHandler: DingTalk SDK handler that delegates to DingTalkChannelHandler
"""

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage, ChatbotMessage
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.callback import BaseChannelCallbackService, ChannelType
from app.services.channels.dingtalk.callback import (
    DingTalkCallbackInfo,
    dingtalk_callback_service,
)
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from app.services.channels.dingtalk.user_resolver import DingTalkUserResolver
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.execution.emitters import ResultEmitter
from app.services.subscription.notification_service import (
    subscription_notification_service,
)
from shared.telemetry.context import request_context
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from dingtalk_stream.stream import DingTalkStreamClient

    from app.services.channels.dingtalk.selection_cards import (
        DingTalkSelectionCardService,
    )

logger = logging.getLogger(__name__)

# Message deduplication settings
# DingTalk may retry sending messages if ACK is not received in time
DINGTALK_MSG_DEDUP_PREFIX = "dingtalk:msg_dedup:"
DINGTALK_MSG_DEDUP_TTL = 300  # 5 minutes - enough to cover retry window


def _reply_to_message_id(callback_data: dict[str, Any]) -> str:
    """Return the stable reference for a quoted DingTalk message."""

    text = callback_data.get("text")
    if not isinstance(text, dict):
        return ""
    replied_message = text.get("repliedMsg")
    if not text.get("isReplyMsg") and not isinstance(replied_message, dict):
        return ""

    candidates = [callback_data.get("originalProcessQueryKey")]
    if isinstance(replied_message, dict):
        candidates.extend(
            [
                replied_message.get("processQueryKey"),
                replied_message.get("msgId"),
            ]
        )
    candidates.append(callback_data.get("originalMsgId"))
    for candidate in candidates:
        if isinstance(candidate, bool) or not isinstance(candidate, (int, str)):
            continue
        normalized = str(candidate).strip()
        if normalized:
            return normalized
    return ""


class DingTalkChannelHandler(BaseChannelHandler[ChatbotMessage, DingTalkCallbackInfo]):
    """DingTalk-specific implementation of BaseChannelHandler.

    This class implements all the abstract methods from BaseChannelHandler
    with DingTalk-specific logic for message parsing, user resolution,
    and response sending.
    """

    def __init__(
        self,
        channel_id: int,
        dingtalk_client: Optional["DingTalkStreamClient"] = None,
        use_ai_card: bool = True,
        conversation_card_template_id: str = "",
        interaction_card_template_id: str = "",
        selection_card_service: Optional["DingTalkSelectionCardService"] = None,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        """Initialize the DingTalk channel handler.

        Args:
            channel_id: The IM channel ID for callback purposes
            dingtalk_client: DingTalk stream client for sending responses
            use_ai_card: Whether to use AI Card for streaming responses
            get_default_team_id: Callback to get current default_team_id dynamically
            get_default_model_name: Callback to get current default_model_name dynamically
            get_user_mapping_config: Callback to get user mapping configuration dynamically
        """
        super().__init__(
            channel_type=ChannelType.DINGTALK,
            channel_id=channel_id,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )
        self._dingtalk_client = dingtalk_client
        self._use_ai_card = use_ai_card
        self._conversation_card_template_id = conversation_card_template_id
        self._interaction_card_template_id = interaction_card_template_id
        self._selection_card_service = selection_card_service
        # Store incoming_message for reply operations
        self._current_incoming_message: Optional[ChatbotMessage] = None

    def set_dingtalk_client(self, client: "DingTalkStreamClient") -> None:
        """Set the DingTalk client (can be set after initialization)."""
        self._dingtalk_client = client

    def parse_message(self, raw_data: Any) -> MessageContext:
        """Parse DingTalk ChatbotMessage into generic MessageContext.

        Args:
            raw_data: ChatbotMessage from DingTalk SDK

        Returns:
            MessageContext with parsed message information
        """
        message: ChatbotMessage = raw_data
        self._current_incoming_message = message

        # Extract text content
        content = ""
        if hasattr(message, "text") and message.text:
            content = message.text.content.strip() if message.text.content else ""

        # For richText messages, also extract text parts
        message_type = getattr(message, "message_type", None)
        if message_type == "richText" and hasattr(message, "get_text_list"):
            text_parts = message.get_text_list() or []
            if text_parts and not content:
                content = " ".join(text_parts).strip()

        # Extract image download codes from picture/richText messages
        image_download_codes: list[str] = []
        if hasattr(message, "get_image_list"):
            image_download_codes = message.get_image_list() or []

        # Extract sender info
        sender_id = getattr(message, "sender_id", "") or ""
        sender_nick = getattr(message, "sender_nick", None)
        sender_staff_id = getattr(message, "sender_staff_id", None)

        # Extract conversation info
        conversation_id = getattr(message, "conversation_id", "") or ""
        conversation_type = getattr(message, "conversation_type", "1")
        is_in_at_list = getattr(message, "is_in_at_list", False)

        # Build extra_data with callback_data if available
        extra_data = {
            "sender_staff_id": sender_staff_id,
            "sender_corp_id": getattr(message, "sender_corp_id", None),
            "chatbot_user_id": getattr(message, "chatbot_user_id", None),
            "at_users": getattr(message, "at_users", []),
        }

        if image_download_codes:
            extra_data["image_download_codes"] = image_download_codes

        # Include callback_data if it was attached to the message
        if hasattr(message, "_wegent_callback_data"):
            callback_data = message._wegent_callback_data
            extra_data["callback_data"] = callback_data
            if isinstance(callback_data, dict):
                message_id = str(callback_data.get("msgId") or "").strip()
                if message_id:
                    extra_data["message_id"] = message_id
                reply_to_message_id = _reply_to_message_id(callback_data)
                if reply_to_message_id:
                    extra_data["reply_to_message_id"] = reply_to_message_id

        # Include pre-downloaded images if they were attached
        images: list[dict[str, str]] = []
        if hasattr(message, "_wegent_images"):
            images = message._wegent_images

        # Include pre-downloaded files if they were attached
        files: list[dict[str, Any]] = []
        if hasattr(message, "_wegent_files"):
            files = message._wegent_files

        return MessageContext(
            content=content,
            sender_id=sender_id,
            sender_name=sender_nick,
            conversation_id=conversation_id,
            conversation_type="group" if conversation_type == "2" else "private",
            is_mention=is_in_at_list,
            raw_message=message,
            extra_data=extra_data,
            proactive_recipient_id=str(sender_staff_id or "").strip() or None,
            images=images,
            files=files,
        )

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> Optional[User]:
        """Resolve DingTalk user to Wegent user.

        Args:
            db: Database session
            message_context: Parsed message context

        Returns:
            Wegent User or None if not found
        """
        mapping_config = self.user_mapping_config
        resolver = DingTalkUserResolver(
            db,
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
        )
        return await resolver.resolve_user(
            sender_id=message_context.sender_id,
            sender_nick=message_context.sender_name,
            sender_staff_id=message_context.extra_data.get("sender_staff_id"),
        )

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        """Send a text reply to DingTalk.

        Args:
            message_context: Original message context
            text: Text to send

        Returns:
            True if sent successfully, False otherwise
        """
        incoming_message = message_context.raw_message
        if not isinstance(incoming_message, ChatbotMessage):
            self.logger.error("[DingTalkHandler] Invalid raw_message type for reply")
            return False

        try:
            # Use the SDK's reply_text method via the parent handler
            # This requires access to the ChatbotHandler's reply mechanism
            if hasattr(self, "_chatbot_handler") and self._chatbot_handler:
                self._chatbot_handler.reply_text(text, incoming_message)
                return True
            else:
                self.logger.warning(
                    "[DingTalkHandler] No chatbot_handler set for reply"
                )
                return False
        except Exception as e:
            self.logger.exception(f"[DingTalkHandler] Failed to send reply: {e}")
            return False

    def create_callback_info(
        self, message_context: MessageContext
    ) -> DingTalkCallbackInfo:
        """Create DingTalk callback info for task completion notification.

        Args:
            message_context: Message context

        Returns:
            DingTalkCallbackInfo instance
        """
        return DingTalkCallbackInfo(
            channel_id=self._channel_id,
            conversation_id=message_context.conversation_id,
            incoming_message_data=message_context.extra_data.get("callback_data"),
            user_id=message_context.extra_data.get("resolved_user_id"),
            conversation_card_template_id=self._conversation_card_template_id,
            interaction_card_template_id=self._interaction_card_template_id,
        )

    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        """Get the DingTalk callback service.

        Returns:
            DingTalkCallbackService instance
        """
        return dingtalk_callback_service

    async def create_streaming_emitter(
        self, message_context: MessageContext
    ) -> Optional[ResultEmitter]:
        """Create a streaming emitter for DingTalk AI Card updates.

        Args:
            message_context: Message context

        Returns:
            StreamingResponseEmitter or None if not supported
        """
        if not self._dingtalk_client or not self._use_ai_card:
            return None

        incoming_message = message_context.raw_message
        if not isinstance(incoming_message, ChatbotMessage):
            return None

        conversation_template_id = (
            self._conversation_card_template_id
            if self._interaction_card_template_id
            else ""
        )
        return StreamingResponseEmitter(
            dingtalk_client=self._dingtalk_client,
            incoming_message=incoming_message,
            conversation_card_template_id=conversation_template_id,
            interaction_card_template_id=self._interaction_card_template_id,
            channel_id=self._channel_id,
            user_id=message_context.extra_data.get("resolved_user_id"),
        )

    async def _resolve_new_task_team(
        self,
        db: Session,
        user_id: int,
    ) -> Optional[Kind]:
        """Use the DingTalk agent selection for newly created Tasks."""

        from app.services.channels.team_selection import resolve_selected_team

        selected = await resolve_selected_team(db, user_id)
        return selected or self._get_task_mode_team(db, user_id)

    async def _after_agent_selection_changed(
        self,
        db: Session,
        im_session: Optional[IMPrivateSession],
    ) -> bool:
        """Detach an existing DingTalk Task without mutating that Task."""

        if (
            im_session is None
            or im_session.mode != IMSessionMode.TASK
            or im_session.active_task_id is None
        ):
            return False

        from app.services.im.session_service import im_session_service

        await im_session_service.clear_active_task(db, session=im_session)
        return True

    async def _get_status_team_info(
        self,
        db: Session,
        user: User,
        im_session: Optional[IMPrivateSession],
    ) -> str:
        """Distinguish the bound Task Team from the next new Task Team."""

        if im_session is None or im_session.mode != IMSessionMode.TASK:
            return await super()._get_status_team_info(db, user, im_session)

        from app.services.channels.team_selection import (
            get_team_display_name,
            resolve_selected_team,
        )
        from app.services.im import task_continuation_service as task_service

        current_label = "未绑定"
        if im_session.active_task_id is not None:
            try:
                task = task_service.validate_personal_wework_task(
                    db,
                    user.id,
                    im_session.active_task_id,
                )
                current_label = get_team_display_name(
                    task_service.get_task_team(db, task)
                )
            except Exception:
                self.logger.warning(
                    "[DingTalkHandler] Failed to resolve active Task Team: "
                    "user_id=%s, task_id=%s",
                    user.id,
                    im_session.active_task_id,
                    exc_info=True,
                )
                current_label = "任务不可用"
        elif im_session.active_runtime_task:
            current_label = "本地运行任务"

        selected = await resolve_selected_team(db, user.id)
        next_team = selected or self._get_task_mode_team(db, user.id)
        next_label = get_team_display_name(next_team)
        if selected is not None:
            next_label += " (用户选择)"
        return (
            f"**当前 Task 智能体**: {current_label}\n"
            f"**下一新任务智能体**: {next_label}"
        )

    async def try_handle_interactive_control(
        self,
        db: Session,
        user: User,
        im_session: Any,
        message_context: MessageContext,
    ) -> bool:
        """Open a DingTalk selection card for no-argument control intents."""

        if self._selection_card_service is None:
            return False
        from app.services.channels.dingtalk.selection_cards import (
            selection_kind_for_message,
        )

        kind = selection_kind_for_message(message_context.content)
        if kind is False:
            return False
        if kind is not None and kind.value == "task" and im_session is None:
            return False
        incoming_message = message_context.raw_message
        if not isinstance(incoming_message, ChatbotMessage):
            return False
        return await self._selection_card_service.open_from_message(
            db=db,
            user=user,
            incoming_message=incoming_message,
            session=im_session,
            kind=kind,
        )

    def set_chatbot_handler(self, handler: "WegentChatbotHandler") -> None:
        """Set reference to the SDK chatbot handler for reply operations."""
        self._chatbot_handler = handler


class WegentChatbotHandler(dingtalk_stream.ChatbotHandler):
    """Handler for DingTalk Stream chatbot messages.

    This handler receives messages from DingTalk via the Stream protocol
    and delegates processing to DingTalkChannelHandler which inherits from
    the generic BaseChannelHandler.

    This design allows:
    1. Compliance with DingTalk SDK's handler interface
    2. Reuse of common channel handling logic from BaseChannelHandler
    """

    def __init__(
        self,
        dingtalk_client: Optional["DingTalkStreamClient"] = None,
        default_team_id: Optional[int] = None,
        use_ai_card: bool = True,
        conversation_card_template_id: str = "",
        interaction_card_template_id: str = "",
        selection_card_service: Optional["DingTalkSelectionCardService"] = None,
        on_message: Optional[Callable[[Dict[str, Any]], asyncio.Future]] = None,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
        channel_id: Optional[int] = None,
    ):
        """Initialize the handler.

        Args:
            dingtalk_client: DingTalk stream client for sending responses.
                            Required for streaming mode.
            default_team_id: Default team ID for this channel (deprecated)
            use_ai_card: Whether to use AI Card for streaming responses
            on_message: Optional callback for message processing.
                        If not provided, uses default Wegent chat processing.
            get_default_team_id: Callback to get current default_team_id dynamically.
            get_default_model_name: Callback to get current default_model_name dynamically.
                                   Used to override bot's model configuration.
            get_user_mapping_config: Callback to get user mapping configuration.
            channel_id: The IM channel ID (Kind.id) for IM binding tracking and callback purposes.
        """
        super(dingtalk_stream.ChatbotHandler, self).__init__()
        self._dingtalk_client = dingtalk_client
        self._use_ai_card = use_ai_card
        self._on_message = on_message
        self._channel_id = channel_id or 0

        # Handle deprecated default_team_id parameter
        if get_default_team_id is None and default_team_id is not None:
            get_default_team_id = lambda tid=default_team_id: tid

        # Create the internal channel handler that does the actual work
        self._channel_handler = DingTalkChannelHandler(
            channel_id=self._channel_id,
            dingtalk_client=dingtalk_client,
            use_ai_card=use_ai_card,
            conversation_card_template_id=conversation_card_template_id,
            interaction_card_template_id=interaction_card_template_id,
            selection_card_service=selection_card_service,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )
        # Set back reference for reply operations
        self._channel_handler.set_chatbot_handler(self)

        self.logger = logging.getLogger(__name__)

    def set_dingtalk_client(self, client: "DingTalkStreamClient") -> None:
        """Set the DingTalk client after initialization."""
        self._dingtalk_client = client
        self._channel_handler.set_dingtalk_client(client)

    @property
    def default_team_id(self) -> Optional[int]:
        """Get the current default team ID."""
        return self._channel_handler.default_team_id

    @property
    def default_model_name(self) -> Optional[str]:
        """Get the current default model name."""
        return self._channel_handler.default_model_name

    async def process(self, callback: CallbackMessage) -> tuple[str, str]:
        """Process incoming DingTalk chatbot message.

        This method is called by the DingTalk Stream SDK when a message
        is received from the chatbot.

        Note: DingTalk may retry sending messages if ACK is not received in time
        (e.g., when debugging with breakpoints). We use Redis-based deduplication
        to prevent processing the same message twice.

        Args:
            callback: Callback message containing the chat data

        Returns:
            Tuple of (status, message) for acknowledgment
        """
        request_id = next(
            (
                value.strip()
                for key, value in callback.headers.extensions.items()
                if key.lower() == "x-request-id"
                and isinstance(value, str)
                and value.isprintable()
                and value.strip()
            ),
            None,
        )
        # Each callback is a request; the long-lived stream may carry a startup ID.
        with request_context(request_id):
            return await self._process_message(callback)

    @trace_async(span_name="dingtalk.process_message", tracer_name=__name__)
    async def _process_message(self, callback: CallbackMessage) -> tuple[str, str]:
        """Handle the callback within its own request context."""
        try:
            # Parse the incoming message
            incoming_message = ChatbotMessage.from_dict(callback.data)

            # Deduplicate messages using msgId
            # DingTalk retries if ACK is not received within timeout
            msg_id = callback.data.get("msgId")
            if msg_id:
                dedup_key = f"{DINGTALK_MSG_DEDUP_PREFIX}{msg_id}"
                # Try to set the key with SETNX (only if not exists)
                is_new = await cache_manager.setnx(
                    dedup_key, "1", expire=DINGTALK_MSG_DEDUP_TTL
                )
                if not is_new:
                    self.logger.warning(
                        "[DingTalkHandler] Duplicate message detected, skipping: msgId=%s",
                        msg_id,
                    )
                    # Return OK to prevent further retries
                    return AckMessage.STATUS_OK, "OK (duplicate)"

            self.logger.info(
                "[DingTalkHandler] Received message: sender=%s, msgId=%s, content_preview=%s",
                getattr(incoming_message, "sender_nick", "unknown"),
                msg_id,
                (
                    incoming_message.text.content[:50]
                    if hasattr(incoming_message, "text")
                    and incoming_message.text
                    and incoming_message.text.content
                    else "empty"
                ),
            )

            # Process through custom callback or delegate to channel handler
            if self._on_message:
                # Build legacy message context for custom callback
                message_context = self._build_legacy_message_context(
                    incoming_message, callback.data
                )
                await self._on_message(message_context)
            else:
                # Store callback_data in extra_data for callback info
                # Delegate to the channel handler
                await self._process_with_channel_handler(
                    incoming_message, callback.data
                )

            return AckMessage.STATUS_OK, "OK"

        except Exception as e:
            self.logger.exception("[DingTalkHandler] Error processing message: %s", e)
            return AckMessage.STATUS_SYSTEM_EXCEPTION, str(e)

    def _build_legacy_message_context(
        self, incoming_message: ChatbotMessage, callback_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Build legacy message context dict for custom on_message callback."""
        content = ""
        if hasattr(incoming_message, "text") and incoming_message.text:
            content = (
                incoming_message.text.content.strip()
                if incoming_message.text.content
                else ""
            )

        return {
            "content": content,
            "sender": {
                "sender_id": getattr(incoming_message, "sender_id", None),
                "sender_nick": getattr(incoming_message, "sender_nick", None),
                "sender_staff_id": getattr(incoming_message, "sender_staff_id", None),
                "sender_corp_id": getattr(incoming_message, "sender_corp_id", None),
            },
            "conversation": {
                "conversation_id": getattr(incoming_message, "conversation_id", None),
                "conversation_type": getattr(
                    incoming_message, "conversation_type", None
                ),
                "conversation_title": getattr(
                    incoming_message, "conversation_title", None
                ),
                "chatbot_user_id": getattr(incoming_message, "chatbot_user_id", None),
                "at_users": getattr(incoming_message, "at_users", []),
                "is_in_at_list": getattr(incoming_message, "is_in_at_list", False),
            },
            "raw_message": incoming_message,
            "callback_data": callback_data,
        }

    async def _download_dingtalk_images(
        self, download_codes: list[str]
    ) -> list[dict[str, str]]:
        """Download images from DingTalk using download codes.

        Args:
            download_codes: List of DingTalk image download codes

        Returns:
            List of image dicts with mime_type and base64_data
        """
        import base64

        import requests

        images: list[dict[str, str]] = []
        for download_code in download_codes:
            try:
                # Use DingTalk SDK to get temporary download URL
                download_url = self.get_image_download_url(download_code)
                if not download_url:
                    self.logger.warning(
                        "[DingTalkHandler] Failed to get download URL for code: %s",
                        download_code[:20],
                    )
                    continue

                # Download the image
                response = requests.get(download_url, timeout=30)
                response.raise_for_status()

                # Determine MIME type from response headers or default to image/png
                content_type = response.headers.get("Content-Type", "image/png")
                # Strip parameters like charset
                mime_type = content_type.split(";")[0].strip()
                if not mime_type.startswith("image/"):
                    mime_type = "image/png"

                base64_data = base64.b64encode(response.content).decode("utf-8")
                images.append({"mime_type": mime_type, "base64_data": base64_data})
                self.logger.info(
                    "[DingTalkHandler] Downloaded image: mime=%s, size=%d bytes",
                    mime_type,
                    len(response.content),
                )
            except Exception as e:
                self.logger.error("[DingTalkHandler] Failed to download image: %s", e)
                continue
        return images

    async def _download_dingtalk_file(
        self, message: ChatbotMessage
    ) -> list[dict[str, Any]]:
        """Download file from DingTalk file-type message.

        For file messages, the SDK stores file metadata in message.extensions["content"].
        The downloadCode can be used with the same messageFiles/download API as images.

        Args:
            message: ChatbotMessage with message_type=="file"

        Returns:
            List of file dicts with filename and binary_data
        """
        import json

        import requests

        # File metadata is in extensions["content"], may be dict or JSON string
        file_content = message.extensions.get("content", {})
        if isinstance(file_content, str):
            try:
                file_content = json.loads(file_content)
            except (json.JSONDecodeError, TypeError):
                self.logger.error(
                    "[DingTalkHandler] Failed to parse file content: %s",
                    str(file_content)[:100],
                )
                return []

        download_code = file_content.get("downloadCode")
        file_name = file_content.get("fileName", "unknown_file")

        if not download_code:
            self.logger.warning("[DingTalkHandler] File message missing downloadCode")
            return []

        try:
            # Reuse the same DingTalk API for file download
            download_url = self.get_image_download_url(download_code)
            if not download_url:
                self.logger.warning(
                    "[DingTalkHandler] Failed to get download URL for file: %s",
                    file_name,
                )
                return []

            response = requests.get(download_url, timeout=60)
            response.raise_for_status()

            self.logger.info(
                "[DingTalkHandler] Downloaded file: name=%s, size=%d bytes",
                file_name,
                len(response.content),
            )
            return [
                {
                    "filename": file_name,
                    "binary_data": response.content,
                    "file_size": len(response.content),
                }
            ]
        except Exception as e:
            self.logger.error(
                "[DingTalkHandler] Failed to download file %s: %s",
                file_name,
                e,
            )
            return []

    async def _process_with_channel_handler(
        self, incoming_message: ChatbotMessage, callback_data: Dict[str, Any]
    ) -> bool:
        """Process message using the channel handler.

        The channel handler provides all the common logic for:
        - User resolution
        - Command handling
        - Chat/Device/Cloud mode routing
        - Task creation and AI triggering

        Args:
            incoming_message: Parsed ChatbotMessage
            callback_data: Raw callback data for serialization

        Returns:
            True if handled successfully
        """
        # Add callback_data to the message for later retrieval
        # We need to store it so create_callback_info can access it
        if not hasattr(incoming_message, "_wegent_callback_data"):
            incoming_message._wegent_callback_data = callback_data

        # Download images from DingTalk before parsing
        # parse_message is called twice (here and in handle_message),
        # so we attach downloaded images to the message object
        image_download_codes = incoming_message.get_image_list() or []
        if image_download_codes:
            images = await self._download_dingtalk_images(image_download_codes)
            if images:
                incoming_message._wegent_images = images

        # Download files from DingTalk for file-type messages
        message_type = getattr(incoming_message, "message_type", None)
        if message_type == "file":
            files = await self._download_dingtalk_file(incoming_message)
            if files:
                incoming_message._wegent_files = files

        # Parse message into MessageContext, including callback_data in extra_data
        message_context = self._channel_handler.parse_message(incoming_message)
        message_context.extra_data["callback_data"] = callback_data

        # Override send_text_reply to use our reply_text method
        original_send_reply = self._channel_handler.send_text_reply

        async def patched_send_reply(ctx: MessageContext, text: str) -> bool:
            self.reply_text(text, ctx.raw_message)
            return True

        self._channel_handler.send_text_reply = patched_send_reply

        try:
            # Get user and update IM binding for subscription notifications
            db = SessionLocal()
            try:
                user = await self._channel_handler.resolve_user(db, message_context)
                if user and self._channel_id:
                    try:
                        self.logger.info(
                            "[DingTalkHandler] Updating IM binding from message: user_id=%s, channel_id=%s, conversation_type=%s, conversation_id=%s, sender_id=%s",
                            user.id,
                            self._channel_id,
                            message_context.conversation_type,
                            message_context.conversation_id,
                            message_context.sender_id,
                        )
                        subscription_notification_service.update_user_im_binding(
                            db=db,
                            user_id=user.id,
                            channel_id=self._channel_id,
                            channel_type="dingtalk",
                            sender_id=message_context.sender_id,
                            sender_staff_id=message_context.extra_data.get(
                                "sender_staff_id"
                            ),
                            conversation_id=message_context.conversation_id,
                        )
                        # Extract group name from incoming message for group binding
                        group_name = getattr(
                            incoming_message, "conversation_title", None
                        )

                        binding_result = subscription_notification_service.handle_dingtalk_binding_from_message(
                            db=db,
                            user_id=user.id,
                            channel_id=self._channel_id,
                            conversation_type=message_context.conversation_type,
                            conversation_id=message_context.conversation_id,
                            sender_id=message_context.sender_id,
                            sender_staff_id=message_context.extra_data.get(
                                "sender_staff_id"
                            ),
                            group_name=group_name,
                        )
                        self.logger.info(
                            "[DingTalkHandler] Binding check result: user_id=%s, channel_id=%s, result=%s",
                            user.id,
                            self._channel_id,
                            binding_result,
                        )
                    except Exception:
                        self.logger.exception(
                            "[DingTalkHandler] Failed during IM binding update/check"
                        )
            finally:
                db.close()

            return await self._channel_handler.handle_message(incoming_message)
        finally:
            # Restore original method
            self._channel_handler.send_text_reply = original_send_reply
