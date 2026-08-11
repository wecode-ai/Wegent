# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
from typing import Any, List, Optional

import httpx

from app.schemas.system_skills import SystemSkillCatalogItem
from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
    SystemSkillProviderResult,
)

SKILL_HUB_BASE_URL_ENV = "SKILL_HUB_BASE_URL"
MCP_TOKEN_ENV = "MCP_TOKEN"
WEGENT_SKILL_IDENTITY_TOKEN_ENV = "WEGENT_SKILL_IDENTITY_TOKEN"
WEIBO_SKILL_MARKET_BASE_URL_ENV = "WEIBO_SKILL_MARKET_BASE_URL"
WEIBO_SKILL_MARKET_TOKEN_ENV = "WEIBO_SKILL_MARKET_TOKEN"
DEFAULT_SKILL_HUB_BASE_URL = "http://mcp.intra.weibo.com"
WEIBO_SKILL_MARKET_TIMEOUT_SECONDS = 10.0


class WeiboSkillMarketError(Exception):
    """Error returned while communicating with Weibo SkillHub."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class WeiboSkillMarketProvider(SystemSkillProvider):
    """System skill provider backed by Weibo SkillHub."""

    def get_config(self) -> SystemSkillProviderConfig:
        return SystemSkillProviderConfig(
            key="weibo",
            name="Weibo Skill Market",
            description="Skills from Weibo SkillHub",
            requires_token=False,
            priority=20,
        )

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
        del user_name
        payload = await self._fetch_skill_list(
            base_url=self._get_base_url(),
            token=token or self._get_token(),
            keyword=keyword,
            tags=tags,
            page=page,
            page_size=page_size,
        )
        skills = payload.get("skills", [])
        if not isinstance(skills, list):
            raise WeiboSkillMarketError("mapping_error", "Provider skills is invalid")

        items = [self._map_skill(skill) for skill in skills if isinstance(skill, dict)]
        return SystemSkillProviderResult(
            total=int(payload.get("total", len(items))),
            page=int(payload.get("page", page)),
            page_size=int(payload.get("pageSize", page_size)),
            items=items,
        )

    async def download_skill(
        self,
        *,
        source_skill_key: str,
        version: Optional[str] = None,
    ) -> bytes:
        path = f"/2/api/skills/{source_skill_key}/download"
        if version:
            path = f"{path}/{version}"

        async with httpx.AsyncClient(
            timeout=WEIBO_SKILL_MARKET_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(
                f"{self._get_base_url().rstrip('/')}{path}",
                headers={"Authorization": f"Bearer {self._get_token()}"},
            )
            response.raise_for_status()

        return response.content

    def _get_base_url(self) -> str:
        return (
            os.environ.get(SKILL_HUB_BASE_URL_ENV)
            or os.environ.get(WEIBO_SKILL_MARKET_BASE_URL_ENV)
            or DEFAULT_SKILL_HUB_BASE_URL
        ).strip()

    def _get_token(self) -> str:
        token = (
            os.environ.get(MCP_TOKEN_ENV)
            or os.environ.get(WEGENT_SKILL_IDENTITY_TOKEN_ENV)
            or os.environ.get(WEIBO_SKILL_MARKET_TOKEN_ENV)
            or ""
        ).strip()
        if not token:
            raise WeiboSkillMarketError(
                "token_required", "SkillHub token is not configured"
            )
        return token

    async def _fetch_skill_list(
        self,
        *,
        base_url: str,
        token: str,
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        params: dict[str, str | int] = {"page": page, "pageSize": page_size}
        if keyword:
            params["keyword"] = keyword
        if tags:
            params["tags"] = ",".join(tag for tag in tags if tag)

        async with httpx.AsyncClient(
            timeout=WEIBO_SKILL_MARKET_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(
                f"{base_url.rstrip('/')}/2/api/skills/list",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()

        body = response.json()
        if not isinstance(body, dict):
            raise WeiboSkillMarketError("mapping_error", "Provider body is invalid")
        if body.get("code") != 0:
            code = "unauthorized" if body.get("code") == 401 else "provider_error"
            raise WeiboSkillMarketError(code, body.get("message") or "Provider error")

        data = body.get("data", {})
        if not isinstance(data, dict):
            raise WeiboSkillMarketError("mapping_error", "Provider data is invalid")
        return data

    def _map_skill(self, skill: dict[str, Any]) -> SystemSkillCatalogItem:
        skill_key = str(skill.get("skillKey") or skill.get("originalSkillKey") or "")
        original_key = str(skill.get("originalSkillKey") or skill_key)
        name = str(skill.get("name") or original_key or skill_key)
        tags = skill.get("tags") if isinstance(skill.get("tags"), list) else []

        return SystemSkillCatalogItem(
            id=f"@weibo/{skill_key}",
            providerKey="weibo",
            providerName="Weibo Skill Market",
            name=original_key,
            displayName=name,
            description=str(skill.get("description") or ""),
            iconUrl=None,
            tags=[str(tag) for tag in tags],
            version=self._optional_string(skill.get("currentVersion")),
            author=self._optional_string(skill.get("author")),
            category="system",
            capabilities=[],
            detailUrl=None,
            requiresPermission=skill.get("hasDownloadPermission") is False,
            updatedAt=skill.get("updatedAt"),
        )

    @staticmethod
    def _optional_string(value: Any) -> Optional[str]:
        if value is None:
            return None
        return str(value)
