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
from typing import List, Optional

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
    async def download(self, skill_key: str, user: Optional[str] = None) -> DownloadResult:
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

    Manages the registered skill market provider.
    Only one provider can be active at a time.
    If multiple providers are registered, the last one wins.
    """

    def __init__(self):
        self._provider: Optional[ISkillMarketProvider] = None

    def register(self, provider: ISkillMarketProvider) -> None:
        """
        Register a skill market provider.
        If a provider is already registered, it will be replaced.

        Args:
            provider: The provider to register
        """
        logger.info(f"[SkillMarketRegistry] Registering provider: {provider.name}")
        self._provider = provider

    def get_provider(self) -> Optional[ISkillMarketProvider]:
        """
        Get the registered provider.

        Returns:
            The registered provider or None if none
        """
        return self._provider

    def has_provider(self) -> bool:
        """
        Check if a provider is registered.

        Returns:
            True if a provider is registered
        """
        return self._provider is not None

    def clear(self) -> None:
        """Clear the registered provider"""
        self._provider = None


# Singleton instance
skill_market_registry = SkillMarketProviderRegistry()
