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
import base64
import json
import logging
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage, ChatbotMessage
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.payload_codec import run_payload_codec
from app.db.session import SessionLocal
from app.models.user import User
from app.services.channels.callback import BaseChannelCallbackService, ChannelType
from app.services.channels.dingtalk.callback import (
    DingTalkCallbackInfo,
    dingtalk_callback_service,
)
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from app.services.channels.dingtalk.sdk_executor import (
    DingTalkSDKTimeoutError,
    run_dingtalk_sdk_operation,
)
from app.services.channels.dingtalk.user_mapping import MappedUserInfo
from app.services.channels.dingtalk.user_resolver import DingTalkUserResolver
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.emitters import ResultEmitter
from app.services.subscription.notification_service import (
    subscription_notification_service,
)

if TYPE_CHECKING:
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)

# Message deduplication settings
# DingTalk may retry sending messages if ACK is not received in time
DINGTALK_MSG_DEDUP_PREFIX = "dingtalk:msg_dedup:"
DINGTALK_MSG_DEDUP_TTL = 300  # 5 minutes - enough to cover retry window
DINGTALK_REPLY_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class _DingTalkBindingInput:
    user_mapping_mode: str
    user_mapping_config: Optional[dict[str, Any]]
    channel_id: int
    sender_id: str
    sender_staff_id: Optional[str]
    sender_nick: Optional[str]
    conversation_type: str
    conversation_id: str
    group_name: Optional[str]


@dataclass(frozen=True)
class _DingTalkBindingResult:
    user_id: Optional[int]
    binding_result: Optional[dict[str, Any]]


def _update_dingtalk_binding_sync(
    db: Session,
    user_id: int,
    binding_input: _DingTalkBindingInput,
) -> dict[str, Any]:
    subscription_notification_service.update_user_im_binding(
        db=db,
        user_id=user_id,
        channel_id=binding_input.channel_id,
        channel_type="dingtalk",
        sender_id=binding_input.sender_id,
        sender_staff_id=binding_input.sender_staff_id,
        conversation_id=binding_input.conversation_id,
    )
    return subscription_notification_service.handle_dingtalk_binding_from_message(
        db=db,
        user_id=user_id,
        channel_id=binding_input.channel_id,
        conversation_type=binding_input.conversation_type,
        conversation_id=binding_input.conversation_id,
        sender_id=binding_input.sender_id,
        sender_staff_id=binding_input.sender_staff_id,
        group_name=binding_input.group_name,
    )


def _encode_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("utf-8")


def _parse_json_object(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _resolve_selected_user_and_bind_sync(
    binding_input: _DingTalkBindingInput,
) -> _DingTalkBindingResult:
    target_user_id = (binding_input.user_mapping_config or {}).get("target_user_id")
    if not target_user_id:
        return _DingTalkBindingResult(user_id=None, binding_result=None)

    db = SessionLocal()
    try:
        user = (
            db.query(User)
            .filter(User.id == target_user_id, User.is_active == True)
            .first()
        )
        if not user:
            return _DingTalkBindingResult(user_id=None, binding_result=None)
        user_id = int(user.id)
        binding_result = _update_dingtalk_binding_sync(db, user_id, binding_input)
        return _DingTalkBindingResult(
            user_id=user_id,
            binding_result=binding_result,
        )
    finally:
        db.close()


def _resolve_mapped_user_and_bind_sync(
    binding_input: _DingTalkBindingInput,
    mapped_info: Optional[MappedUserInfo],
) -> _DingTalkBindingResult:
    db = SessionLocal()
    try:
        resolver = DingTalkUserResolver(
            db,
            user_mapping_mode=binding_input.user_mapping_mode,
            user_mapping_config=binding_input.user_mapping_config,
        )
        user = resolver.resolve_user_from_mapping(
            sender_id=binding_input.sender_id,
            sender_staff_id=binding_input.sender_staff_id,
            mapped_info=mapped_info,
            check_selected_user=False,
        )
        if not user:
            return _DingTalkBindingResult(user_id=None, binding_result=None)
        user_id = int(user.id)
        binding_result = _update_dingtalk_binding_sync(db, user_id, binding_input)
        return _DingTalkBindingResult(
            user_id=user_id,
            binding_result=binding_result,
        )
    finally:
        db.close()


def _resolve_selected_dingtalk_user_id_sync(
    target_user_id: Optional[int],
) -> Optional[int]:
    if not target_user_id:
        return None
    db = SessionLocal()
    try:
        user = (
            db.query(User)
            .filter(User.id == target_user_id, User.is_active == True)
            .first()
        )
        return int(user.id) if user else None
    finally:
        db.close()


def _resolve_mapped_dingtalk_user_id_sync(
    mapping_mode: str,
    mapping_config: Optional[dict[str, Any]],
    sender_id: str,
    sender_staff_id: Optional[str],
    mapped_info: Optional[MappedUserInfo],
) -> Optional[int]:
    db = SessionLocal()
    try:
        resolver = DingTalkUserResolver(
            db,
            user_mapping_mode=mapping_mode,
            user_mapping_config=mapping_config,
        )
        user = resolver.resolve_user_from_mapping(
            sender_id=sender_id,
            sender_staff_id=sender_staff_id,
            mapped_info=mapped_info,
            check_selected_user=False,
        )
        return int(user.id) if user else None
    finally:
        db.close()


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
        self._reply_operation_lock = threading.Lock()
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

    async def resolve_user_id(self, message_context: MessageContext) -> Optional[int]:
        """Resolve external identity first, then use a fresh worker session."""

        mapping_config = await self.get_user_mapping_config_nonblocking()
        if mapping_config.mode == "select_user":
            target_user_id = (mapping_config.config or {}).get("target_user_id")
            selected_user_id = await run_sync_in_executor(
                _resolve_selected_dingtalk_user_id_sync,
                target_user_id,
            )
            if selected_user_id is not None:
                return selected_user_id

        sender_staff_id = message_context.extra_data.get("sender_staff_id")
        mapped_info = await DingTalkUserResolver.map_external_user(
            sender_id=message_context.sender_id,
            sender_nick=message_context.sender_name,
            sender_staff_id=sender_staff_id,
        )
        return await run_sync_in_executor(
            _resolve_mapped_dingtalk_user_id_sync,
            mapping_config.mode,
            mapping_config.config,
            message_context.sender_id,
            sender_staff_id,
            mapped_info,
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
                await run_dingtalk_sdk_operation(
                    self._reply_operation_lock,
                    self._chatbot_handler.reply_text,
                    text,
                    incoming_message,
                    timeout_seconds=DINGTALK_REPLY_TIMEOUT_SECONDS,
                )
                return True
            else:
                self.logger.warning(
                    "[DingTalkHandler] No chatbot_handler set for reply"
                )
                return False
        except DingTalkSDKTimeoutError:
            self.logger.error(
                "[DingTalkHandler] reply_text timed out after %.1fs; "
                "the synchronous SDK call continues under the reply lock",
                DINGTALK_REPLY_TIMEOUT_SECONDS,
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

        return StreamingResponseEmitter(
            dingtalk_client=self._dingtalk_client,
            incoming_message=incoming_message,
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
        self._attachment_operation_lock = threading.Lock()

        # Handle deprecated default_team_id parameter
        if get_default_team_id is None and default_team_id is not None:
            get_default_team_id = lambda tid=default_team_id: tid

        # Create the internal channel handler that does the actual work
        self._channel_handler = DingTalkChannelHandler(
            channel_id=self._channel_id,
            dingtalk_client=dingtalk_client,
            use_ai_card=use_ai_card,
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
        images: list[dict[str, str]] = []
        for download_code in download_codes:
            try:
                content, content_type = await run_dingtalk_sdk_operation(
                    self._attachment_operation_lock,
                    self._download_dingtalk_resource,
                    download_code,
                    30,
                    timeout_seconds=35,
                )
                # Strip parameters like charset
                mime_type = content_type.split(";")[0].strip()
                if not mime_type.startswith("image/"):
                    mime_type = "image/png"

                base64_data = await run_payload_codec(
                    _encode_base64,
                    content,
                    payload_hint=content,
                )
                images.append({"mime_type": mime_type, "base64_data": base64_data})
                self.logger.info(
                    "[DingTalkHandler] Downloaded image: mime=%s, size=%d bytes",
                    mime_type,
                    len(content),
                )
            except DingTalkSDKTimeoutError:
                self.logger.error(
                    "[DingTalkHandler] Image download timed out for code: %s",
                    download_code[:20],
                )
            except Exception as e:
                self.logger.error("[DingTalkHandler] Failed to download image: %s", e)
                continue
        return images

    def _download_dingtalk_resource(
        self,
        download_code: str,
        request_timeout: int,
    ) -> tuple[bytes, str]:
        """Fetch one DingTalk attachment inside the dedicated SDK worker."""

        import requests

        download_url = self.get_image_download_url(download_code)
        if not download_url:
            raise ValueError("DingTalk did not return an attachment download URL")
        response = requests.get(download_url, timeout=request_timeout)
        response.raise_for_status()
        return (
            response.content,
            response.headers.get("Content-Type", "application/octet-stream"),
        )

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
        # File metadata is in extensions["content"], may be dict or JSON string
        file_content = message.extensions.get("content", {})
        if isinstance(file_content, str):
            try:
                file_content = await run_payload_codec(
                    _parse_json_object,
                    file_content,
                    payload_hint=file_content,
                )
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
            content, _ = await run_dingtalk_sdk_operation(
                self._attachment_operation_lock,
                self._download_dingtalk_resource,
                download_code,
                60,
                timeout_seconds=65,
            )

            self.logger.info(
                "[DingTalkHandler] Downloaded file: name=%s, size=%d bytes",
                file_name,
                len(content),
            )
            return [
                {
                    "filename": file_name,
                    "binary_data": content,
                    "file_size": len(content),
                }
            ]
        except DingTalkSDKTimeoutError:
            self.logger.error(
                "[DingTalkHandler] File download timed out: %s",
                file_name,
            )
            return []
        except Exception as e:
            self.logger.error(
                "[DingTalkHandler] Failed to download file %s: %s",
                file_name,
                e,
            )
            return []

    async def _update_subscription_binding_nonblocking(
        self,
        message_context: MessageContext,
        incoming_message: ChatbotMessage,
    ) -> None:
        """Resolve a scalar user ID and run binding I/O in fresh worker sessions."""

        if not self._channel_id:
            return

        mapping_config = (
            await self._channel_handler.get_user_mapping_config_nonblocking()
        )
        binding_input = _DingTalkBindingInput(
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
            channel_id=self._channel_id,
            sender_id=message_context.sender_id,
            sender_staff_id=message_context.extra_data.get("sender_staff_id"),
            sender_nick=message_context.sender_name,
            conversation_type=message_context.conversation_type,
            conversation_id=message_context.conversation_id,
            group_name=getattr(incoming_message, "conversation_title", None),
        )

        result: Optional[_DingTalkBindingResult] = None
        if mapping_config.mode == "select_user":
            result = await run_sync_in_executor(
                _resolve_selected_user_and_bind_sync,
                binding_input,
            )

        if result is None or result.user_id is None:
            mapped_info = await DingTalkUserResolver.map_external_user(
                sender_id=binding_input.sender_id,
                sender_nick=binding_input.sender_nick,
                sender_staff_id=binding_input.sender_staff_id,
            )
            result = await run_sync_in_executor(
                _resolve_mapped_user_and_bind_sync,
                binding_input,
                mapped_info,
            )

        if result.user_id is None:
            return
        self.logger.info(
            "[DingTalkHandler] Binding check result: user_id=%s, "
            "channel_id=%s, result=%s",
            result.user_id,
            self._channel_id,
            result.binding_result,
        )

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

        try:
            await self._update_subscription_binding_nonblocking(
                message_context,
                incoming_message,
            )
        except Exception:
            self.logger.exception(
                "[DingTalkHandler] Failed during IM binding update/check"
            )

        return await self._channel_handler.handle_message(incoming_message)
