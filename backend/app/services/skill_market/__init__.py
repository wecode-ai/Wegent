# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Market Service Module

This module provides the skill market provider interface and registry
for managing external skill market integrations.
"""

from app.services.skill_market.provider import (
    DownloadResult,
    ISkillMarketProvider,
    MarketSkill,
    SearchParams,
    SearchResult,
    skill_market_registry,
)

__all__ = [
    "DownloadResult",
    "ISkillMarketProvider",
    "MarketSkill",
    "SearchParams",
    "SearchResult",
    "skill_market_registry",
]
