# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk table provider implementation."""

import logging
from typing import Any, Dict, Optional

from ...base import BaseTableProvider, TableProviderRegistry
from ...models import TableContext, TableQueryResponse
from ...url_parser import TableURLParser
from .client import DingtalkNotableClient, DingtalkTokenManager
from .config import get_dingtalk_config
from .user_mapping import DingtalkUserMapping

logger = logging.getLogger(__name__)


@TableProviderRegistry.register("dingtalk")
class DingTalkProvider(BaseTableProvider):
    """DingTalk table provider.

    Provides access to DingTalk Notable (multi-dimensional table) data.
    """

    def __init__(self):
        """Initialize DingTalk provider."""
        self.config = get_dingtalk_config()
        self.token_manager = DingtalkTokenManager(
            app_key=self.config.app_key,
            app_secret=self.config.app_secret,
        )
        self.user_mapping: Optional[DingtalkUserMapping] = None
        self._user_mapping_initialized = False

    async def _ensure_user_mapping(self):
        """Ensure user mapping is initialized if configured."""
        if not self._user_mapping_initialized and self.config.user_mapping:
            logger.info("[DingTalkProvider] Initializing user mapping...")
            self.user_mapping = DingtalkUserMapping(
                token_manager=self.token_manager,
                base_id=self.config.user_mapping.base_id,
                sheet_id=self.config.user_mapping.sheet_id,
                operator_id=self.config.operator_id,
            )
            await self.user_mapping.initialize()
            self._user_mapping_initialized = True
            logger.info("[DingTalkProvider] User mapping initialized")

    def parse_url(self, url: str) -> Optional[TableContext]:
        """Parse DingTalk table URL.

        Args:
            url: DingTalk table URL

        Returns:
            TableContext if URL is valid, None otherwise
        """
        # Detect if it's a DingTalk URL
        provider = TableURLParser.detect_provider_from_url(url)
        if provider != "dingtalk":
            return None

        # Parse the URL using the URL parser
        parsed_context = TableURLParser.parse_dingtalk_url(url)
        if parsed_context:
            # Convert url_parser.TableContext (dataclass) to models.TableContext (BaseModel)
            return TableContext(
                provider="dingtalk",
                base_id=parsed_context.base_id,
                sheet_id_or_name=parsed_context.sheet_id_or_name,
                url=url,
            )
        return None

    async def list_records(
        self,
        base_id: str,
        sheet_id_or_name: str,
        user_name: Optional[str] = None,
        max_records: int = 100,
        filters: Optional[Dict[str, Any]] = None,
    ) -> TableQueryResponse:
        """Query DingTalk table data.

        Args:
            base_id: Table base ID
            sheet_id_or_name: Sheet ID or name
            user_name: Username for access control
            max_records: Maximum number of records to return
            filters: Query filter conditions (not implemented yet)

        Returns:
            TableQueryResponse with schema and records

        Raises:
            Exception: If query fails
        """
        await self._ensure_user_mapping()

        # Determine operator_id
        operator_id = self.config.operator_id  # Default value
        if user_name and self.user_mapping:
            dingtalk_id = await self.user_mapping.get_dingtalk_id(user_name)
            if dingtalk_id:
                operator_id = dingtalk_id
                logger.info(
                    f"[DingTalkProvider] Using user's dingtalk_id: {operator_id}"
                )
            else:
                logger.warning(
                    f"[DingTalkProvider] User {user_name} not found in mapping, "
                    f"using default operator_id"
                )

        # Create client and query
        client = DingtalkNotableClient(
            token_manager=self.token_manager,
            operator_id=operator_id,
        )

        # Fetch all records with pagination
        all_records = []
        next_token = None
        remaining_records = max_records

        while remaining_records > 0:
            page_size = min(remaining_records, 100)
            response = await client.list_records(
                base_id=base_id,
                sheet_id_or_name=sheet_id_or_name,
                page_size=page_size,
                next_token=next_token,
            )

            if not response.get("success"):
                error_msg = response.get("errorMsg", "Unknown error")
                error_code = response.get("errorCode", "UNKNOWN")
                logger.error(
                    f"[DingTalkProvider] Query failed: {error_msg} (code: {error_code})"
                )
                raise Exception(
                    f"Failed to query table: {error_msg} (code: {error_code})"
                )

            result = response.get("result", {})
            records = result.get("records", [])

            # Extract fields from records
            for record in records:
                fields = record.get("fields", {})
                all_records.append(fields)

            remaining_records -= len(records)

            # Check if there are more pages
            has_more = result.get("hasMore", False)
            next_token = result.get("nextToken")

            if not has_more or not next_token or len(records) == 0:
                break

        # Enrich with username if mapping is available
        if self.user_mapping:
            all_records = await self.user_mapping.enrich_with_username(all_records)

        # Infer schema from first record (simple type inference)
        schema = {}
        if all_records:
            for field_name, field_value in all_records[0].items():
                schema[field_name] = self._infer_type(field_value)

        return TableQueryResponse(
            field_schema=schema,
            records=all_records,
            total_count=len(all_records),
        )

    def _infer_type(self, value: Any) -> str:
        """Infer field type from value.

        Args:
            value: Field value

        Returns:
            Type string
        """
        if value is None:
            return "unknown"
        elif isinstance(value, bool):
            return "boolean"
        elif isinstance(value, int):
            return "integer"
        elif isinstance(value, float):
            return "number"
        elif isinstance(value, str):
            return "string"
        elif isinstance(value, list):
            return "array"
        elif isinstance(value, dict):
            return "object"
        else:
            return "unknown"

    async def validate_access(
        self,
        base_id: str,
        sheet_id_or_name: str,
        user_name: Optional[str] = None,
    ) -> bool:
        """Validate user access to table.

        Args:
            base_id: Table base ID
            sheet_id_or_name: Sheet ID or name
            user_name: Username

        Returns:
            True if user has access, False otherwise

        Raises:
            Exception: Re-raises exception for 500 errors or linked table issues
        """
        try:
            # Try to query 1 record to validate access
            await self.list_records(
                base_id=base_id,
                sheet_id_or_name=sheet_id_or_name,
                user_name=user_name,
                max_records=1,
            )
            return True
        except Exception as e:
            error_msg = str(e).lower()
            # Re-raise exception for 500 errors or potential linked table issues
            # This allows upper layers to provide more specific error messages
            if "500" in error_msg or "internal" in error_msg or "linked" in error_msg:
                logger.warning(
                    f"[DingTalkProvider] Access validation failed with server error: {e}"
                )
                raise
            # For other errors (permissions, not found, etc.), return False
            logger.warning(f"[DingTalkProvider] Access validation failed: {e}")
            return False
