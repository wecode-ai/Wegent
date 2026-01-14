# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Expose Service tool for publishing/exposing service information.

This tool allows AI to publish or expose service information such as
application name, host address, preview URL, and database connection strings.
The data is stored in the Task's app field in the backend.
"""

import json
import logging
from typing import Optional

import httpx
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


class ExposeServiceInput(BaseModel):
    """Input schema for expose service tool."""

    name: Optional[str] = Field(
        None,
        description="Application name",
    )
    host: Optional[str] = Field(
        None,
        description="Host address (e.g., 'localhost', '192.168.1.100')",
    )
    previewUrl: Optional[str] = Field(
        None,
        description="Application preview URL (e.g., 'https://example.com')",
    )
    mysql: Optional[str] = Field(
        None,
        description="MySQL connection string in format: mysql://user:pass@host:port/database",
    )


class ExposeServiceTool(BaseTool):
    """Expose Service tool for publishing service information.

    This tool allows AI agents to expose/publish service information when:
    - User requests to deploy/publish a web application or static website
    - User needs to set or share a host address
    - User creates a database and needs to share the MySQL connection info

    The service information is stored in the Task's app field in the backend.
    """

    name: str = "expose_service"
    display_name: str = "发布服务信息"
    description: str = (
        "Publish or expose service information. Use this tool when the user needs to:\n"
        "- Deploy or publish a web application with a preview URL\n"
        "- Set or share a host address\n"
        "- Share MySQL database connection information after creating a database\n"
        "- Set an application name\n\n"
        "At least one of the parameters (name, host, previewUrl, mysql) must be provided."
    )
    args_schema: type[BaseModel] = ExposeServiceInput

    # Task ID for the current conversation (injected at tool creation)
    task_id: int = 0

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def _run(
        self,
        name: Optional[str] = None,
        host: Optional[str] = None,
        previewUrl: Optional[str] = None,
        mysql: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("ExposeServiceTool only supports async execution")

    async def _arun(
        self,
        name: Optional[str] = None,
        host: Optional[str] = None,
        previewUrl: Optional[str] = None,
        mysql: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute service exposure asynchronously.

        Args:
            name: Application name
            host: Host address
            previewUrl: Application preview URL
            mysql: MySQL connection string
            run_manager: Callback manager

        Returns:
            JSON string with operation result
        """
        try:
            if not self.task_id:
                return json.dumps(
                    {"error": "Task ID not configured for this tool."},
                    ensure_ascii=False,
                )

            # Check that at least one field is provided
            if not any([name, host, previewUrl, mysql]):
                return json.dumps(
                    {
                        "error": "At least one service field (name, host, previewUrl, mysql) must be provided."
                    },
                    ensure_ascii=False,
                )

            logger.info(
                f"[ExposeServiceTool] Exposing service for task {self.task_id}: "
                f"name={name}, host={host}, previewUrl={previewUrl}, mysql={'***' if mysql else None}"
            )

            result = await self._update_service_via_backend(
                name=name,
                host=host,
                previewUrl=previewUrl,
                mysql=mysql,
            )

            if result.get("success"):
                # Build a user-friendly response message
                updated_fields = []
                if name:
                    updated_fields.append(f"name: {name}")
                if host:
                    updated_fields.append(f"host: {host}")
                if previewUrl:
                    updated_fields.append(f"previewUrl: {previewUrl}")
                if mysql:
                    updated_fields.append("mysql: (connection string saved)")

                return json.dumps(
                    {
                        "success": True,
                        "message": f"Service information published successfully: {', '.join(updated_fields)}",
                        "app": result.get("app", {}),
                    },
                    ensure_ascii=False,
                )
            else:
                return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.error(f"[ExposeServiceTool] Failed: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Failed to expose service: {str(e)}"},
                ensure_ascii=False,
            )

    async def _update_service_via_backend(
        self,
        name: Optional[str],
        host: Optional[str],
        previewUrl: Optional[str],
        mysql: Optional[str],
    ) -> dict:
        """Update service data by calling backend internal API.

        Args:
            name: Application name
            host: Host address
            previewUrl: Preview URL
            mysql: MySQL connection string

        Returns:
            Dictionary with operation result
        """
        # Get backend API URL from settings
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        # Build request data with only non-None fields
        request_data = {"task_id": self.task_id}
        if name is not None:
            request_data["name"] = name
        if host is not None:
            request_data["host"] = host
        if previewUrl is not None:
            request_data["previewUrl"] = previewUrl
        if mysql is not None:
            request_data["mysql"] = mysql

        # Call backend internal API
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                url = f"{backend_url}/api/internal/services/update"
                logger.info(f"[ExposeServiceTool] Calling backend internal API: {url}")
                logger.debug(f"[ExposeServiceTool] Request data: {request_data}")

                response = await client.post(url, json=request_data)
                response.raise_for_status()

                result = response.json()
                logger.info(
                    f"[ExposeServiceTool] Backend API returned success={result.get('success')}"
                )

                return result

            except httpx.HTTPStatusError as e:
                error_detail = "Unknown error"
                try:
                    error_data = e.response.json()
                    error_detail = error_data.get("detail", str(e))
                except Exception:
                    error_detail = e.response.text or str(e)

                logger.error(
                    f"[ExposeServiceTool] Backend API error: {e.response.status_code} - {error_detail}"
                )
                return {
                    "success": False,
                    "error": f"Backend API error: {error_detail}",
                    "httpStatus": e.response.status_code,
                }

            except httpx.RequestError as e:
                logger.error(f"[ExposeServiceTool] Request error: {e}")
                return {
                    "success": False,
                    "error": f"Failed to connect to backend: {str(e)}",
                }

            except Exception as e:
                logger.error(f"[ExposeServiceTool] Unexpected error: {e}", exc_info=True)
                return {
                    "success": False,
                    "error": f"Unexpected error: {str(e)}",
                }
