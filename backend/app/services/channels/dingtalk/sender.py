# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Robot Message Sender.

This module provides functionality to proactively send messages to users
via DingTalk robot API. Used for subscription notifications and other
push scenarios where there's no incoming message to reply to.

API Reference:
- Single chat batch send: POST /v1.0/robot/oToMessages/batchSend
- AI Card create and deliver: POST /v1.0/card/instances/createAndDeliver
- AI Card streaming update: PUT /v1.0/card/streaming
"""

import json
import logging
import uuid
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class DingTalkRobotSender:
    """Sender for proactively sending DingTalk robot messages.

    This class uses DingTalk's oToMessages/batchSend API to send messages
    to users without requiring an incoming message context.
    """

    BASE_URL = "https://api.dingtalk.com"

    def __init__(self, client_id: str, client_secret: str):
        """Initialize the sender.

        Args:
            client_id: DingTalk robot client ID (AppKey)
            client_secret: DingTalk robot client secret (AppSecret)
        """
        self.client_id = client_id
        self.client_secret = client_secret
        self._access_token: Optional[str] = None

    async def _get_access_token(self) -> str:
        """Get access token for DingTalk API.

        Returns:
            Access token string

        Raises:
            Exception: If token fetch fails
        """
        url = f"{self.BASE_URL}/v1.0/oauth2/accessToken"
        payload = {
            "appKey": self.client_id,
            "appSecret": self.client_secret,
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                url, json=payload, headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            data = response.json()

            if "code" in data:
                error_msg = data.get("message", "Unknown error")
                raise Exception(f"Failed to get access token: {error_msg}")

            access_token = data.get("accessToken")
            if not access_token:
                raise Exception("Missing accessToken in response")

            return access_token

    async def send_text_message(
        self,
        user_ids: List[str],
        content: str,
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send text message to users.

        Args:
            user_ids: List of DingTalk user IDs (staffId or unionId)
            content: Text message content
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict with processQueryKey for tracking
        """
        return await self._send_message(
            user_ids=user_ids,
            msg_key="sampleText",
            msg_param={"content": content},
            robot_code=robot_code,
        )

    async def send_markdown_message(
        self,
        user_ids: List[str],
        title: str,
        text: str,
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send markdown message to users.

        Args:
            user_ids: List of DingTalk user IDs (staffId or unionId)
            title: Message title
            text: Markdown text content
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict with processQueryKey for tracking
        """
        return await self._send_message(
            user_ids=user_ids,
            msg_key="sampleMarkdown",
            msg_param={"title": title, "text": text},
            robot_code=robot_code,
        )

    async def _send_message(
        self,
        user_ids: List[str],
        msg_key: str,
        msg_param: Dict[str, Any],
        robot_code: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send message to users via DingTalk robot API.

        Args:
            user_ids: List of DingTalk user IDs
            msg_key: Message type key (sampleText, sampleMarkdown, etc.)
            msg_param: Message parameters
            robot_code: Robot code (defaults to client_id)

        Returns:
            API response dict
        """
        if not user_ids:
            return {"success": False, "error": "No user IDs provided"}

        try:
            access_token = await self._get_access_token()

            url = f"{self.BASE_URL}/v1.0/robot/oToMessages/batchSend"
            payload = {
                "robotCode": robot_code or self.client_id,
                "userIds": user_ids,
                "msgKey": msg_key,
                "msgParam": json.dumps(
                    msg_param, ensure_ascii=False
                ),  # Properly escape JSON
            }

            logger.info(
                f"[DingTalkSender] Sending {msg_key} message to {len(user_ids)} users"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                data = response.json()

                logger.info(
                    f"[DingTalkSender] Message sent successfully, "
                    f"processQueryKey={data.get('processQueryKey')}"
                )

                return {"success": True, "result": data}

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("code", "HTTP_ERROR")
            error_msg = error_data.get("message", str(e))

            logger.error(
                f"[DingTalkSender] HTTP error sending message: {error_code} - {error_msg}"
            )

            return {
                "success": False,
                "error": f"{error_code}: {error_msg}",
            }

        except Exception as e:
            logger.error(f"[DingTalkSender] Error sending message: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    async def send_ai_card_notification(
        self,
        user_id: str,
        title: str,
        content: str,
        card_template_id: str,
        status: str = "",
        enable_streaming: bool = False,
        open_space_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send AI card notification to user.

        This method creates and delivers an AI card instance to the user's
        private chat with the robot. The card can be sent as a completed
        message or with streaming effect.

        Args:
            user_id: DingTalk user ID (staffId or unionId)
            title: Card title
            content: Card content (markdown supported)
            card_template_id: AI card template ID from DingTalk Open Platform
            status: Optional status text (e.g., "执行完成", "执行失败")
            enable_streaming: If True, simulate streaming effect for better UX
            open_space_id: Optional explicit openSpaceId. Defaults to IM_ROBOT.{user_id}

        Returns:
            API response dict with outTrackId for tracking
        """
        if not user_id:
            return {"success": False, "error": "No user ID provided"}

        try:
            access_token = await self._get_access_token()
            out_track_id = str(uuid.uuid4())
            resolved_open_space_id = open_space_id or f"dtv1.card//IM_ROBOT.{user_id}"

            # Build card data
            card_param_map = {
                "title": title,
                "content": content,
            }
            if status:
                card_param_map["status"] = status

            # Build request body
            url = f"{self.BASE_URL}/v1.0/card/instances/createAndDeliver"

            # Determine if this is a group chat or private chat based on open_space_id
            is_group = resolved_open_space_id and "IM_GROUP" in resolved_open_space_id

            payload: Dict[str, Any] = {
                "outTrackId": out_track_id,
                "cardTemplateId": card_template_id,
                "openSpaceId": resolved_open_space_id,
                "cardData": {
                    "cardParamMap": card_param_map,
                },
            }

            if is_group:
                payload["imGroupOpenSpaceModel"] = {
                    "supportForward": True,
                    "lastMessageI18n": {"ZH_CN": "您收到一条订阅通知"},
                }
                payload["imGroupOpenDeliverModel"] = {
                    "spaceType": "IM_GROUP",
                    "robotCode": self.client_id,
                }
            else:
                payload["imRobotOpenSpaceModel"] = {
                    "supportForward": True,
                    "lastMessageI18n": {"ZH_CN": "您收到一条订阅通知"},
                }
                payload["imRobotOpenDeliverModel"] = {
                    "spaceType": "IM_ROBOT",
                }

            logger.info(
                f"[DingTalkSender] Creating AI card for user {user_id}, "
                f"template={card_template_id}, streaming={enable_streaming}, "
                f"is_group={is_group}, open_space_id={resolved_open_space_id}"
            )
            logger.debug(
                f"[DingTalkSender] Request payload: {json.dumps(payload, ensure_ascii=False)}"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                data = response.json()
                logger.info(
                    f"[DingTalkSender] API response: {json.dumps(data, ensure_ascii=False)}"
                )

                # Check for API error
                if "code" in data and data.get("code") != "0":
                    error_msg = data.get("message", "Unknown error")
                    logger.error(
                        f"[DingTalkSender] AI card creation failed: {error_msg}, response={data}"
                    )
                    return {"success": False, "error": error_msg}

                logger.info(
                    f"[DingTalkSender] AI card created successfully, "
                    f"outTrackId={out_track_id}, is_group={is_group}"
                )

                # If streaming enabled, simulate typing effect
                if enable_streaming:
                    await self._simulate_streaming(
                        out_track_id=out_track_id,
                        user_id=user_id,
                        card_template_id=card_template_id,
                        final_content=content,
                        open_space_id=resolved_open_space_id,
                    )
                else:
                    # For non-streaming, explicitly mark card as finished
                    # to clear any "processing" indicator in the template
                    await self._mark_card_finished(
                        out_track_id=out_track_id,
                        user_id=user_id,
                        card_template_id=card_template_id,
                        content=content,
                        open_space_id=resolved_open_space_id,
                    )

                return {
                    "success": True,
                    "outTrackId": out_track_id,
                    "result": data,
                }

        except httpx.HTTPStatusError as e:
            error_data = {}
            try:
                error_data = e.response.json()
            except Exception:
                pass

            error_code = error_data.get("code", "HTTP_ERROR")
            error_msg = error_data.get("message", str(e))

            logger.error(
                f"[DingTalkSender] HTTP error creating AI card: {error_code} - {error_msg}"
            )

            return {
                "success": False,
                "error": f"{error_code}: {error_msg}",
            }

        except Exception as e:
            logger.error(f"[DingTalkSender] Error creating AI card: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    async def _simulate_streaming(
        self,
        out_track_id: str,
        user_id: str,
        card_template_id: str,
        final_content: str,
        chunk_size: int = 20,
        delay: float = 0.1,
        open_space_id: Optional[str] = None,
    ) -> None:
        """Simulate streaming effect for AI card.

        Updates the card content gradually to create a typing effect.
        This improves UX even for pre-generated content.

        Args:
            out_track_id: Card instance ID
            user_id: DingTalk user ID
            card_template_id: Card template ID
            final_content: Final content to display
            chunk_size: Characters to add per update
            delay: Delay between updates in seconds
        """
        import asyncio

        try:
            access_token = await self._get_access_token()
            resolved_open_space_id = open_space_id or f"dtv1.card//IM_ROBOT.{user_id}"
            url = f"{self.BASE_URL}/v1.0/card/streaming"

            # Build up content gradually
            current_content = ""
            for i in range(0, len(final_content), chunk_size):
                current_content = final_content[: i + chunk_size]

                payload = {
                    "outTrackId": out_track_id,
                    "cardTemplateId": card_template_id,
                    "openSpaceId": resolved_open_space_id,
                    "key": "content",
                    "content": current_content,
                    "isFull": True,
                    "guid": str(uuid.uuid4()),
                }

                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.put(
                        url,
                        json=payload,
                        headers={
                            "x-acs-dingtalk-access-token": access_token,
                            "Content-Type": "application/json",
                        },
                    )

                await asyncio.sleep(delay)

            # Final update with complete content and finalize flag
            # isFinalize=true marks this as the final frame, stopping typing animation
            payload = {
                "outTrackId": out_track_id,
                "cardTemplateId": card_template_id,
                "openSpaceId": resolved_open_space_id,
                "key": "content",
                "content": final_content,
                "isFull": True,
                "guid": str(uuid.uuid4()),
                "isFinalize": True,  # Mark as final frame to stop typing animation
            }

            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.put(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )

            logger.info(
                f"[DingTalkSender] Streaming simulation completed for {out_track_id}"
            )

        except Exception as e:
            # Don't fail the whole operation if streaming fails
            logger.warning(f"[DingTalkSender] Streaming simulation failed: {e}")

    async def _mark_card_finished(
        self,
        out_track_id: str,
        user_id: str,
        card_template_id: str,
        content: str,
        open_space_id: Optional[str] = None,
    ) -> None:
        """Mark AI card as finished to clear processing indicator.

        This method updates the card with finished=True to signal
        that the card content is complete and any "processing" status
        indicator should be removed.

        Args:
            out_track_id: Card instance ID
            user_id: DingTalk user ID
            card_template_id: Card template ID
            content: Final card content
        """
        try:
            resolved_open_space_id = open_space_id or f"dtv1.card//IM_ROBOT.{user_id}"
            access_token = await self._get_access_token()
            url = f"{self.BASE_URL}/v1.0/card/streaming"

            # Update card with finished flag to clear "processing" indicator
            # isFinalize=true marks this as the final frame, stopping typing animation
            payload = {
                "outTrackId": out_track_id,
                "cardTemplateId": card_template_id,
                "openSpaceId": resolved_open_space_id,
                "key": "content",
                "content": content,
                "isFull": True,
                "guid": str(uuid.uuid4()),
                "isFinalize": True,  # Mark as final frame to stop typing animation
            }

            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.put(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )

            logger.info(f"[DingTalkSender] Card marked as finished: {out_track_id}")

        except Exception as e:
            # Don't fail the whole operation if marking fails
            logger.warning(f"[DingTalkSender] Failed to mark card as finished: {e}")

    async def update_ai_card(
        self,
        out_track_id: str,
        user_id: str,
        card_template_id: str,
        content: Optional[str] = None,
        status: Optional[str] = None,
        finished: bool = False,
    ) -> Dict[str, Any]:
        """Update AI card content.

        Args:
            out_track_id: Card instance ID from createAndDeliver
            user_id: DingTalk user ID
            card_template_id: Card template ID
            content: New content (if None, keep existing)
            status: New status text (if None, keep existing)
            finished: Whether to mark the card as finished

        Returns:
            API response dict
        """
        try:
            access_token = await self._get_access_token()
            url = f"{self.BASE_URL}/v1.0/card/streaming"

            # Build update data
            card_param_map: Dict[str, str] = {}
            if content is not None:
                card_param_map["content"] = content
            if status is not None:
                card_param_map["status"] = status

            if not card_param_map:
                return {"success": True, "message": "No changes to apply"}

            payload: Dict[str, Any] = {
                "outTrackId": out_track_id,
                "cardTemplateId": card_template_id,
                "openSpaceId": f"dtv1.card//IM_ROBOT.{user_id}",
                "cardData": {
                    "cardParamMap": card_param_map,
                },
                "guid": str(uuid.uuid4()),
            }

            if finished:
                payload["finished"] = True

            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.put(
                    url,
                    json=payload,
                    headers={
                        "x-acs-dingtalk-access-token": access_token,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                data = response.json()

                return {"success": True, "result": data}

        except Exception as e:
            logger.error(f"[DingTalkSender] Error updating AI card: {e}")
            return {"success": False, "error": str(e)}


class AICardSession:
    """Session for managing AI card lifecycle with streaming updates.

    This class provides a convenient way to create an AI card and
    update it incrementally, similar to the Stream mode emitter.

    Example:
        session = await AICardSession.create(
            sender=sender,
            user_id="user123",
            title="AI Response",
            card_template_id="xxx",
        )
        await session.append("Hello")
        await session.append(" world!")
        await session.finish()
    """

    def __init__(
        self,
        sender: DingTalkRobotSender,
        out_track_id: str,
        user_id: str,
        card_template_id: str,
    ):
        self._sender = sender
        self._out_track_id = out_track_id
        self._user_id = user_id
        self._card_template_id = card_template_id
        self._content = ""
        self._finished = False

    @classmethod
    async def create(
        cls,
        sender: DingTalkRobotSender,
        user_id: str,
        title: str,
        card_template_id: str,
        initial_content: str = "",
        status: str = "思考中...",
    ) -> Optional["AICardSession"]:
        """Create a new AI card session.

        Args:
            sender: DingTalkRobotSender instance
            user_id: DingTalk user ID
            title: Card title
            card_template_id: Card template ID
            initial_content: Initial content (optional)
            status: Initial status text

        Returns:
            AICardSession instance or None if creation failed
        """
        result = await sender.send_ai_card_notification(
            user_id=user_id,
            title=title,
            content=initial_content,
            card_template_id=card_template_id,
            status=status,
            enable_streaming=False,
        )

        if not result.get("success"):
            logger.error(
                f"[AICardSession] Failed to create session: {result.get('error')}"
            )
            return None

        return cls(
            sender=sender,
            out_track_id=result["outTrackId"],
            user_id=user_id,
            card_template_id=card_template_id,
        )

    async def append(self, text: str) -> bool:
        """Append text to the card content.

        Args:
            text: Text to append

        Returns:
            True if update succeeded
        """
        if self._finished:
            logger.warning("[AICardSession] Cannot append to finished card")
            return False

        self._content += text
        result = await self._sender.update_ai_card(
            out_track_id=self._out_track_id,
            user_id=self._user_id,
            card_template_id=self._card_template_id,
            content=self._content,
        )
        return result.get("success", False)

    async def set_content(self, content: str) -> bool:
        """Replace the entire card content.

        Args:
            content: New content

        Returns:
            True if update succeeded
        """
        if self._finished:
            logger.warning("[AICardSession] Cannot update finished card")
            return False

        self._content = content
        result = await self._sender.update_ai_card(
            out_track_id=self._out_track_id,
            user_id=self._user_id,
            card_template_id=self._card_template_id,
            content=self._content,
        )
        return result.get("success", False)

    async def update_status(self, status: str) -> bool:
        """Update the card status.

        Args:
            status: New status text

        Returns:
            True if update succeeded
        """
        if self._finished:
            logger.warning("[AICardSession] Cannot update finished card")
            return False

        result = await self._sender.update_ai_card(
            out_track_id=self._out_track_id,
            user_id=self._user_id,
            card_template_id=self._card_template_id,
            status=status,
        )
        return result.get("success", False)

    async def finish(self, final_content: Optional[str] = None) -> bool:
        """Mark the card as finished.

        Args:
            final_content: Optional final content to set

        Returns:
            True if finish succeeded
        """
        if self._finished:
            return True

        if final_content is not None:
            self._content = final_content

        result = await self._sender.update_ai_card(
            out_track_id=self._out_track_id,
            user_id=self._user_id,
            card_template_id=self._card_template_id,
            content=self._content,
            status="",
            finished=True,
        )

        if result.get("success"):
            self._finished = True

        return result.get("success", False)

    @property
    def out_track_id(self) -> str:
        """Get the card instance ID."""
        return self._out_track_id

    @property
    def content(self) -> str:
        """Get current content."""
        return self._content

    @property
    def is_finished(self) -> bool:
        """Check if card is finished."""
        return self._finished
