# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data table tool for querying table data.

This tool allows AI to query data from external table sources
(DingTalk Notable, Feishu Bitable, etc.) by calling the backend API.
"""

import json
import logging
from typing import Any

import httpx
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


class DataTableInput(BaseModel):
    """Input schema for data table query tool."""

    provider: str = Field(
        description="The table provider type (e.g., 'dingtalk', 'feishu')"
    )
    base_id: str = Field(
        description="The base ID of the table (extracted from table URL)"
    )
    sheet_id_or_name: str = Field(description="The sheet ID or name within the base")
    max_records: int = Field(
        default=100,
        description="Maximum number of records to return",
    )


class DataTableTool(BaseTool):
    """Data table query tool for retrieving table data.

    This tool allows AI to query data from external table sources by calling
    the backend API. The backend handles all table provider implementations.
    """

    name: str = "data_table_query"
    display_name: str = "查询数据表"
    description: str = (
        "Query data from a data table. Use this tool to retrieve records "
        "from the selected table. Returns table schema (field definitions) "
        "and records (data rows). You MUST provide provider, base_id, and "
        "sheet_id_or_name parameters from the table context."
    )
    args_schema: type[BaseModel] = DataTableInput

    # Table contexts (set when creating the tool)
    # Each context contains: name, baseId, sheetIdOrName
    table_contexts: list[dict] = Field(default_factory=list)

    # User ID for access control
    user_id: int = 0

    # User name for access control
    user_name: str = ""

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        provider: str,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int = 100,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("DataTableTool only supports async execution")

    async def _arun(
        self,
        provider: str,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int = 100,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute table data query asynchronously.

        Args:
            provider: The table provider type (e.g., 'dingtalk', 'feishu')
            base_id: The base ID of the table
            sheet_id_or_name: The sheet ID or name
            max_records: Maximum number of records to return
            run_manager: Callback manager

        Returns:
            JSON string with table schema and records
        """
        try:
            if not self.table_contexts:
                return json.dumps(
                    {"error": "No table contexts configured for this conversation."},
                    ensure_ascii=False,
                )

            logger.info(
                f"[DataTableTool] Querying table: provider={provider}, base_id={base_id}, "
                f"sheet_id_or_name={sheet_id_or_name}, max_records={max_records}"
            )

            result = await self._query_table_via_backend(
                provider=provider,
                base_id=base_id,
                sheet_id_or_name=sheet_id_or_name,
                max_records=max_records,
            )
            return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.error(f"[DataTableTool] Query failed: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Table query failed: {str(e)}"},
                ensure_ascii=False,
            )

    async def _query_table_via_backend(
        self,
        provider: str,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int,
    ) -> dict[str, Any]:
        """Query table data by calling backend internal API.

        Args:
            provider: The table provider type
            base_id: The base ID of the table
            sheet_id_or_name: The sheet ID or name
            max_records: Maximum number of records

        Returns:
            Dictionary with schema and records
        """
        # Get backend API URL from settings
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        # Construct API request
        request_data = {
            "provider": provider,
            "base_id": base_id,
            "sheet_id_or_name": sheet_id_or_name,
            "user_name": self.user_name,
            "max_records": max_records,
        }

        # Call backend internal API (no authentication required for internal endpoints)
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                # Use internal API endpoint for service-to-service communication
                url = f"{backend_url}/api/internal/tables/query"
                logger.info(f"[DataTableTool] Calling backend internal API: {url}")
                logger.debug(f"[DataTableTool] Request data: {request_data}")

                response = await client.post(url, json=request_data)
                response.raise_for_status()

                result = response.json()
                logger.info(
                    f"[DataTableTool] Backend API returned {result.get('total_count', 0)} records"
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
                    f"[DataTableTool] Backend API error: {e.response.status_code} - {error_detail}"
                )
                return {
                    "error": f"Backend API error: {error_detail}",
                    "httpStatus": e.response.status_code,
                }

            except httpx.RequestError as e:
                logger.error(f"[DataTableTool] Request error: {e}")
                return {
                    "error": f"Failed to connect to backend: {str(e)}",
                }

            except Exception as e:
                logger.error(f"[DataTableTool] Unexpected error: {e}", exc_info=True)
                return {
                    "error": f"Unexpected error: {str(e)}",
                }
