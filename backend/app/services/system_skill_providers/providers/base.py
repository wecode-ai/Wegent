# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

from app.schemas.system_skills import SystemSkillCatalogItem


@dataclass(frozen=True)
class SystemSkillProviderConfig:
    """Internal provider metadata for registry and service usage."""

    key: str
    name: str
    description: str
    requires_token: bool = False
    priority: int = 100


@dataclass
class SystemSkillProviderResult:
    """Provider result before service-level install-state merging."""

    total: int
    page: int
    page_size: int
    items: List[SystemSkillCatalogItem] = field(default_factory=list)


class SystemSkillProvider(ABC):
    """Base interface for system skill catalog providers."""

    @abstractmethod
    def get_config(self) -> SystemSkillProviderConfig:
        """Return provider metadata."""

    @abstractmethod
    async def fetch_skills(
        self,
        *,
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
        token: Optional[str] = None,
        user_name: Optional[str] = None,
    ) -> SystemSkillProviderResult:
        """Fetch normalized skills from this provider."""

    async def download_skill(
        self,
        *,
        source_skill_key: str,
        version: Optional[str] = None,
    ) -> bytes:
        """Download a skill package from this provider."""
        raise NotImplementedError("Provider does not support skill download")
