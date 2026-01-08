# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk table provider implementation.

Handles DingTalk (钉钉) multi-dimensional table URL parsing and data querying.
"""

import json
import logging
import os
import re
from typing import Any, ClassVar, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

from .base import (
    BaseTableProvider,
    TableContext,
    TableProviderRegistry,
)
from .dingtalk_client import DingtalkNotableClient
from .dingtalk_user_mapping import (
    DingtalkUserMapping,
    enrich_with_username,
)

logger = logging.getLogger(__name__)


@TableProviderRegistry.register
class DingTalkProvider(BaseTableProvider):
    """DingTalk table provider.

    Supports DingTalk multi-dimensional tables (钉钉多维表格).

    Example URL:
    https://alidocs.dingtalk.com/i/nodes/pGBa2Lm8ayKYEQeYfvP0d70d8gN7R35y?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DH8oOITO
    """

    provider_type: ClassVar[str] = "dingtalk"
    url_patterns: ClassVar[List[str]] = [
        "dingtalk.com",
        "alidocs.dingtalk.com",
    ]

    @classmethod
    def parse_url(cls, url: str) -> Optional[TableContext]:
        """Parse DingTalk table URL to extract baseId and sheetId.

        Args:
            url: DingTalk table URL

        Returns:
            TableContext with baseId and sheetIdOrName
        """
        base_id = ""
        sheet_id_or_name = ""

        try:
            parsed = urlparse(url)

            # Extract baseId from path: /i/nodes/{baseId}
            path_match = re.search(r"/nodes/([^/?]+)", parsed.path)
            if path_match:
                base_id = path_match.group(1)

            # Extract sheetId from iframeQuery parameter
            query_params = parse_qs(parsed.query)
            iframe_query = query_params.get("iframeQuery", [""])[0]

            if iframe_query:
                # URL decode the iframeQuery value
                decoded_query = unquote(iframe_query)
                # Parse the inner query string
                inner_params = parse_qs(decoded_query)
                sheet_id = inner_params.get("sheetId", [""])[0]
                if sheet_id:
                    sheet_id_or_name = sheet_id

            logger.debug(
                f"Parsed DingTalk URL: {url} -> baseId={base_id}, sheetId={sheet_id_or_name}"
            )

            if base_id:
                return TableContext(base_id=base_id, sheet_id_or_name=sheet_id_or_name)
            return None

        except Exception as e:
            logger.warning(f"Failed to parse DingTalk URL '{url}': {e}")
            return None

    def _load_data_table_config(self) -> Optional[Dict[str, Any]]:
        """Load Data Table configuration from environment variable.

        Returns:
            Configuration dict or None if not set
        """
        config_env = os.getenv("DATA_TABLE_CONFIG")
        if not config_env:
            logger.warning(
                "[DingTalkProvider] DATA_TABLE_CONFIG environment variable not set"
            )
            return None

        try:
            config = json.loads(config_env)
            logger.debug(
                f"[DingTalkProvider] Loaded DATA_TABLE_CONFIG with keys: {config.keys()}"
            )
            return config
        except json.JSONDecodeError as e:
            logger.error(
                f"[DingTalkProvider] Failed to parse DATA_TABLE_CONFIG JSON: {e}"
            )
            return None

    def _get_dingtalk_config(self, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Extract DingTalk configuration from Data Table config.

        Args:
            config: Full Data Table configuration

        Returns:
            DingTalk config dict or None if not found
        """
        dingtalk_config = config.get("dingtalk")
        if not dingtalk_config:
            logger.error(
                "[DingTalkProvider] 'dingtalk' key not found in DATA_TABLE_CONFIG"
            )
            return None

        # Validate required fields
        required_fields = ["appKey", "appSecret", "operatorId", "userMapping"]
        for field in required_fields:
            if field not in dingtalk_config:
                logger.error(
                    f"[DingTalkProvider] Missing required field '{field}' "
                    f"in dingtalk config"
                )
                return None

        return dingtalk_config

    async def _ensure_user_mapping_initialized(
        self, dingtalk_config: Dict[str, Any]
    ) -> bool:
        """Ensure user mapping cache is initialized.

        Args:
            dingtalk_config: DingTalk configuration dict

        Returns:
            True if initialized successfully, False otherwise
        """
        if DingtalkUserMapping.is_initialized():
            logger.debug("[DingTalkProvider] User mapping already initialized")
            return True

        try:
            user_mapping_config = dingtalk_config.get("userMapping", {})

            logger.info("[DingTalkProvider] Initializing user mapping cache...")
            await DingtalkUserMapping.initialize(
                app_key=dingtalk_config["appKey"],
                app_secret=dingtalk_config["appSecret"],
                base_id=user_mapping_config.get("baseId", ""),
                sheet_id=user_mapping_config.get("sheetId", ""),
                operator_id=dingtalk_config["operatorId"],
            )

            logger.info(
                f"[DingTalkProvider] User mapping initialized: "
                f"{DingtalkUserMapping.size()} mappings loaded"
            )
            return True

        except Exception as e:
            logger.error(f"[DingTalkProvider] Failed to initialize user mapping: {e}")
            # Don't fail the request if user mapping fails
            return False

    async def list_records(
        self,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int = 100,
        user_id: int = 0,
    ) -> Dict[str, Any]:
        """Query records from a DingTalk table.

        Args:
            base_id: The base ID of the table (node ID from URL)
            sheet_id_or_name: The sheet ID or name within the base
            max_records: Maximum number of records to return
            user_id: User ID for access control

        Returns:
            Dictionary with schema and records:
            {
                "schema": [{"name": "field1", "type": "text"}, ...],
                "records": [{"field1": "value1", ...}, ...],
                "total": 100,
                "hasMore": bool,
                "nextToken": str
            }
        """
        logger.info(
            f"[DingTalkProvider] list_records: base_id={base_id}, "
            f"sheet_id_or_name={sheet_id_or_name}, max_records={max_records}"
        )

        # 1. Load configuration
        data_table_config = self._load_data_table_config()
        if not data_table_config:
            return {
                "error": "DATA_TABLE_CONFIG environment variable not configured",
                "provider": self.provider_type,
                "base_id": base_id,
                "sheet_id_or_name": sheet_id_or_name,
            }

        dingtalk_config = self._get_dingtalk_config(data_table_config)
        if not dingtalk_config:
            return {
                "error": "DingTalk configuration not found in DATA_TABLE_CONFIG",
                "provider": self.provider_type,
                "base_id": base_id,
                "sheet_id_or_name": sheet_id_or_name,
            }

        # 2. Initialize user mapping (optional, don't fail if it errors)
        await self._ensure_user_mapping_initialized(dingtalk_config)

        # 3. Create DingTalk client
        try:
            client = DingtalkNotableClient(
                app_key=dingtalk_config["appKey"],
                app_secret=dingtalk_config["appSecret"],
                base_id=base_id,
                operator_id=dingtalk_config["operatorId"],
            )
        except Exception as e:
            logger.error(f"[DingTalkProvider] Failed to create client: {e}")
            return {
                "error": f"Failed to create DingTalk client: {str(e)}",
                "provider": self.provider_type,
                "base_id": base_id,
                "sheet_id_or_name": sheet_id_or_name,
            }

        # 4. Determine target sheet
        target_sheet = sheet_id_or_name
        if not target_sheet:
            logger.info("[DingTalkProvider] No sheet specified, fetching first sheet")
            sheets_response = await client.get_all_sheets()

            if not sheets_response.get("success"):
                error_msg = sheets_response.get("errorMsg", "Unknown error")
                logger.error(f"[DingTalkProvider] Failed to get sheets: {error_msg}")
                return {
                    "error": f"Failed to get sheets: {error_msg}",
                    "provider": self.provider_type,
                    "base_id": base_id,
                }

            sheets = sheets_response.get("result", {}).get("value", [])
            if not sheets:
                logger.error("[DingTalkProvider] No sheets found in base")
                return {
                    "error": "No sheets found in the specified base",
                    "provider": self.provider_type,
                    "base_id": base_id,
                }

            target_sheet = sheets[0]["id"]
            logger.info(f"[DingTalkProvider] Using first sheet: {target_sheet}")

        # 5. Fetch records
        records_response = await client.list_records(
            sheet_id_or_name=target_sheet,
            page_size=min(max_records, 100),
        )

        if not records_response.get("success"):
            error_msg = records_response.get("errorMsg", "Unknown error")
            error_code = records_response.get("errorCode", "UNKNOWN")
            logger.error(
                f"[DingTalkProvider] Failed to fetch records: {error_msg} ({error_code})"
            )
            return {
                "error": f"Failed to fetch records: {error_msg}",
                "errorCode": error_code,
                "provider": self.provider_type,
                "base_id": base_id,
                "sheet_id_or_name": target_sheet,
            }

        result = records_response.get("result", {})
        raw_records = result.get("records", [])

        # 6. Transform records and enrich with username
        transformed_records = []
        for record in raw_records:
            enriched_fields = enrich_with_username(record.get("fields", {}))
            transformed_records.append(
                {
                    "id": record.get("id"),
                    "fields": enriched_fields,
                    "createdTime": record.get("createdTime"),
                    "modifiedTime": record.get("modifiedTime"),
                }
            )

        # 7. Generate schema from first record (simple type inference)
        schema = []
        if transformed_records:
            first_record = transformed_records[0].get("fields", {})
            for field_name, field_value in first_record.items():
                field_type = "text"
                if isinstance(field_value, (int, float)):
                    field_type = "number"
                elif isinstance(field_value, bool):
                    field_type = "boolean"
                elif isinstance(field_value, list):
                    field_type = "array"
                elif isinstance(field_value, dict):
                    field_type = "object"

                schema.append(
                    {
                        "name": field_name,
                        "type": field_type,
                    }
                )

        # 8. Return normalized response
        logger.info(
            f"[DingTalkProvider] Successfully fetched {len(transformed_records)} records"
        )

        return {
            "schema": schema,
            "records": transformed_records,
            "total": len(transformed_records),
            "hasMore": result.get("hasMore", False),
            "nextToken": result.get("nextToken"),
            "provider": self.provider_type,
            "base_id": base_id,
            "sheet_id_or_name": target_sheet,
        }
