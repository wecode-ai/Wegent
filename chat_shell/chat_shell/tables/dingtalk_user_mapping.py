# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk user mapping service.

Manages unionId to username mapping by loading from a DingTalk Notable table.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from .dingtalk_client import DingtalkNotableClient

logger = logging.getLogger(__name__)


class DingtalkUserMapping:
    """User mapping cache service.

    Loads and caches unionId -> username mappings from a DingTalk Notable table.
    """

    _cache: Dict[str, str] = {}
    _initialized: bool = False
    _last_refresh_time: Optional[datetime] = None
    _lock = asyncio.Lock()

    @classmethod
    async def initialize(
        cls,
        app_key: str,
        app_secret: str,
        base_id: str,
        sheet_id: str,
        operator_id: str,
    ) -> None:
        """Initialize user mapping cache from DingTalk table.

        Args:
            app_key: DingTalk app key
            app_secret: DingTalk app secret
            base_id: Base ID containing user mapping table
            sheet_id: Sheet ID of user mapping table
            operator_id: Operator user ID
        """
        async with cls._lock:
            logger.info("[DingtalkUserMapping] Initializing user mapping cache...")
            logger.info(f"[DingtalkUserMapping] Base ID: {base_id}")
            logger.info(f"[DingtalkUserMapping] Sheet ID: {sheet_id}")

            client = DingtalkNotableClient(
                app_key=app_key,
                app_secret=app_secret,
                base_id=base_id,
                operator_id=operator_id,
            )

            # Clear existing cache
            cls._cache.clear()

            total_records = 0
            next_token = None

            # Paginate through all records
            while True:
                response = await client.list_records(
                    sheet_id_or_name=sheet_id,
                    page_size=100,
                    next_token=next_token,
                )

                if not response.get("success"):
                    error_msg = response.get("errorMsg", "Unknown error")
                    error_code = response.get("errorCode", "UNKNOWN")
                    logger.error(
                        f"[DingtalkUserMapping] Failed to fetch records: "
                        f"{error_msg} (code: {error_code})"
                    )
                    raise Exception(
                        f"Failed to load user mapping: {error_msg} (code: {error_code})"
                    )

                result = response.get("result", {})
                records = result.get("records", [])

                # Process each record
                for record in records:
                    fields = record.get("fields", {})
                    username = fields.get("邮箱")
                    persons = fields.get("人员", [])

                    # Extract unionId and username mapping
                    if username and persons and len(persons) > 0:
                        union_id = persons[0].get("unionId")
                        if union_id:
                            cls._cache[union_id] = username
                            total_records += 1

                # Check if there are more pages
                has_more = result.get("hasMore", False)
                next_token = result.get("nextToken")

                if not has_more or not next_token:
                    break

            cls._initialized = True
            cls._last_refresh_time = datetime.now()

            logger.info(
                f"[DingtalkUserMapping] Initialization complete, "
                f"loaded {total_records} mappings"
            )

    @classmethod
    def get_username(cls, union_id: str) -> Optional[str]:
        """Get username by unionId.

        Args:
            union_id: User's unionId

        Returns:
            Username if found, None otherwise
        """
        return cls._cache.get(union_id)

    @classmethod
    def get_all_mappings(cls) -> Dict[str, str]:
        """Get all mappings.

        Returns:
            Copy of unionId -> username mapping dict
        """
        return cls._cache.copy()

    @classmethod
    def size(cls) -> int:
        """Get cache size.

        Returns:
            Number of mappings in cache
        """
        return len(cls._cache)

    @classmethod
    def is_initialized(cls) -> bool:
        """Check if cache is initialized.

        Returns:
            True if initialized, False otherwise
        """
        return cls._initialized

    @classmethod
    def get_last_refresh_time(cls) -> Optional[datetime]:
        """Get last refresh time.

        Returns:
            Last refresh datetime, None if not initialized
        """
        return cls._last_refresh_time

    @classmethod
    async def refresh(
        cls,
        app_key: str,
        app_secret: str,
        base_id: str,
        sheet_id: str,
        operator_id: str,
    ) -> None:
        """Manually refresh cache.

        Args:
            app_key: DingTalk app key
            app_secret: DingTalk app secret
            base_id: Base ID containing user mapping table
            sheet_id: Sheet ID of user mapping table
            operator_id: Operator user ID
        """
        logger.info("[DingtalkUserMapping] Manual cache refresh requested")
        await cls.initialize(app_key, app_secret, base_id, sheet_id, operator_id)


def enrich_with_username(obj: Any) -> Any:
    """Recursively transform unionId to username in objects.

    Traverses nested structures and replaces objects containing unionId
    with a username field (using cached mapping if available).

    Args:
        obj: Object to transform (can be dict, list, or primitive)

    Returns:
        Transformed object with unionId replaced by username
    """
    if isinstance(obj, list):
        return [enrich_with_username(item) for item in obj]

    if isinstance(obj, dict):
        # If object contains unionId, transform it
        if "unionId" in obj:
            union_id = obj.get("unionId")
            if isinstance(union_id, str):
                username = DingtalkUserMapping.get_username(union_id) or union_id
                result = {"username": username}

                # Copy other fields except unionId
                for key, value in obj.items():
                    if key != "unionId":
                        result[key] = enrich_with_username(value)

                return result

        # Recursively process all fields
        result = {}
        for key, value in obj.items():
            result[key] = enrich_with_username(value)
        return result

    return obj
