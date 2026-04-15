# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Get DingTalk MCP configuration tool.

This tool retrieves the current user's DingTalk MCP configuration
for a specific service type (docs, table, or ai_table) from the database.
"""

import json
import logging

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from chat_shell.skills import SkillToolContext
from shared.models.execution import ExecutionRequest
from shared.utils.crypto import is_data_encrypted

logger = logging.getLogger(__name__)


class GetDingtalkMcpConfigInput(BaseModel):
    """Input schema for get_dingtalk_mcp_config tool."""

    service_type: str = Field(
        description="DingTalk service type: 'docs', 'table', or 'ai_table'",
        enum=["docs", "table", "ai_table"],
    )


class GetDingtalkMcpConfig(BaseTool):
    """Tool to get user's DingTalk MCP configuration.

    This tool accesses the database to retrieve the user's DingTalk MCP
    configuration for a specific service type. The configuration includes
    whether the service is enabled and the MCP server URL.

    Example usage:
        get_dingtalk_mcp_config(service_type="docs")
        # Returns: {"enabled": true, "url": "https://...", "server_name": "dingtalk_docs"}
    """

    name: str = "get_dingtalk_mcp_config"
    description: str = (
        "Get current user's DingTalk MCP configuration for a specific service type. "
        "Returns whether the service is enabled and the MCP server URL. "
        "Use this tool to check if DingTalk MCP is configured before attempting file operations."
    )
    args_schema: type = GetDingtalkMcpConfigInput

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        ws_emitter: Any,
        user_id: int,
        user_name: str,
    ):
        """Initialize the tool.

        Args:
            task_id: Task identifier
            subtask_id: Subtask identifier
            ws_emitter: WebSocket emitter for progress updates
            user_id: User identifier
            user_name: User name
        """
        super().__init__()
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.ws_emitter = ws_emitter
        self.user_id = user_id
        self.user_name = user_name

        # Lazy import to avoid circular dependencies
        self._User = None
        self._user_mcp_service = None
        self._get_mcp_provider_service = None

    def _lazy_import(self):
        """Lazy import database models and services."""
        if self._User is None:
            from app.models.user import User
            from app.services.user_mcp_service import UserMCPService
            from app.services.mcp_provider_registry import get_mcp_provider_service

            self._User = User
            self._user_mcp_service = UserMCPService()
            self._get_mcp_provider_service = get_mcp_provider_service

    def _get_service_mapping(self, service_type: str) -> dict[str, Any]:
        """Get provider and service information for a service type.

        Args:
            service_type: Service type ('docs', 'table', 'ai_table')

        Returns:
            Dictionary with provider_id, service_id, and server_name
        """
        service_mapping = {
            "docs": {
                "provider_id": "dingtalk",
                "service_id": "docs",
                "server_name": "dingtalk_docs",
            },
            "table": {
                "provider_id": "dingtalk",
                "service_id": "table",
                "server_name": "dingtalk_table",
            },
            "ai_table": {
                "provider_id": "dingtalk",
                "service_id": "ai_table",
                "server_name": "dingtalk_ai_table",
            },
        }
        return service_mapping.get(service_type, {})

    def _run(self, service_type: str) -> dict[str, Any]:
        """Execute the tool to get DingTalk MCP configuration.

        Args:
            service_type: Service type ('docs', 'table', 'ai_table')

        Returns:
            Dictionary with configuration:
            - enabled: Whether the service is enabled
            - url: MCP server URL (decrypted)
            - service_id: Service identifier
            - server_name: MCP server name
            - error: Error message if configuration retrieval failed
        """
        self._lazy_import()

        try:
            # Get service mapping
            service_info = self._get_service_mapping(service_type)
            if not service_info:
                return {
                    "error": f"Invalid service type: {service_type}",
                    "enabled": False,
                }

            # Get user from database
            from app.core.database import get_db
            db = next(get_db())
            user = db.query(self._User).filter(self._User.id == self.user_id).first()

            if not user:
                logger.warning(
                    f"[DingTalkMcpConfig] User not found: user_id={self.user_id}"
                )
                return {
                    "error": "User not found in database",
                    "enabled": False,
                }

            # Get user preferences (contains MCP configuration)
            preferences = getattr(user, "preferences", None)
            if not preferences:
                return {
                    "error": "User preferences not found",
                    "enabled": False,
                }

            # Parse preferences (might be JSON string or dict)
            if isinstance(preferences, str):
                try:
                    preferences_dict = json.loads(preferences)
                except json.JSONDecodeError:
                    return {
                        "error": "Invalid preferences format",
                        "enabled": False,
                    }
            else:
                preferences_dict = preferences

            # Get MCP configuration for this service
            mcps = preferences_dict.get("mcps", {})
            provider_mcps = mcps.get(service_info["provider_id"], {})
            services = provider_mcps.get("services", {})
            service_config = services.get(service_info["service_id"], {})

            # Check if enabled
            enabled = service_config.get("enabled", False)
            if not enabled:
                return {
                    "enabled": False,
                    "service_id": service_info["service_id"],
                    "server_name": service_info["server_name"],
                    "error": (
                        f"DingTalk {service_type} service is not enabled. "
                        "Please enable it in your MCP settings."
                    ),
                }

            # Get URL from credentials
            credentials = service_config.get("credentials", {})
            url = credentials.get("url", "")

            # Decrypt URL if encrypted
            if url and is_data_encrypted(url):
                from shared.utils.crypto import decrypt_sensitive_data
                try:
                    decrypted_url = decrypt_sensitive_data(url)
                    if not decrypted_url:
                        return {
                            "error": "Failed to decrypt MCP URL",
                            "enabled": False,
                        }
                    url = decrypted_url
                except Exception as e:
                    logger.error(
                        f"[DingTalkMcpConfig] Failed to decrypt URL: {str(e)}"
                    )
                    return {
                        "error": "Failed to decrypt MCP URL",
                        "enabled": False,
                    }

            # Verify URL is valid
            if not url or not isinstance(url, str):
                return {
                    "error": "Invalid MCP URL configuration",
                    "enabled": False,
                }

            logger.info(
                f"[DingTalkMcpConfig] Retrieved config for user_id={self.user_id}, "
                f"service_type={service_type}, enabled={enabled}"
            )

            # Get available tools for this service type
            from app.services.mcp_provider_registry import list_mcp_provider_services

            available_tools = []
            try:
                provider_services = list_mcp_provider_services(service_info["provider_id"])
                for service in provider_services:
                    if service.get("service_id") == service_info["service_id"]:
                        # Get MCP server definition
                        mcp_server_def = service.get("server_name", "")
                        if mcp_server_def:
                            # Define available tools based on server type
                            if mcp_server_def == "dingtalk_docs":
                                available_tools = [
                                    "get_document_info",
                                    "download_file",
                                    "list_nodes",
                                    "get_document_content",
                                ]
                            elif mcp_server_def == "dingtalk_table":
                                available_tools = [
                                    "get_all_sheets",
                                    "get_sheet",
                                    "get_range",
                                ]
                            elif mcp_server_def == "dingtalk_ai_table":
                                available_tools = [
                                    "get_tables",
                                    "query_records",
                                ]
                            break
            except Exception as e:
                logger.warning(
                    f"[DingTalkMcpConfig] Failed to get tool list: {str(e)}"
                )

            return {
                "enabled": True,
                "url": url,
                "service_id": service_info["service_id"],
                "server_name": service_info["server_name"],
                "provider_id": service_info["provider_id"],
                "available_tools": available_tools,
            }

        except Exception as e:
            logger.exception(
                f"[DingTalkMcpConfig] Failed to get config: {str(e)}"
            )
            return {
                "error": f"Failed to retrieve configuration: {str(e)}",
                "enabled": False,
            }

    def _arun(self, service_type: str) -> dict[str, Any]:
        """Async wrapper for _run method.

        Args:
            service_type: Service type ('docs', 'table', 'ai_table')

        Returns:
            Configuration dictionary
        """
        return self._run(service_type)