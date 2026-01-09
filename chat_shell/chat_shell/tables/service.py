# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data Table Service for querying table data.

This service provides a unified interface to query data from external table sources
(DingTalk Notable, Feishu Bitable, etc.). It delegates to the appropriate provider
implementation based on the provider type.
"""

import logging
from typing import Any, Dict

from .base import TableProviderRegistry

logger = logging.getLogger(__name__)


class DataTableService:
    """Service for querying data from external table sources.

    This service provides a unified interface for querying table data,
    delegating to the appropriate provider implementation based on the
    provider type (DingTalk, Feishu, etc.).
    """

    async def list_records(
        self,
        provider: str,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int = 100,
        user_id: int = 0,
    ) -> Dict[str, Any]:
        """Query records from a table.

        Args:
            provider: The table provider type (e.g., 'dingtalk', 'feishu')
            base_id: The base ID of the table (extracted from table URL)
            sheet_id_or_name: The sheet ID or name within the base
            max_records: Maximum number of records to return
            user_id: User ID for access control

        Returns:
            Dictionary with schema and records:
            {
                "schema": [{"name": "field1", "type": "text"}, ...],
                "records": [{"field1": "value1", ...}, ...],
                "total": 100
            }
        """
        logger.info(
            "[DataTableService] list_records: provider=%s, base_id=%s, "
            "sheet_id_or_name=%s, max_records=%d, user_id=%d",
            provider,
            base_id,
            sheet_id_or_name,
            max_records,
            user_id,
        )

        # Get the provider class from registry
        provider_class = TableProviderRegistry.get_provider(provider)
        if not provider_class:
            logger.warning(f"[DataTableService] Unknown provider: {provider}")
            return {
                "error": f"Unknown table provider: {provider}. "
                f"Available providers: {list(TableProviderRegistry.get_all_providers().keys())}",
                "provider": provider,
                "base_id": base_id,
                "sheet_id_or_name": sheet_id_or_name,
            }

        # Create provider instance and call list_records
        provider_instance = provider_class()
        return await provider_instance.list_records(
            base_id=base_id,
            sheet_id_or_name=sheet_id_or_name,
            max_records=max_records,
            user_id=user_id,
        )
