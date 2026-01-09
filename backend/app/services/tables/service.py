"""
DataTable unified service class.
"""

from typing import Dict, Optional

from .base import BaseTableProvider, TableProviderRegistry
from .models import TableContext, TableQueryRequest, TableQueryResponse


class DataTableService:
    """DataTable unified service class."""

    def __init__(self):
        self._provider_instances: Dict[str, BaseTableProvider] = {}

    def _get_provider_instance(self, provider_name: str) -> BaseTableProvider:
        """
        Get or create provider instance (singleton pattern).

        Args:
            provider_name: Provider name

        Returns:
            Provider instance

        Raises:
            ValueError: If provider does not exist
        """
        if provider_name not in self._provider_instances:
            provider_class = TableProviderRegistry.get_provider(provider_name)
            if not provider_class:
                raise ValueError(f"Unknown provider: {provider_name}")
            self._provider_instances[provider_name] = provider_class()
        return self._provider_instances[provider_name]

    async def query_table(self, request: TableQueryRequest) -> TableQueryResponse:
        """
        Query table data.

        Args:
            request: Table query request

        Returns:
            TableQueryResponse object
        """
        provider = self._get_provider_instance(request.provider)
        return await provider.list_records(
            base_id=request.base_id,
            sheet_id_or_name=request.sheet_id_or_name,
            user_name=request.user_name,
            max_records=request.max_records,
            filters=request.filters,
        )

    async def validate_url(
        self, url: str, provider_name: str, user_name: Optional[str] = None
    ) -> bool:
        """
        Validate table URL and check permissions.

        Args:
            url: Table URL
            provider_name: Provider name
            user_name: Username

        Returns:
            True if URL is valid and user has access, False otherwise
        """
        provider = self._get_provider_instance(provider_name)

        # Parse URL
        context = provider.parse_url(url)
        if not context:
            return False

        # Validate access permissions
        return await provider.validate_access(
            base_id=context.base_id,
            sheet_id_or_name=context.sheet_id_or_name,
            user_name=user_name,
        )

    def parse_url(self, url: str, provider_name: str) -> Optional[TableContext]:
        """
        Parse table URL.

        Args:
            url: Table URL
            provider_name: Provider name

        Returns:
            TableContext object, or None if URL is invalid
        """
        provider = self._get_provider_instance(provider_name)
        return provider.parse_url(url)
