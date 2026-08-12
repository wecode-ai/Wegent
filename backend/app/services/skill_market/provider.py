# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Market Provider Interface and Registry

This module defines the abstract interface for skill market providers
and provides a registry mechanism for dynamic provider registration.
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class SearchParams:
    """Search parameters for skill market"""

    # Keyword search
    keyword: Optional[str] = None
    # Tag filter
    tags: Optional[str] = None
    # Page number
    page: int = 1
    # Page size
    pageSize: int = 20
    # User making the request
    user: Optional[str] = None


@dataclass
class MarketSkill:
    """Skill information from market"""

    # Unique skill identifier (provider-specific format)
    skillKey: str
    # Original skill key for installation (provider-agnostic)
    originalSkillKey: str
    # Skill name
    name: str
    # Skill description
    description: str
    # Author name
    author: str
    # Visibility (public/private)
    visibility: str
    # Tags
    tags: List[str] = field(default_factory=list)
    # Version
    version: str = ""
    # Download count
    downloadCount: int = 0
    # Creation time
    createdAt: str = ""
    # Whether the current user has download permission
    hasDownloadPermission: bool = True
    # URL for requesting permission or viewing skill details (provider-generated)
    permissionUrl: str = ""


@dataclass
class SearchResult:
    """Search result from skill market"""

    # Total number of skills
    total: int
    # Current page
    page: int
    # Page size
    pageSize: int
    # List of skills
    skills: List[MarketSkill] = field(default_factory=list)


@dataclass
class DownloadResult:
    """Download result from skill market"""

    # Skill file binary content
    content: bytes
    # Suggested filename
    filename: str
    # Content type
    content_type: str = "application/octet-stream"


class ISkillMarketProvider(ABC):
    """
    Skill Market Provider Interface

    Implement this interface to create a new skill market provider.
    The provider should handle all communication with the external skill market service.
    """

    @property
    @abstractmethod
    def key(self) -> str:
        """Stable provider identifier used by API clients"""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for display"""
        pass

    @property
    @abstractmethod
    def market_url(self) -> str:
        """Market URL for navigation"""
        pass

    @abstractmethod
    async def search(self, params: SearchParams) -> SearchResult:
        """
        Search skills in the market

        Args:
            params: Search parameters

        Returns:
            Search result with skills list
        """
        pass

    @abstractmethod
    async def download(
        self, skill_key: str, user: Optional[str] = None
    ) -> DownloadResult:
        """
        Download a skill from the market

        Args:
            skill_key: Unique skill identifier
            user: Optional user identifier

        Returns:
            Download result with binary content and filename
        """
        pass


class SkillMarketProviderRegistry:
    """
    Skill Market Provider Registry

    Manages registered skill market providers by stable provider key.
    """

    def __init__(self) -> None:
        self._providers: Dict[str, ISkillMarketProvider] = {}

    def register(self, provider: ISkillMarketProvider) -> None:
        """
        Register a skill market provider.
        A provider with the same key is replaced.

        Args:
            provider: The provider to register
        """
        logger.info(
            "[SkillMarketRegistry] Registering provider: key=%s name=%s",
            provider.key,
            provider.name,
        )
        self._providers[provider.key] = provider

    def get_provider(self, provider_key: str) -> Optional[ISkillMarketProvider]:
        """
        Get the registered provider.

        Returns:
            The registered provider or None if the key is unknown
        """
        return self._providers.get(provider_key)

    def list_providers(self) -> List[ISkillMarketProvider]:
        """Return providers in registration order."""
        return list(self._providers.values())

    def has_provider(self, provider_key: Optional[str] = None) -> bool:
        """
        Check if a provider is registered.

        Returns:
            True if a provider is registered
        """
        if provider_key is not None:
            return provider_key in self._providers
        return bool(self._providers)

    def get_single_provider(self) -> Optional[ISkillMarketProvider]:
        """Return the only registered provider for legacy callers."""
        if len(self._providers) != 1:
            return None
        return next(iter(self._providers.values()))

    def count(self) -> int:
        """Return the number of registered providers."""
        return len(self._providers)

    def clear(self) -> None:
        """Clear the registered provider"""
        self._providers.clear()


# Singleton instance
skill_market_registry = SkillMarketProviderRegistry()
