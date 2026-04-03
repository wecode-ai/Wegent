# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import httpx
import logging
from typing import Dict, Any, List
from urllib.parse import quote
from app.core.exceptions import ValidationException


# Mapping from git_domain to external API parameter key
_DOMAIN_TO_API_KEY: Dict[str, str] = {
    "git.intra.weibo.com": "gitIntraWeiboCom",
    "git.staff.sina.com.cn": "gitStaffSinaComCn",
    "gitlab.weibo.cn": "gitlabWeiboCn",
}

# Reverse mapping: external API key -> git_domain
_API_KEY_TO_DOMAIN: Dict[str, str] = {v: k for k, v in _DOMAIN_TO_API_KEY.items()}


class SaveGitToken:
    """
    Service for saving real git tokens to external API
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.save_token_api_url = "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/apply"
        self.fetch_token_api_url = "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/get"
        self.auth_header = "Basic L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E="

    def _build_new_tokens(self, git_info: List[Dict[str, Any]]) -> Dict[str, str]:
        """Extract new tokens from git_info and map to API parameter keys."""
        tokens: Dict[str, str] = {}
        for item in git_info:
            if item.get("type") == "gitlab" and item.get("git_token") and item.get("git_token") != "***":
                domain = item.get("git_domain")
                api_key = _DOMAIN_TO_API_KEY.get(domain)
                if api_key:
                    tokens[api_key] = item["git_token"]
                else:
                    self.logger.info("Unknown git domain: %s", domain)
        return tokens

    def _fetch_existing_tokens(self, username: str, client: httpx.Client) -> Dict[str, str]:
        """Fetch existing tokens from external API so they are preserved on save."""
        try:
            response = client.get(
                self.fetch_token_api_url,
                params={"user": username, "cluster": "cn"},
                headers={"Authorization": self.auth_header},
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()

            if data.get("code") != 0 or not data.get("data", {}).get("data"):
                return {}

            git_data = data["data"]["data"]
            existing: Dict[str, str] = {}
            for domain, api_key in _DOMAIN_TO_API_KEY.items():
                token_b64 = git_data.get(domain)
                if token_b64:
                    try:
                        decoded = base64.b64decode(token_b64).decode("utf-8")
                        if decoded:
                            existing[api_key] = decoded
                    except Exception:
                        pass
            return existing
        except Exception as e:
            self.logger.warning("Failed to fetch existing tokens for merge: %s", e)
            return {}

    async def _fetch_existing_tokens_async(self, username: str, client: httpx.AsyncClient) -> Dict[str, str]:
        """Async version of _fetch_existing_tokens."""
        try:
            response = await client.get(
                self.fetch_token_api_url,
                params={"user": username, "cluster": "cn"},
                headers={"Authorization": self.auth_header},
                timeout=10,
            )
            response.raise_for_status()
            data = response.json()

            if data.get("code") != 0 or not data.get("data", {}).get("data"):
                return {}

            git_data = data["data"]["data"]
            existing: Dict[str, str] = {}
            for domain, api_key in _DOMAIN_TO_API_KEY.items():
                token_b64 = git_data.get(domain)
                if token_b64:
                    try:
                        decoded = base64.b64decode(token_b64).decode("utf-8")
                        if decoded:
                            existing[api_key] = decoded
                    except Exception:
                        pass
            return existing
        except Exception as e:
            self.logger.warning("Failed to fetch existing tokens for merge: %s", e)
            return {}

    async def save_gitlab_tokens(self, username: str, email: str, git_info: List[Dict[str, Any]]) -> bool:
        """
        Save real gitlab tokens to external API.
        Merges new tokens with existing ones so previously saved tokens are preserved.
        """
        try:
            new_tokens = self._build_new_tokens(git_info)
            if not new_tokens:
                self.logger.info("No gitlab tokens to save")
                return True

            async with httpx.AsyncClient() as client:
                # Fetch existing tokens and merge (new tokens override existing)
                existing_tokens = await self._fetch_existing_tokens_async(username, client)
                request_data = {**existing_tokens, **new_tokens}

                response = await client.post(
                    self.save_token_api_url,
                    params={
                        "user": username,
                        "email": quote(email)
                    },
                    headers={
                        "Authorization": self.auth_header,
                        "Content-Type": "application/json"
                    },
                    json=request_data,
                    timeout=10
                )
                response.raise_for_status()

                result = response.json()
                if result.get("code") == 0:
                    self.logger.info(f"Successfully saved gitlab tokens for user: {username}")
                    return True
                else:
                    self.logger.error(f"Failed to save gitlab tokens: {result}")
                    return False

        except httpx.RequestError as e:
            self.logger.error(f"Request failed while saving gitlab tokens: {str(e)}")
            return False
        except Exception as e:
            self.logger.error(f"Error saving gitlab tokens: {str(e)}")
            return False

    def replace_tokens_with_placeholders(self, git_info: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Replace real gitlab tokens with placeholders."""
        updated_git_info = []
        for item in git_info:
            new_item = item.copy()
            if new_item.get("type") == "gitlab" and new_item.get("git_token"):
                new_item["git_token"] = "***"
            updated_git_info.append(new_item)
        return updated_git_info

    def save_gitlab_tokens_blocking(self, username: str, email: str, git_info: List[Dict[str, Any]]) -> None:
        """
        Blocking (synchronous) variant that saves real gitlab tokens to external API.
        Merges new tokens with existing ones so previously saved tokens are preserved.
        Raises ValidationException on any failure.
        """
        new_tokens = self._build_new_tokens(git_info)
        if not new_tokens:
            self.logger.info("No gitlab tokens to save")
            return

        try:
            with httpx.Client(timeout=10) as client:
                # Fetch existing tokens and merge (new tokens override existing)
                existing_tokens = self._fetch_existing_tokens(username, client)
                request_data = {**existing_tokens, **new_tokens}

                response = client.post(
                    self.save_token_api_url,
                    params={
                        "user": username,
                        "email": quote(email or "")
                    },
                    headers={
                        "Authorization": self.auth_header,
                        "Content-Type": "application/json"
                    },
                    json=request_data,
                )
                response.raise_for_status()
                result = response.json()
                if result.get("code") == 0:
                    self.logger.info(f"Successfully saved gitlab tokens for user: {username}")
                    return
                else:
                    self.logger.error(f"Failed to save gitlab tokens: {result}")
                    raise ValidationException(detail="Failed to save gitlab tokens")
        except httpx.RequestError as e:
            self.logger.error(f"Request failed while saving gitlab tokens: {str(e)}")
            raise ValidationException(detail="Failed to save gitlab tokens")
        except ValidationException:
            raise
        except Exception as e:
            self.logger.error(f"Error saving gitlab tokens: {str(e)}")
            raise ValidationException(detail="Failed to save gitlab tokens")


# Global instance
save_git_token = SaveGitToken()
