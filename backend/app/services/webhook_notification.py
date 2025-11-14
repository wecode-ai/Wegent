# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
import httpx
from typing import Dict, Any, Optional
from datetime import datetime
from pydantic import BaseModel
from app.core.config import settings

logger = logging.getLogger(__name__)

class TaskNotification(BaseModel):
    """Task notification data model"""
    task_id: int
    task_start_time: str
    task_end_time: str
    task_title: str
    task_url: str
    status: str
    error_message: Optional[str] = None

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

    def _build_notification_payload(self, notification: TaskNotification) -> Dict[str, Any]:
        """Build webhook notification payload"""
        display_title = notification.task_title[:10] + "..." if len(notification.task_title) > 10 else notification.task_title

        status_text = notification.status
        if notification.error_message:
            status_text += f" - {notification.error_message}"

        # Build notification text
        notification_text = (
            f"#### Task Notification\n\n"
            f"**Task ID**: {notification.task_id}\n\n"
            f"**Start Time**: {notification.task_start_time}\n\n"
            f"**End Time**: {notification.task_end_time}\n\n"
            f"**Description**: {display_title}\n\n"
            f"**Status**: {status_text}\n\n"
            f"[View Details]({notification.task_url})"
        )

        markdown_content = {
            "title": "Wegent Task Notification",
            "text": notification_text
        }

        return markdown_content

    async def send_notification(self, notification: TaskNotification) -> bool:
        """Send webhook notification"""
        if not self.enabled or not self.endpoint_url:
            logger.info("Webhook notification is disabled or endpoint not configured")
            return False

        try:
            payload = self._build_notification_payload(notification)
            headers = {**self.headers, **self._get_auth_headers()}

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if self.http_method == "POST":
                    response = await client.post(
                        self.endpoint_url,
                        json=payload,
                        headers=headers
                    )
                elif self.http_method == "PUT":
                    response = await client.put(
                        self.endpoint_url,
                        json=payload,
                        headers=headers
                    )
                else:
                    logger.error(f"Unsupported HTTP method: {self.http_method}")
                    return False

                response.raise_for_status()
                logger.info(f"Webhook notification sent successfully for task {notification.task_id}")
                return True

        except httpx.HTTPError as e:
            logger.error(f"HTTP error sending webhook notification: {str(e)}")
            return False
        except Exception as e:
            logger.error(f"Error sending webhook notification: {str(e)}")
            return False

    def send_notification_sync(self, notification: TaskNotification) -> bool:
        """Send webhook notification synchronously"""
        if not self.enabled or not self.endpoint_url:
            logger.info("Webhook notification is disabled or endpoint not configured")
            return False

        try:
            import requests

            payload = self._build_notification_payload(notification)
            headers = {**self.headers, **self._get_auth_headers()}

            if self.http_method == "POST":
                response = requests.post(
                    self.endpoint_url,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout
                )
            elif self.http_method == "PUT":
                response = requests.put(
                    self.endpoint_url,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout
                )
            else:
                logger.error(f"Unsupported HTTP method: {self.http_method}")
                return False

            response.raise_for_status()
            logger.info(f"Webhook notification sent successfully for task {notification.task_id}")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"HTTP error sending webhook notification: {str(e)}")
            # Log response body if available for debugging
            if hasattr(e, 'response') and e.response is not None:
                try:
                    logger.error(f"Response body: {e.response.text}")
                except:
                    pass
            return False
        except Exception as e:
            logger.error(f"Error sending webhook notification: {str(e)}")
            return False

# Global webhook notification service instance
webhook_notification_service = WebhookNotificationService()