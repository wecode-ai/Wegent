# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Dict, Optional

import jwt  # PyJWT
import requests
from shared.logger import setup_logger

from executor_manager.config import config

logger = setup_logger(__name__)


class GitHubApp:
    """
    GitHub App class for handling authentication and installation token management
    """

    def __init__(
        self,
        app_id: str = None,
        private_key_path: str = None,
        private_key_content: Optional[str] = None,
        jwt_expiration: int = 600,  # 10 minutes
    ):
        self.app_id = app_id or config.GITHUB_APP_ID
        self.private_key_path = private_key_path or config.GITHUB_PRIVATE_KEY_PATH
        self.private_key_content = private_key_content or config.GITHUB_PRIVATE_KEY
        self.jwt_expiration = jwt_expiration

        if not self.app_id:
            raise ValueError("GitHub App ID is required")
        if not self.private_key_path and not self.private_key_content:
            raise ValueError("Either private key path or content is required")

        self._private_key: Optional[str] = None
        self._jwt_token: Optional[str] = None
        self._jwt_expiry: Optional[datetime] = None

    @property
    def private_key(self) -> str:
        if not self._private_key:
            if self.private_key_content:
                self._private_key = self.private_key_content
            elif self.private_key_path:
                with open(self.private_key_path, "r") as f:
                    self._private_key = f.read()
            else:
                raise ValueError("No private key available")
        return self._private_key

    def get_jwt(self) -> str:
        """
        Get a cached JWT token or generate a new one if expired
        """
        now = datetime.now()
        if (
            not self._jwt_token
            or not self._jwt_expiry
            or now >= self._jwt_expiry - timedelta(minutes=1)
        ):
            timestamp = int(time.time())
            payload = {
                "iat": timestamp,
                "exp": timestamp + self.jwt_expiration,
                "iss": self.app_id,
            }
            self._jwt_token = jwt.encode(payload, self.private_key, algorithm="RS256")
            self._jwt_expiry = now + timedelta(seconds=self.jwt_expiration)
        return self._jwt_token

    def _request(self, method: str, url: str, **kwargs) -> Optional[Dict[str, Any]]:
        headers = kwargs.pop("headers", {})
        headers.update(
            {
                "Authorization": f"Bearer {self.get_jwt()}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        )
        try:
            response = requests.request(method, url, headers=headers, **kwargs)
            if response.status_code in (200, 201):
                return response.json()
            logger.error(
                f"GitHub API request failed {response.status_code}: {response.text}"
            )
        except Exception as e:
            logger.exception(f"GitHub API request exception: {e}")
        return None

    def get_repository_installation_id(self, full_name: str) -> Optional[str]:
        url = f"https://api.github.com/repos/{full_name}/installation"
        data = self._request("GET", url)
        if data and "id" in data:
            return str(data["id"])
        return None

    def get_installation_token(self, installation_id: str) -> Optional[Dict[str, Any]]:
        url = (
            f"https://api.github.com/app/installations/{installation_id}/access_tokens"
        )
        return self._request("POST", url)

    def get_repository_token(self, full_name: str) -> Dict[str, Any]:
        """
        Get installation access token with repository permissions for a specific repo
        """
        installation_id = self.get_repository_installation_id(full_name)
        if not installation_id:
            raise ValueError(
                f"No GitHub App installation found for repository {full_name}"
            )

        token_data = self.get_installation_token(installation_id)
        if not token_data or "token" not in token_data:
            raise RuntimeError(
                f"Failed to retrieve installation token for {full_name}"
            )

        return {
            "token": token_data["token"],
            "expires_at": token_data.get("expires_at"),
            "permissions": token_data.get("permissions", {}),
            "repository_selection": token_data.get("repository_selection"),
        }


@lru_cache(maxsize=1)
def get_github_app() -> GitHubApp:
    return GitHubApp(
        app_id=config.GITHUB_APP_ID,
        private_key_path=config.GITHUB_PRIVATE_KEY_PATH
    )

