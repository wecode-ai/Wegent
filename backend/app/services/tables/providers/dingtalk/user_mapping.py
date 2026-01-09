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

from .client import DingtalkNotableClient, DingtalkTokenManager

logger = logging.getLogger(__name__)


class DingtalkUserMapping:
    """User mapping service.

    Loads and caches unionId -> username mappings from a DingTalk Notable table.
    Supports automatic refresh of mappings.
    """

    def __init__(
        self,
        token_manager: DingtalkTokenManager,
        base_id: str,
        sheet_id: str,
        operator_id: str,
        refresh_interval: int = 300,  # 5 minutes
    ):
        """Initialize user mapping service.

        Args:
            token_manager: Token manager for API access
            base_id: Base ID containing user mapping table
            sheet_id: Sheet ID of user mapping table
            operator_id: Operator user ID for API calls
            refresh_interval: Auto-refresh interval in seconds (default 300)
        """
        self.token_manager = token_manager
        self.base_id = base_id
        self.sheet_id = sheet_id
        self.operator_id = operator_id
        self.refresh_interval = refresh_interval

        self._cache: Dict[str, str] = {}  # unionId -> username
        self._reverse_cache: Dict[str, str] = {}  # username -> unionId
        self._initialized: bool = False
        self._last_refresh_time: Optional[datetime] = None
        self._lock = asyncio.Lock()
        self._refresh_task: Optional[asyncio.Task] = None

    async def initialize(self) -> None:
        """Initialize user mapping cache from DingTalk table."""
        async with self._lock:
            logger.info("[DingtalkUserMapping] Initializing user mapping cache...")
            logger.info(f"[DingtalkUserMapping] Base ID: {self.base_id}")
            logger.info(f"[DingtalkUserMapping] Sheet ID: {self.sheet_id}")

            client = DingtalkNotableClient(
                token_manager=self.token_manager,
                operator_id=self.operator_id,
            )

            # Clear existing cache
            self._cache.clear()
            self._reverse_cache.clear()

            total_records = 0
            next_token = None

            # Paginate through all records
            while True:
                response = await client.list_records(
                    base_id=self.base_id,
                    sheet_id_or_name=self.sheet_id,
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
                    email = fields.get("邮箱")
                    persons = fields.get("人员", [])

                    # Extract unionId and username mapping
                    if email and persons and len(persons) > 0:
                        union_id = persons[0].get("unionId")
                        if union_id:
                            # Store full email in forward cache
                            self._cache[union_id] = email

                            # Store both email and username (before @) in reverse cache
                            self._reverse_cache[email] = union_id
                            if "@" in email:
                                username = email.split("@")[0]
                                self._reverse_cache[username] = union_id

                            total_records += 1

                # Check if there are more pages
                has_more = result.get("hasMore", False)
                next_token = result.get("nextToken")

                if not has_more or not next_token:
                    break

            self._initialized = True
            self._last_refresh_time = datetime.now()

            logger.info(
                f"[DingtalkUserMapping] Initialization complete, "
                f"loaded {total_records} mappings"
            )

            # Start background refresh task if not already running
            if self._refresh_task is None or self._refresh_task.done():
                self._refresh_task = asyncio.create_task(self._auto_refresh_loop())
                logger.info(
                    f"[DingtalkUserMapping] Started auto-refresh task "
                    f"(interval: {self.refresh_interval}s)"
                )

    async def _auto_refresh_loop(self) -> None:
        """Background task to auto-refresh user mapping cache."""
        while True:
            try:
                await asyncio.sleep(self.refresh_interval)
                logger.info(
                    "[DingtalkUserMapping] Auto-refresh triggered, "
                    "reloading user mappings..."
                )

                # Reload mappings without restarting the refresh task
                async with self._lock:
                    client = DingtalkNotableClient(
                        token_manager=self.token_manager,
                        operator_id=self.operator_id,
                    )

                    # Clear existing cache
                    self._cache.clear()
                    self._reverse_cache.clear()

                    total_records = 0
                    next_token = None

                    # Paginate through all records
                    while True:
                        response = await client.list_records(
                            base_id=self.base_id,
                            sheet_id_or_name=self.sheet_id,
                            page_size=100,
                            next_token=next_token,
                        )

                        if not response.get("success"):
                            error_msg = response.get("errorMsg", "Unknown error")
                            error_code = response.get("errorCode", "UNKNOWN")
                            logger.error(
                                f"[DingtalkUserMapping] Auto-refresh failed: "
                                f"{error_msg} (code: {error_code})"
                            )
                            break

                        result = response.get("result", {})
                        records = result.get("records", [])

                        # Process each record
                        for record in records:
                            fields = record.get("fields", {})
                            email = fields.get("邮箱")
                            persons = fields.get("人员", [])

                            # Extract unionId and username mapping
                            if email and persons and len(persons) > 0:
                                union_id = persons[0].get("unionId")
                                if union_id:
                                    # Store full email in forward cache
                                    self._cache[union_id] = email

                                    # Store both email and username (before @) in reverse cache
                                    self._reverse_cache[email] = union_id
                                    if "@" in email:
                                        username = email.split("@")[0]
                                        self._reverse_cache[username] = union_id

                                    total_records += 1

                        # Check if there are more pages
                        has_more = result.get("hasMore", False)
                        next_token = result.get("nextToken")

                        if not has_more or not next_token:
                            break

                    self._last_refresh_time = datetime.now()

                logger.info(
                    f"[DingtalkUserMapping] Auto-refresh completed, "
                    f"loaded {total_records} mappings"
                )

            except asyncio.CancelledError:
                logger.info("[DingtalkUserMapping] Auto-refresh task cancelled")
                break
            except Exception as e:
                logger.error(
                    f"[DingtalkUserMapping] Error in auto-refresh: {e}", exc_info=True
                )
                # Continue the loop even if refresh fails

    def get_username(self, union_id: str) -> Optional[str]:
        """Get username by unionId.

        Args:
            union_id: User's unionId

        Returns:
            Username if found, None otherwise
        """
        return self._cache.get(union_id)

    async def get_dingtalk_id(self, username: str) -> Optional[str]:
        """Get dingtalk_id (unionId) by username.

        Args:
            username: User's username (email or username part before @)

        Returns:
            DingTalk unionId if found, None otherwise
        """
        return self._reverse_cache.get(username)

    def get_all_mappings(self) -> Dict[str, str]:
        """Get all mappings.

        Returns:
            Copy of unionId -> username mapping dict
        """
        return self._cache.copy()

    def size(self) -> int:
        """Get cache size.

        Returns:
            Number of mappings in cache
        """
        return len(self._cache)

    def is_initialized(self) -> bool:
        """Check if cache is initialized.

        Returns:
            True if initialized, False otherwise
        """
        return self._initialized

    def get_last_refresh_time(self) -> Optional[datetime]:
        """Get last refresh time.

        Returns:
            Last refresh datetime, None if not initialized
        """
        return self._last_refresh_time

    async def refresh(self) -> None:
        """Manually refresh cache."""
        logger.info("[DingtalkUserMapping] Manual cache refresh requested")
        await self.initialize()

    def stop_auto_refresh(self) -> None:
        """Stop the auto-refresh background task."""
        if self._refresh_task and not self._refresh_task.done():
            self._refresh_task.cancel()
            logger.info("[DingtalkUserMapping] Auto-refresh task stopped")

    async def enrich_with_username(self, obj: Any) -> Any:
        """Recursively transform unionId to username in objects.

        Traverses nested structures and replaces objects containing unionId
        with a username field (using cached mapping if available).

        Args:
            obj: Object to transform (can be dict, list, or primitive)

        Returns:
            Transformed object with unionId replaced by username
        """
        if isinstance(obj, list):
            return [await self.enrich_with_username(item) for item in obj]

        if isinstance(obj, dict):
            # If object contains unionId, transform it
            if "unionId" in obj:
                union_id = obj.get("unionId")
                if isinstance(union_id, str):
                    username = self.get_username(union_id) or union_id
                    result = {"username": username}

                    # Copy other fields except unionId
                    for key, value in obj.items():
                        if key != "unionId":
                            result[key] = await self.enrich_with_username(value)

                    return result

            # Recursively process all fields
            result = {}
            for key, value in obj.items():
                result[key] = await self.enrich_with_username(value)
            return result

        return obj
