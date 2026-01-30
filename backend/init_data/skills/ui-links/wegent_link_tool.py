# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent scheme link tool.

Generates markdown links for wegent:// scheme URLs.
"""

import json
import logging
from typing import Optional

from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_LABEL = "Open"


class UiWegentLinkInput(BaseModel):
    """Input schema for ui_wegent_link tool."""

    scheme_url: str = Field(
        ...,
        description="Wegent scheme URL, e.g. wegent://open/chat",
    )
    label: Optional[str] = Field(
        default=None,
        description="Link label text",
    )


class UiWegentLinkTool(BaseTool):
    """Tool for generating wegent:// markdown links."""

    name: str = "ui_wegent_link"
    display_name: str = "生成 Wegent 链接"
    description: str = "Generate a UI-ready markdown link for a wegent:// scheme URL."

    args_schema: type[BaseModel] = UiWegentLinkInput

    # Context data
    task_id: int
    user_id: int
    user_name: str

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True

    def _run(
        self,
        scheme_url: str,
        label: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("UiWegentLinkTool only supports async execution")

    async def _arun(
        self,
        scheme_url: str,
        label: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Return markdown link for a Wegent scheme URL.

        Args:
            scheme_url: Wegent scheme URL
            label: Link label
            run_manager: Callback manager

        Returns:
            JSON string with markdown result
        """
        logger.info(
            f"[UiWegentLinkTool] Generating link for {scheme_url}, "
            f"task_id={self.task_id}, user_id={self.user_id}, user_name={self.user_name}"
        )

        normalized_url = (scheme_url or "").strip()
        if not normalized_url:
            return json.dumps({"success": False, "error": "scheme_url is required"})

        effective_label = (label or DEFAULT_LABEL).strip() or DEFAULT_LABEL
        markdown = f"[{effective_label}]({normalized_url})"

        return json.dumps(
            {"success": True, "scheme_url": normalized_url, "markdown": markdown}
        )
