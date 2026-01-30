# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Attachment UI link tool.

Generates markdown for attachment:// links after validating access.
"""

import json
import logging
import os
from typing import Optional

import httpx
from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_API_BASE_URL = "http://backend:8000"
DEFAULT_ALT_TEXT = "Attachment"


class UiAttachmentLinkInput(BaseModel):
    """Input schema for ui_attachment_link tool."""

    attachment_id: int = Field(..., description="Attachment ID")
    alt_text: Optional[str] = Field(
        default=None,
        description="Alt text used in the markdown image link",
    )


class UiAttachmentLinkTool(BaseTool):
    """Tool for generating attachment:// UI links with validation."""

    name: str = "ui_attachment_link"
    display_name: str = "生成附件链接"
    description: str = (
        "Generate a UI-ready markdown image link for an attachment ID. "
        "The tool validates that the attachment exists and is accessible."
    )

    args_schema: type[BaseModel] = UiAttachmentLinkInput

    # Context data
    task_id: int
    user_id: int
    user_name: str
    auth_token: str = ""
    api_base_url: str = ""

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True

    def _run(
        self,
        attachment_id: int,
        alt_text: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("UiAttachmentLinkTool only supports async execution")

    async def _arun(
        self,
        attachment_id: int,
        alt_text: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Validate attachment and return markdown link.

        Args:
            attachment_id: Attachment ID
            alt_text: Alt text for markdown image link
            run_manager: Callback manager

        Returns:
            JSON string with markdown result
        """
        logger.info(
            f"[UiAttachmentLinkTool] Validating attachment {attachment_id}, "
            f"task_id={self.task_id}, user_id={self.user_id}, user_name={self.user_name}"
        )

        if attachment_id <= 0:
            return json.dumps(
                {"success": False, "error": "attachment_id must be positive"}
            )

        auth_token = self.auth_token
        if not auth_token:
            return json.dumps(
                {"success": False, "error": "No authentication token available"}
            )

        api_base_url = self.api_base_url or os.getenv(
            "BACKEND_API_URL", DEFAULT_API_BASE_URL
        )
        api_base_url = api_base_url.rstrip("/")
        request_url = f"{api_base_url}/api/attachments/{attachment_id}"

        headers = {"Authorization": f"Bearer {auth_token}"}

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(request_url, headers=headers)
        except httpx.RequestError as exc:
            logger.error(
                "[UiAttachmentLinkTool] Request error validating attachment %s: %s",
                attachment_id,
                str(exc),
            )
            return json.dumps(
                {"success": False, "error": "Failed to reach attachment service"}
            )

        if response.status_code != 200:
            logger.warning(
                "[UiAttachmentLinkTool] Attachment validation failed: %s status=%s",
                attachment_id,
                response.status_code,
            )
            return json.dumps(
                {
                    "success": False,
                    "error": "Attachment not found or access denied",
                    "status_code": response.status_code,
                }
            )

        payload = response.json()
        filename = payload.get("filename", "") if isinstance(payload, dict) else ""
        mime_type = payload.get("mime_type", "") if isinstance(payload, dict) else ""

        effective_alt = (alt_text or DEFAULT_ALT_TEXT).strip() or DEFAULT_ALT_TEXT
        markdown = f"![{effective_alt}](attachment://{attachment_id})"

        return json.dumps(
            {
                "success": True,
                "attachment_id": attachment_id,
                "markdown": markdown,
                "filename": filename,
                "mime_type": mime_type,
            }
        )
