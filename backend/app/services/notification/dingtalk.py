# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Dingtalk notification client for sending messages via Dingtalk robot.
"""

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class DingtalkUser:
    """User information from Dingtalk"""

    def __init__(self, employee_id: str, name: str, email: str, email_full: str):
        self.employee_id = employee_id
        self.name = name
        self.email = email
        self.email_full = email_full


class DingtalkClient:
    """
    Dingtalk client for sending robot messages.

    Usage:
        async with DingtalkClient() as client:
            await client.send_markdown(username, "Title", "**Content**")
    """

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._token: str = ""
        self._token_expires: datetime = datetime.now()

    async def __aenter__(self) -> "DingtalkClient":
        self._client = httpx.AsyncClient(timeout=30.0)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _ensure_valid_token(self) -> None:
        """Ensure we have a valid access token, refresh if needed."""
        if datetime.now() >= self._token_expires:
            await self._refresh_token()

    async def _refresh_token(self) -> None:
        """Refresh the Dingtalk access token."""
        if not self._client:
            raise RuntimeError("Client not initialized. Use 'async with' context.")

        url = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
        request_body = {
            "appKey": settings.DINGTALK_APP_KEY,
            "appSECRET": settings.DINGTALK_APP_SECRET,
        }

        try:
            response = await self._client.post(
                url,
                headers={"Content-Type": "application/json"},
                json=request_body,
            )

            # Log response details for debugging
            if not response.is_success:
                error_body = response.text
                logger.error(
                    f"[Dingtalk] Token refresh failed: status={response.status_code}, "
                    f"body={error_body}, appKey={settings.DINGTALK_APP_KEY[:8]}..."
                )
                response.raise_for_status()

            data = response.json()

            self._token = data.get("accessToken", "")
            expire_in = data.get("expireIn", 7200)
            # Refresh 10 minutes before expiration
            self._token_expires = datetime.now() + timedelta(seconds=expire_in - 600)
            logger.info("[Dingtalk] Access token refreshed successfully")
        except Exception as e:
            logger.error(f"[Dingtalk] Failed to refresh token: {e}")
            raise

    async def get_user_by_email(self, email: str) -> Optional[DingtalkUser]:
        """
        Get user information by email.

        Args:
            email: User's email address

        Returns:
            DingtalkUser or None if not found
        """
        if not self._client:
            raise RuntimeError("Client not initialized. Use 'async with' context.")

        try:
            response = await self._client.post(
                settings.DINGTALK_USER_INFO_URL,
                headers={"Content-Type": "application/json"},
                json={"emails": [email]},
            )
            response.raise_for_status()
            users = response.json()

            if not users:
                logger.warning(f"[Dingtalk] User not found for email: {email}")
                return None

            user_data = users[0]
            return DingtalkUser(
                employee_id=user_data.get("EMPLOYEE_ID", ""),
                name=user_data.get("NAME", ""),
                email=user_data.get("EMAIL", ""),
                email_full=user_data.get("EMAIL_FULL", ""),
            )
        except Exception as e:
            logger.error(f"[Dingtalk] Failed to get user info for {email}: {e}")
            return None

    async def send_markdown(self, username: str, title: str, content: str) -> bool:
        """
        Send a markdown message to a user via Dingtalk robot.

        Args:
            username: User's email or username
            title: Message title
            content: Markdown content

        Returns:
            True if sent successfully, False otherwise
        """
        if not self._client:
            raise RuntimeError("Client not initialized. Use 'async with' context.")

        # Get user info
        email = username if "@" in username else f"{username}@staff.weibo.com"
        user = await self.get_user_by_email(email)
        if not user:
            logger.error(
                f"[Dingtalk] Cannot send message: user not found for {username}"
            )
            return False

        # Ensure valid token
        await self._ensure_valid_token()

        url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
        msg_param = {
            "title": title,
            "text": content,
        }

        message_request = {
            "robotCode": settings.DINGTALK_APP_KEY,
            "userIds": [user.employee_id],
            "msgKey": "sampleMarkdown",
            "msgParam": str(msg_param).replace("'", '"'),
        }

        try:
            response = await self._client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": self._token,
                },
                json=message_request,
            )

            if not response.is_success:
                error_text = response.text
                logger.error(
                    f"[Dingtalk] Failed to send message to {username}: "
                    f"{response.status_code} - {error_text}"
                )
                return False

            logger.info(f"[Dingtalk] Message sent successfully to {username}")
            return True
        except Exception as e:
            logger.error(f"[Dingtalk] Failed to send message to {username}: {e}")
            return False

    async def send_text(self, username: str, content: str) -> bool:
        """
        Send a text message to a user via Dingtalk robot.

        Args:
            username: User's email or username
            content: Text content

        Returns:
            True if sent successfully, False otherwise
        """
        if not self._client:
            raise RuntimeError("Client not initialized. Use 'async with' context.")

        # Get user info
        email = username if "@" in username else f"{username}@staff.weibo.com"
        user = await self.get_user_by_email(email)
        if not user:
            logger.error(
                f"[Dingtalk] Cannot send message: user not found for {username}"
            )
            return False

        # Ensure valid token
        await self._ensure_valid_token()

        url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
        msg_param = {"content": content}

        message_request = {
            "robotCode": settings.DINGTALK_APP_KEY,
            "userIds": [user.employee_id],
            "msgKey": "sampleText",
            "msgParam": str(msg_param).replace("'", '"'),
        }

        try:
            response = await self._client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": self._token,
                },
                json=message_request,
            )

            if not response.is_success:
                error_text = response.text
                logger.error(
                    f"[Dingtalk] Failed to send text to {username}: "
                    f"{response.status_code} - {error_text}"
                )
                return False

            logger.info(f"[Dingtalk] Text sent successfully to {username}")
            return True
        except Exception as e:
            logger.error(f"[Dingtalk] Failed to send text to {username}: {e}")
            return False
