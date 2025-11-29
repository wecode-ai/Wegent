# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
from typing import Any, Dict, Optional

import httpx
import requests
from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)


class Notification(BaseModel):
    """Notification data model"""

    user_name: str
    event: str
    id: str
    start_time: str
    end_time: str
    description: str
    status: str
    detail_url: str


class WebhookNotificationService:
    """Webhook notification service for task events"""

    def __init__(self):
        self.enabled = settings.WEBHOOK_ENABLED
        self.endpoint_url = settings.WEBHOOK_ENDPOINT_URL
        self.http_method = settings.WEBHOOK_HTTP_METHOD.upper()
        self.auth_type = settings.WEBHOOK_AUTH_TYPE
        self.auth_token = settings.WEBHOOK_AUTH_TOKEN
        self.headers = self._parse_headers()
        self.timeout = settings.WEBHOOK_TIMEOUT

    def _parse_headers(self) -> Dict[str, str]:
        """Parse headers from configuration string"""
        headers = {"Content-Type": "application/json"}
        if settings.WEBHOOK_HEADERS:
            try:
                header_dict = json.loads(settings.WEBHOOK_HEADERS)
                headers.update(header_dict)
            except json.JSONDecodeError:
                logger.warning("Failed to parse webhook headers, using default headers")
        return headers

    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authentication headers based on auth type"""
        auth_headers = {}
        if self.auth_type == "bearer" and self.auth_token:
            auth_headers["Authorization"] = f"Bearer {self.auth_token}"
        elif self.auth_type == "basic" and self.auth_token:
            auth_headers["Authorization"] = f"Basic {self.auth_token}"
        elif self.auth_type == "token" and self.auth_token:
            auth_headers["X-Auth-Token"] = self.auth_token
        return auth_headers

    def _replace_username_placeholder(
        self, headers: Dict[str, str], user_name: str
    ) -> Dict[str, str]:
        """Replace username placeholder in headers with actual user name"""
        replaced_headers = {}
        for key, value in headers.items():
            if isinstance(value, str):
                # Replace {username} or {{username}} placeholder with actual user name
                replaced_value = value.replace("$username", user_name)
                replaced_headers[key] = replaced_value
            else:
                replaced_headers[key] = value
        return replaced_headers

    def _build_notification_payload(self, notification: Notification) -> Dict[str, Any]:
        """Build webhook notification payload"""
        # Build payload in the new format
        payload = {
            "event": notification.event,
            "data": {
                "id": notification.id,
                "start_time": notification.start_time,
                "end_time": notification.end_time,
                "description": notification.description,
                "status": notification.status,
                "detail_url": notification.detail_url,
            },
        }

        return payload

    async def send_notification(self, notification: Notification) -> bool:
        """Send webhook notification"""
        if not self.enabled or not self.endpoint_url:
            logger.info("Webhook notification is disabled or endpoint not configured")
            return False

        try:
            payload = self._build_notification_payload(notification)
            headers = {**self.headers, **self._get_auth_headers()}
            # Replace username placeholder in headers
            headers = self._replace_username_placeholder(
                headers, notification.user_name
            )

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if self.http_method == "POST":
                    response = await client.post(
                        self.endpoint_url, json=payload, headers=headers
                    )
                elif self.http_method == "PUT":
                    response = await client.put(
                        self.endpoint_url, json=payload, headers=headers
                    )
                else:
                    logger.error(f"Unsupported HTTP method: {self.http_method}")
                    return False

                response.raise_for_status()
                logger.info(
                    f"Webhook notification sent successfully for {notification.event} id={notification.id}"
                )
                return True

        except httpx.HTTPError as e:
            logger.error(f"HTTP error sending webhook notification: {str(e)}")
            return False
        except Exception as e:
            logger.error(f"Error sending webhook notification: {str(e)}")
            return False

    def send_notification_sync(self, notification: Notification) -> bool:
        """Send webhook notification synchronously"""
        if not self.enabled or not self.endpoint_url:
            logger.info("Webhook notification is disabled or endpoint not configured")
            return False

        try:
            payload = self._build_notification_payload(notification)
            headers = {**self.headers, **self._get_auth_headers()}
            # Replace username placeholder in headers
            headers = self._replace_username_placeholder(
                headers, notification.user_name
            )

            logger.info(f"Sending webhook notification to {self.endpoint_url}")
            logger.info(f"Payload: {payload}")

            if self.http_method == "POST":
                response = requests.post(
                    self.endpoint_url,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout,
                )
            elif self.http_method == "PUT":
                response = requests.put(
                    self.endpoint_url,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout,
                )
            else:
                logger.error(f"Unsupported HTTP method: {self.http_method}")
                return False

            response.raise_for_status()
            logger.info(
                f"Webhook notification sent successfully for {notification.event} id={notification.id}"
            )
            return True

        except httpx.HTTPError as e:
            logger.error(f"HTTP error sending webhook notification: {str(e)}")
            return False
        except Exception as e:
            logger.error(f"Error sending webhook notification: {str(e)}")
            return False


# Global webhook notification service instance
webhook_notification_service = WebhookNotificationService()
