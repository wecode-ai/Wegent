# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import logging
from typing import Optional, Dict, Any

import httpx


class TokenResolver:
    """
    Resolve real git token without importing app.* to avoid circular imports.
    This module directly calls external API.
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)
        self.git_token_api_url = "http://preview.paas.intra.weibo.com/2/appnest/api/code-server-new/secret/get"
        self.git_token_auth = "Basic L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E="
        # 支持的域名键
        self.target_keys = [
            "git.intra.weibo.com",
            "git.staff.sina.com.cn",
            "gitlab.weibo.cn",
            "gitlab.com",
        ]

    async def resolve_git_token(
        self,
        username: str,
        git_domain: str,
        fallback_token: Optional[str] = None,
        cluster: str = "cn",
    ) -> str:
        """
        Return a usable git token for given domain:
        - If fallback_token is present and not '***', return it
        - Otherwise fetch from external API and decode
        """
        if fallback_token and fallback_token != "***":
            return fallback_token

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    self.git_token_api_url,
                    params={"user": username, "cluster": cluster},
                    headers={"Authorization": self.git_token_auth},
                    timeout=10,
                )
                resp.raise_for_status()
                data: Dict[str, Any] = resp.json()

            if data.get("code") != 0 or not data.get("data", {}).get("data"):
                self.logger.warning("TokenResolver: API返回数据格式无效")
                return ""

            git_data = data["data"]["data"]

            # 直接按入参域名取值
            token_b64: Optional[str] = git_data.get(git_domain)
            if not token_b64 and git_domain not in self.target_keys:
                # 兼容非预置域名的情况，例如子域名；外部系统通常以域名作为键
                token_b64 = git_data.get(git_domain)

            if not token_b64:
                return ""

            try:
                decoded = base64.b64decode(token_b64).decode("utf-8")
                return decoded or ""
            except Exception as e:
                self.logger.error(f"TokenResolver: base64解码失败 domain={git_domain}, err={e}")
                return ""
        except httpx.RequestError as e:
            self.logger.error(f"TokenResolver: 外部接口请求失败 {e}")
            return ""
        except Exception as e:
            self.logger.error(f"TokenResolver: 解析token失败 {e}")
            return ""


# Global instance
token_resolver = TokenResolver()