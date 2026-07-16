# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict, List, Optional

from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
)


class SystemSkillProviderRegistry:
    """Registry for system skill catalog providers."""

    def __init__(self) -> None:
        self._providers: Dict[str, SystemSkillProvider] = {}

    def register(self, provider: SystemSkillProvider) -> None:
        """Register or replace a provider by its key."""
        config = provider.get_config()
        self._providers[config.key] = provider

    def get(self, key: str) -> Optional[SystemSkillProvider]:
        """Get a provider instance by key."""
        return self._providers.get(key)

    def list_all(self) -> List[SystemSkillProviderConfig]:
        """List registered providers sorted by priority, then display name."""
        configs = [provider.get_config() for provider in self._providers.values()]
        return sorted(configs, key=lambda item: (item.priority, item.name))

    def providers(self) -> List[SystemSkillProvider]:
        """List registered provider instances in registry sort order."""
        return [
            self._providers[config.key]
            for config in self.list_all()
            if config.key in self._providers
        ]


system_skill_provider_registry = SystemSkillProviderRegistry()
