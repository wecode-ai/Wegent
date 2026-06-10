# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.system_skill_providers.core.registry import (
    SystemSkillProviderRegistry,
    system_skill_provider_registry,
)
from app.services.system_skill_providers.providers.weibo import (
    WeiboSkillMarketProvider,
)

system_skill_provider_registry.register(WeiboSkillMarketProvider())

__all__ = [
    "SystemSkillProviderRegistry",
    "WeiboSkillMarketProvider",
    "system_skill_provider_registry",
]
