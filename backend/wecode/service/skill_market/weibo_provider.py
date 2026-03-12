# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Weibo Skill Market Provider

This module implements the ISkillMarketProvider interface for Weibo's skill market.
It handles all communication with the Weibo MCP skill market service.
"""

import logging
import os
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

import httpx

from app.services.skill_market.provider import (
    DownloadResult,
    ISkillMarketProvider,
    MarketSkill,
    SearchParams,
    SearchResult,
)

logger = logging.getLogger(__name__)

# Skill market base URL - defaults to Weibo MCP service
SKILL_MARKET_BASE_URL = os.environ.get(
    "SKILL_MARKET_BASE_URL", "http://mcp.intra.weibo.com"
)


def get_mcp_token() -> str:
    """
    Get MCP Token for skill market API authentication.
    Reads from environment at runtime to ensure the value is available.
    """
    return os.environ.get("WEIBO_MCP_SYSTEM_TOKEN", "")


class WeiboSkillMarketProvider(ISkillMarketProvider):
    """
    Weibo Skill Market Provider Implementation
    """

    @property
    def name(self) -> str:
        return "微博技能市场"

    @property
    def market_url(self) -> str:
        return f"{SKILL_MARKET_BASE_URL}/pages/skills"

    async def search(self, params: SearchParams) -> SearchResult:
        """
        Search skills in Weibo skill market

        Args:
            params: Search parameters

        Returns:
            Search result with skills list
        """
        mcp_token = get_mcp_token()

        # Build query parameters for the skill market API
        query_params: Dict[str, Any] = {
            "page": params.page,
            "pageSize": params.pageSize,
        }
        if params.keyword:
            query_params["keyword"] = params.keyword
        if params.tags:
            query_params["tags"] = params.tags
        if params.user:
            query_params["user"] = params.user

        url = f"{SKILL_MARKET_BASE_URL}/2/api/skills/list?{urlencode(query_params)}"

        logger.info(
            "[WeiboSkillMarket] Searching skills: url=%s, params=%s, has_mcp_token=%s",
            url,
            params,
            bool(mcp_token),
        )

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {mcp_token}",
                    },
                )
        except httpx.RequestError as e:
            logger.error(
                "[WeiboSkillMarket] Fetch error: url=%s, error=%s",
                url,
                str(e),
            )
            raise RuntimeError(f"Network error while searching skills: {str(e)}")

        if response.status_code != 200:
            error_text = response.text
            logger.error(
                "[WeiboSkillMarket] HTTP error: url=%s, status=%d, error=%s",
                url,
                response.status_code,
                error_text,
            )
            raise RuntimeError(f"HTTP {response.status_code}: {error_text}")

        try:
            data = response.json()
        except Exception as e:
            logger.error(
                "[WeiboSkillMarket] JSON parse error: url=%s, error=%s",
                url,
                str(e),
            )
            raise RuntimeError(f"Failed to parse response: {str(e)}")

        # Check API response code (API returns code 0 or 200 for success)
        response_code = data.get("code")
        if response_code not in (0, 200):
            logger.error(
                "[WeiboSkillMarket] API error: url=%s, code=%s, message=%s",
                url,
                response_code,
                data.get("message"),
            )
            raise RuntimeError(
                f"API error (code: {response_code}): {data.get('message', 'Unknown error')}"
            )

        result_data = data.get("data", {})
        skills_data = result_data.get("skills", [])

        logger.info(
            "[WeiboSkillMarket] Search successful: total=%s, page=%s, skill_count=%d",
            result_data.get("total"),
            result_data.get("page"),
            len(skills_data) if isinstance(skills_data, list) else 0,
        )

        return SearchResult(
            total=int(result_data.get("total", 0)),
            page=int(result_data.get("page", 1)),
            pageSize=int(result_data.get("pageSize", 20)),
            skills=(
                [self._map_skill(skill) for skill in skills_data]
                if isinstance(skills_data, list)
                else []
            ),
        )

    async def download(
        self, skill_key: str, user: Optional[str] = None
    ) -> DownloadResult:
        """
        Download a skill from Weibo skill market

        Args:
            skill_key: Unique skill identifier
            user: Optional user identifier

        Returns:
            Download result with binary content and filename
        """
        mcp_token = get_mcp_token()

        # Build query parameters for the skill market API
        query_params: Dict[str, Any] = {}
        if user:
            query_params["user"] = user

        query_string = f"?{urlencode(query_params)}" if query_params else ""
        url = f"{SKILL_MARKET_BASE_URL}/2/api/skills/{skill_key}/download{query_string}"

        logger.info(
            "[WeiboSkillMarket] Downloading skill: skill_key=%s, url=%s, has_mcp_token=%s",
            skill_key,
            url,
            bool(mcp_token),
        )

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(
                    url,
                    headers={
                        "Accept": "application/octet-stream",
                        "Authorization": f"Bearer {mcp_token}",
                    },
                )
        except httpx.RequestError as e:
            logger.error(
                "[WeiboSkillMarket] Download fetch error: skill_key=%s, url=%s, error=%s",
                skill_key,
                url,
                str(e),
            )
            raise RuntimeError(f"Network error while downloading skill: {str(e)}")

        if response.status_code != 200:
            error_text = response.text
            logger.error(
                "[WeiboSkillMarket] Download HTTP error: skill_key=%s, url=%s, status=%d, error=%s",
                skill_key,
                url,
                response.status_code,
                error_text,
            )
            raise RuntimeError(f"HTTP {response.status_code}: {error_text}")

        logger.info(
            "[WeiboSkillMarket] Download successful: skill_key=%s, content_type=%s, content_length=%s",
            skill_key,
            response.headers.get("content-type"),
            response.headers.get("content-length"),
        )

        content = response.content

        # Extract realSkillKey from skillKey format: {owner}_{parentSkill}_{realSkillKey}
        # parentSkill may not exist, so we take the content after the last underscore
        last_underscore_index = skill_key.rfind("_")
        real_skill_key = (
            skill_key[last_underscore_index + 1 :]
            if last_underscore_index != -1
            else skill_key
        )

        return DownloadResult(
            content=content,
            filename=f"{real_skill_key}.zip",
            content_type="application/octet-stream",
        )

    def _map_skill(self, skill: Dict[str, Any]) -> MarketSkill:
        """
        Map raw skill data to MarketSkill dataclass

        The backend API returns originalSkillKey which is the provider-agnostic
        skill identifier used for installation. If not provided, we fall back
        to extracting it from skillKey format: {owner}_{originalSkillKey}
        """
        skill_key = str(skill.get("skillKey", ""))

        # Use originalSkillKey from API response if available,
        # otherwise extract from skillKey format: {owner}_{originalSkillKey}
        original_skill_key = str(skill.get("originalSkillKey", ""))
        if not original_skill_key and skill_key:
            last_underscore_index = skill_key.rfind("_")
            original_skill_key = (
                skill_key[last_underscore_index + 1 :]
                if last_underscore_index != -1
                else skill_key
            )

        tags = skill.get("tags", [])
        if not isinstance(tags, list):
            tags = []

        # Get hasDownloadPermission from API response, default to True for public skills
        has_download_permission = skill.get("hasDownloadPermission")
        if has_download_permission is None:
            # Default: public skills have permission, private skills don't
            visibility = str(skill.get("visibility", "public"))
            has_download_permission = visibility == "public"
        else:
            has_download_permission = bool(has_download_permission)

        # Generate permission URL with properly encoded skill key
        permission_url = ""
        if skill_key:
            encoded_skill_key = quote(skill_key, safe="")
            permission_url = f"{self.market_url}/{encoded_skill_key}"

        return MarketSkill(
            skillKey=skill_key,
            originalSkillKey=original_skill_key,
            name=str(skill.get("name", "")),
            description=str(skill.get("description", "")),
            author=str(skill.get("author", "")),
            visibility=str(skill.get("visibility", "public")),
            tags=[str(t) for t in tags],
            version=str(skill.get("version", skill.get("currentVersion", ""))),
            downloadCount=int(skill.get("downloadCount", 0)),
            createdAt=str(skill.get("createdAt", skill.get("updatedAt", ""))),
            hasDownloadPermission=has_download_permission,
            permissionUrl=permission_url,
        )


# Singleton instance for easy import
weibo_skill_market_provider = WeiboSkillMarketProvider()
