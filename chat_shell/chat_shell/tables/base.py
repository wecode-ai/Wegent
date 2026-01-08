# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base classes for table services.

This module provides:
- TableContext: Parsed table context from URL
- BaseTableProvider: Abstract base class for URL parsing (provider-specific)
- TableProviderRegistry: Registry for table providers
- DataTableService: Abstract interface for querying table data
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Optional, Type

logger = logging.getLogger(__name__)


@dataclass
class TableContext:
    """Parsed table context from URL."""

    base_id: str
    sheet_id_or_name: str

    def to_dict(self) -> Dict[str, str]:
        """Convert to dictionary for prompt injection."""
        return {
            "baseId": self.base_id,
            "sheetIdOrName": self.sheet_id_or_name,
        }


class BaseTableProvider(ABC):
    """Abstract base class for table providers.

    Each table platform (DingTalk, Feishu, etc.) should implement this class
    to provide:
    1. URL parsing (extract base_id and sheet_id from URL)
    2. Data querying (list_records method)
    """

    # Provider type identifier (e.g., "dingtalk", "feishu")
    provider_type: ClassVar[str]

    # URL patterns for detecting this provider
    url_patterns: ClassVar[List[str]]

    @classmethod
    @abstractmethod
    def parse_url(cls, url: str) -> Optional[TableContext]:
        """Parse table URL to extract base_id and sheet_id.

        Args:
            url: Table URL to parse

        Returns:
            TableContext if successful, None if URL format is invalid
        """
        pass

    @classmethod
    def matches_url(cls, url: str) -> bool:
        """Check if URL matches this provider's patterns.

        Args:
            url: URL to check

        Returns:
            True if URL matches this provider
        """
        return any(pattern in url for pattern in cls.url_patterns)

    @abstractmethod
    async def list_records(
        self,
        base_id: str,
        sheet_id_or_name: str,
        max_records: int = 100,
        user_id: int = 0,
    ) -> Dict[str, Any]:
        """Query records from a table.

        Args:
            base_id: The base ID of the table
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
        pass


class TableProviderRegistry:
    """Registry for table providers.

    This class manages all registered table providers and provides
    methods to detect and retrieve providers based on URLs.
    """

    _providers: Dict[str, Type[BaseTableProvider]] = {}

    @classmethod
    def register(
        cls, provider_class: Type[BaseTableProvider]
    ) -> Type[BaseTableProvider]:
        """Register a table provider.

        Can be used as a decorator:
            @TableProviderRegistry.register
            class MyProvider(BaseTableProvider):
                ...

        Args:
            provider_class: Provider class to register

        Returns:
            The provider class (for decorator usage)
        """
        cls._providers[provider_class.provider_type] = provider_class
        logger.info(f"Registered table provider: {provider_class.provider_type}")
        return provider_class

    @classmethod
    def get_provider(cls, provider_type: str) -> Optional[Type[BaseTableProvider]]:
        """Get a provider by type.

        Args:
            provider_type: Provider type identifier

        Returns:
            Provider class if found, None otherwise
        """
        return cls._providers.get(provider_type)

    @classmethod
    def detect_provider_from_url(cls, url: str) -> Optional[str]:
        """Detect provider type from URL.

        Args:
            url: Table URL to analyze

        Returns:
            Provider type if detected, None otherwise
        """
        for provider_type, provider_class in cls._providers.items():
            if provider_class.matches_url(url):
                return provider_type
        return None

    @classmethod
    def get_provider_for_url(cls, url: str) -> Optional[Type[BaseTableProvider]]:
        """Get provider class for a URL.

        Args:
            url: Table URL to analyze

        Returns:
            Provider class if detected, None otherwise
        """
        provider_type = cls.detect_provider_from_url(url)
        if provider_type:
            return cls.get_provider(provider_type)
        return None

    @classmethod
    def parse_url(cls, url: str) -> Optional[TableContext]:
        """Parse URL using the appropriate provider.

        Args:
            url: Table URL to parse

        Returns:
            TableContext if successful, None otherwise
        """
        provider = cls.get_provider_for_url(url)
        if provider:
            return provider.parse_url(url)
        return None

    @classmethod
    def get_all_providers(cls) -> Dict[str, Type[BaseTableProvider]]:
        """Get all registered providers.

        Returns:
            Dictionary of provider_type -> provider_class
        """
        return cls._providers.copy()
