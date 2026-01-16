"""
DataTable Service abstract base class and Provider registry.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Type

from .models import TableContext, TableQueryResponse


class BaseTableProvider(ABC):
    """Table Provider abstract base class."""

    @abstractmethod
    def parse_url(self, url: str) -> Optional[TableContext]:
        """
        Parse table URL.

        Args:
            url: Table URL

        Returns:
            TableContext object, or None if URL is invalid
        """
        pass

    @abstractmethod
    async def list_records(
        self,
        base_id: str,
        sheet_id_or_name: str,
        user_name: Optional[str] = None,
        max_records: int = 100,
        filters: Optional[Dict[str, Any]] = None,
    ) -> TableQueryResponse:
        """
        Query table data.

        Args:
            base_id: Table base ID
            sheet_id_or_name: Sheet ID or name
            user_name: Username for access control
            max_records: Maximum number of records to return
            filters: Query filter conditions

        Returns:
            TableQueryResponse object containing schema and records
        """
        pass

    @abstractmethod
    async def validate_access(
        self,
        base_id: str,
        sheet_id_or_name: str,
        user_name: Optional[str] = None,
    ) -> bool:
        """
        Validate if user has access permissions.

        Args:
            base_id: Table base ID
            sheet_id_or_name: Sheet ID or name
            user_name: Username

        Returns:
            True if user has access, False otherwise
        """
        pass


class TableProviderRegistry:
    """Provider registry."""

    _providers: Dict[str, Type[BaseTableProvider]] = {}

    @classmethod
    def register(cls, provider_name: str):
        """
        Decorator: Register a provider.

        Usage:
            @TableProviderRegistry.register("dingtalk")
            class DingTalkProvider(BaseTableProvider):
                ...
        """

        def decorator(provider_class: Type[BaseTableProvider]):
            cls._providers[provider_name] = provider_class
            return provider_class

        return decorator

    @classmethod
    def get_provider(cls, provider_name: str) -> Optional[Type[BaseTableProvider]]:
        """
        Get provider class.

        Args:
            provider_name: Provider name, e.g. 'dingtalk'

        Returns:
            Provider class, or None if not found
        """
        return cls._providers.get(provider_name)

    @classmethod
    def list_providers(cls) -> List[str]:
        """
        List all registered providers.

        Returns:
            List of provider names
        """
        return list(cls._providers.keys())
