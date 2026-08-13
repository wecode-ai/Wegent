# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from wecode.service.system_skill_providers.weibo import (
    WeiboSkillMarketProvider,
)

weibo_system_skill_provider = WeiboSkillMarketProvider()

__all__ = [
    "WeiboSkillMarketProvider",
    "weibo_system_skill_provider",
]
